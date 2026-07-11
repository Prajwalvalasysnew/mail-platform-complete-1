// Customer-aware DKIM signing.
//
// Looks up the DKIM private key for the message's customer + from-domain and
// signs the outgoing message using Nodemailer's maintained DKIM
// implementation) rather than hand-rolled canonicalization.
//
// SAFETY: signing is treated as mandatory. If we cannot sign (no key, DB down,
// signer error) we DENYSOFT the message so Haraka retries later, rather than
// delivering unsigned mail — an unsigned or mis-signed message hurts
// deliverability and is hard to diagnose downstream. Set
// DKIM_REQUIRED=false only for local development to fall back to next().

const { Pool } = require('pg');
const crypto = require('crypto');
const DKIM = require('nodemailer/lib/dkim');

let pool;

const DKIM_REQUIRED = process.env.DKIM_REQUIRED !== 'false';

// AES-256-GCM decryption matching packages/shared/src/encryption.ts
function decryptSecret(stored) {
  if (!stored || !stored.startsWith('v1:')) return stored; // legacy plaintext
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY not set');
  let key;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes');
  const [, ivB64, tagB64, ctB64] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function dkimSign(message, { signingDomain, selector, privateKey, headerList }) {
  const signer = new DKIM({
    domainName: signingDomain,
    keySelector: selector,
    privateKey,
    headerFieldNames: headerList,
  });
  const signed = (await streamToBuffer(signer.sign(message))).toString('latin1');
  const lines = signed.split(/\r?\n/);
  const signatureLines = [];

  for (const line of lines) {
    if (/^DKIM-Signature:/i.test(line) || (signatureLines.length && /^[ \t]/.test(line))) {
      signatureLines.push(line);
      continue;
    }
    break;
  }

  return signatureLines.join('\r\n');
}

exports.register = function () {
  const plugin = this;
  plugin.register_hook('queue_outbound', 'sign');
  plugin.register_hook('init_master', 'init_db');
  plugin.register_hook('init_child', 'init_db');
};

exports.init_db = function (next) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    this.logerror('DATABASE_URL not set - DKIM signing will fail closed');
    return next();
  }
  // A pool reconnects automatically on dropped connections, unlike a single
  // Client which silently dies and would disable signing for the process.
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.DKIM_PG_POOL_MAX || 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => this.logerror(`DKIM pg pool error: ${err.message}`));
  this.loginfo('Postgres pool ready for DKIM lookup');
  next();
};

exports.sign = async function (next, connection) {
  const plugin = this;
  const txn = connection.transaction;
  if (!txn) return next();

  const DENY = DKIM_REQUIRED ? DENYSOFT : OK;
  const denyMsg = 'DKIM signing temporarily unavailable; will retry';

  // Read the customer id from txn.notes first (header_cleanup stashes it there
  // before stripping the X-MP-* headers) and fall back to the raw header. This
  // makes signing independent of the queue_outbound plugin load order — reading
  // only the header would break if header_cleanup happened to run first, which
  // would DENYSOFT every message and silently halt all outbound mail.
  const customerId = ((txn.notes && txn.notes.customer_id) || txn.header.get('X-MP-Customer-ID') || '').trim();
  // Use the From: header domain for DKIM, not mail_from.host which is the VERP bounce address
  const fromHeader = (txn.header.get('From') || '').trim();
  const fromMatch = fromHeader.match(/@([\w.-]+)/);
  const fromDomain = fromMatch ? fromMatch[1].toLowerCase() : null;

  if (!customerId || !fromDomain) {
    connection.logerror(plugin, 'missing customer ID or from domain - cannot sign');
    return next(DENY, denyMsg);
  }
  if (!pool) {
    connection.logerror(plugin, 'pg pool not ready - cannot sign');
    return next(DENY, denyMsg);
  }

  let row;
  try {
    const result = await pool.query(
      `SELECT
         COALESCE(active_key.private_key, sending_domains.dkim_private_key) AS dkim_private_key,
         COALESCE(active_key.selector, sending_domains.dkim_selector) AS dkim_selector
       FROM sending_domains
       LEFT JOIN dkim_keys AS active_key
         ON active_key.domain_id = sending_domains.id
        AND active_key.state = 'active'
       WHERE sending_domains.customer_id = $1
         AND sending_domains.domain = $2
         AND sending_domains.verified_at IS NOT NULL`,
      [customerId, String(fromDomain).toLowerCase()]
    );
    row = result.rows[0];
  } catch (err) {
    connection.logerror(plugin, `DKIM DB lookup failed: ${err.message}`);
    return next(DENY, denyMsg);
  }

  if (!row) {
    connection.logerror(plugin, `No verified DKIM key for ${customerId}/${fromDomain}`);
    return next(DENY, denyMsg);
  }

  let privateKey;
  try {
    privateKey = decryptSecret(row.dkim_private_key);
  } catch (err) {
    connection.logerror(plugin, `DKIM key decrypt failed: ${err.message}`);
    return next(DENY, denyMsg);
  }

  txn.message_stream.get_data(async (buf) => {
    try {
      const signatures = await dkimSign(buf, {
        signingDomain: String(fromDomain).toLowerCase(),
        selector: row.dkim_selector,
        privateKey,
        headerList:
          'from:to:cc:subject:date:message-id:reply-to:list-unsubscribe:list-unsubscribe-post',
      });

      if (!signatures.trim()) {
        connection.logerror(plugin, 'DKIM produced no signature');
        return next(DENY, denyMsg);
      }

      // signatures may contain one or more folded "DKIM-Signature: ..." headers.
      // Split on the header name and add each one.
      const parts = signatures.split(/^(?=DKIM-Signature:)/im).filter((s) => s.trim());
      for (const part of parts) {
        const idx = part.indexOf(':');
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).replace(/\r?\n$/, '');
        txn.add_header(name, value);
      }
      connection.loginfo(plugin, `DKIM-signed for ${fromDomain} (selector=${row.dkim_selector})`);
      next();
    } catch (err) {
      connection.logerror(plugin, `DKIM sign failed: ${err.message}`);
      next(DENY, denyMsg);
    }
  });
};
