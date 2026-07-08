// Parses inbound bounces (DSN, RFC 3464) and Feedback Loop reports (ARF, RFC 5965).
// Extracts the original Message-ID from the VERP return-path, classifies the
// bounce/complaint, and pushes an event to the events queue.

const { simpleParser } = require('mailparser');
const { Queue } = require('bullmq');
const crypto = require('crypto');

let eventsQueue;

// Mirror of shared/src/crypto.ts verpTag — keep in sync.
function verpTag(encoded) {
  const secret = process.env.VERP_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('VERP_SECRET required (>= 16 chars)');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest()
    .subarray(0, 8)
    .toString('base64url');
}

/**
 * Deterministic, collision-resistant idempotency key for a bounce/complaint
 * event. Stable for a given (message-id, event class, recipient) so a provider
 * that re-delivers the same DSN/FBL maps to the same key and is deduped by the
 * events.event_key unique index — instead of being counted again. We hash the
 * tuple (rather than concatenating raw) so the value is a fixed-length,
 * index-friendly token and never collides across the namespace separator.
 */
function bounceEventKey(messageId, eventType, recipient) {
  return crypto
    .createHash('sha256')
    .update(`${eventType}\n${messageId}\n${recipient || ''}`)
    .digest('hex');
}

exports.register = function () {
  const plugin = this;
  plugin.register_hook('init_master', 'init_queue');
  plugin.register_hook('init_child', 'init_queue');
  plugin.register_hook('queue', 'parse');
};

exports.init_queue = function (next) {
  try {
    const prefix = process.env.QUEUE_PREFIX || '';
    eventsQueue = new Queue(`${prefix}events`, {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
    });
    this.loginfo(`events queue connected (inbound, name=${prefix}events)`);
    next();
  } catch (err) {
    this.logerror(`failed to init events queue: ${err.message}`);
    next();
  }
};

/**
 * Extract and VERIFY the original message-id from a signed VERP envelope.
 * Format: bounce+<encoded>.<sig>@bounces.domain
 *   encoded = base64url(original full Message-ID without angle brackets)
 *   sig     = base64url(first 8 bytes of HMAC-SHA256(VERP_SECRET, encoded))
 * Returns the original Message-ID (with angle brackets) or null if the
 * signature is missing or invalid (forged/spoofed bounce).
 */
function extractMessageIdFromVerp(envelope) {
  if (!envelope) return null;
  // Use Haraka's pre-parsed local part. envelope.original keeps the angle
  // brackets (e.g. "<bounce+enc.sig@domain>"), so splitting it yields
  // "<bounce+enc.sig" and the regex never matches. envelope.user is the
  // bracket-free local part ("bounce+enc.sig"). Fall back to stripping brackets
  // off .original for envelope shapes that lack .user.
  let local = envelope.user;
  if (!local && envelope.original) {
    local = String(envelope.original).replace(/^</, '').split('@')[0];
  }
  if (!local) return null;
  const m = local.match(/^bounce\+([^.@]+)\.([^.@]+)$/i);
  if (!m) return null;
  const encoded = m[1];
  const sig = m[2];
  let expected;
  try {
    expected = verpTag(encoded);
  } catch (err) {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null; // forged or tampered bounce token — ignore
  }
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8').replace(/[<>]/g, '');
  return `<${decoded}>`;
}

/**
 * Parse a DSN (delivery status notification). Defensive against the wide
 * variation in real-world bounces: prefers structured Status/Action fields,
 * falls back to SMTP reply codes embedded in the Diagnostic-Code, and exposes
 * a `confident` flag so the inbound MTA can track parse quality.
 */
/**
 * Build the text blob a DSN/FBL parser scans, but CAP its total size. Bounce and
 * feedback reports are tiny by nature (a few KB); an inbound message with huge or
 * many attachments would otherwise let an attacker build an arbitrarily large
 * in-memory string and force multiple regex scans over it — a memory/CPU
 * amplification vector on the inbound MTA. We stop accumulating once we pass the
 * cap; the structured DSN/FBL fields we care about always appear early.
 */
const MAX_BLOB_BYTES = 256 * 1024; // far more than any real DSN/FBL
function buildBoundedBlob(parsed) {
  const parts = [parsed.text || ''];
  let total = parts[0].length;
  for (const a of parsed.attachments || []) {
    if (total >= MAX_BLOB_BYTES) break;
    if (a && a.content) {
      const s = a.content.toString('utf8');
      parts.push(s);
      total += s.length + 1;
    }
  }
  let blob = parts.join('\n');
  if (blob.length > MAX_BLOB_BYTES) blob = blob.slice(0, MAX_BLOB_BYTES);
  return blob;
}

function parseDsn(parsed) {
  const result = { isBounce: false, status: null, diagnostic: null, recipient: null, action: null, isHard: false, confident: false };

  const ctype = (parsed.headers.get('content-type') || {}).value || '';
  const textBlob = buildBoundedBlob(parsed);

  const looksLikeDsn =
    /delivery-status/i.test(ctype) ||
    /report-type=["']?delivery-status/i.test(ctype) ||
    /Diagnostic-Code:/i.test(textBlob) ||
    /Final-Recipient:/i.test(textBlob);
  if (!looksLikeDsn) return result;
  result.isBounce = true;

  const statusMatch = textBlob.match(/^Status:\s*([0-9]+\.[0-9]+\.[0-9]+)/im);
  if (statusMatch) {
    result.status = statusMatch[1];
    result.isHard = statusMatch[1].startsWith('5');
    result.confident = true;
  }

  const actionMatch = textBlob.match(/^Action:\s*([a-z]+)/im);
  if (actionMatch) result.action = actionMatch[1].toLowerCase();

  const diagMatch =
    textBlob.match(/^Diagnostic-Code:\s*(.+?)(?:\r?\n(?!\s)|$)/ims) ||
    textBlob.match(/Diagnostic-Code:\s*(.+)/i);
  if (diagMatch) result.diagnostic = diagMatch[1].trim();

  const rcptMatch =
    textBlob.match(/^(?:Final|Original)-Recipient:\s*[^;]+;\s*(.+?)\s*$/im) ||
    textBlob.match(/<([^>]+@[^>]+)>/);
  if (rcptMatch) result.recipient = rcptMatch[1].trim();

  // Fallbacks when no structured Status present.
  if (!result.status && result.diagnostic) {
    const code = result.diagnostic.match(/\b([45])\d\d\b/);
    if (code) {
      result.isHard = code[1] === '5';
      result.confident = true;
    }
  }
  if (result.action === 'failed' && !result.status) result.isHard = true;

  return result;
}

/**
 * Parse a Feedback Loop (ARF) report (RFC 5965).
 */
function parseFbl(parsed) {
  const result = { isComplaint: false, feedbackType: null, recipient: null, originalMessageId: null, confident: false };
  const ctype = (parsed.headers.get('content-type') || {}).value || '';
  const textBlob = buildBoundedBlob(parsed);

  if (!/feedback-report/i.test(ctype) && !/Feedback-Type:/i.test(textBlob)) return result;
  result.isComplaint = true;

  const ft = textBlob.match(/^Feedback-Type:\s*(\S+)/im);
  if (ft) result.feedbackType = ft[1];
  const rcptMatch =
    textBlob.match(/^Original-Rcpt-To:\s*(.+?)\s*$/im) ||
    textBlob.match(/^Removal-Recipient:\s*(.+?)\s*$/im);
  if (rcptMatch) result.recipient = rcptMatch[1].trim();
  const midMatch = textBlob.match(/^Message-ID:\s*(<[^>]+>)/im);
  if (midMatch) result.originalMessageId = midMatch[1].trim();
  result.confident = !!result.feedbackType;

  return result;
}

// Exported for unit testing. These are pure functions with no Haraka/queue
// dependency; the plugin hooks above are exercised via integration only.
exports._internal = { parseDsn, parseFbl, extractMessageIdFromVerp, verpTag, bounceEventKey };

exports.parse = function (next, connection) {
  const plugin = this;
  const txn = connection.transaction;
  if (!txn) return next();

  // Try to extract message-id from VERP envelope first
  const verpMessageId = extractMessageIdFromVerp(txn.rcpt_to[0]);

  txn.message_stream.get_data(async (buffer) => {
    try {
      const parsed = await simpleParser(buffer);

      // Try DSN first
      const dsn = parseDsn(parsed);
      if (dsn.isBounce) {
        const messageId = verpMessageId;
        if (!messageId) {
          connection.logwarn(plugin, 'DSN received but could not extract original message ID');
          return next(OK);
        }
        if (!eventsQueue) return next(OK);

        await eventsQueue.add(dsn.isHard ? 'hard_bounce' : 'soft_bounce', {
          message_id: messageId,
          event_type: dsn.isHard ? 'hard_bounce' : 'soft_bounce',
          // Deterministic idempotency key. Mail providers RETRY DSN delivery, so
          // a random UUID here would let the same bounce be counted multiple
          // times (double-bumping the `bounced` usage counter and re-running
          // suppression). Key on the signed message-id + event class + recipient
          // so a re-delivered identical DSN collides on the events.event_key
          // unique index and is skipped by the event worker.
          event_key: bounceEventKey(messageId, dsn.isHard ? 'hard_bounce' : 'soft_bounce', dsn.recipient),
          payload: {
            status: dsn.status,
            diagnostic: dsn.diagnostic,
            recipient: dsn.recipient,
            source: 'dsn',
          },
          occurred_at: new Date().toISOString(),
        });
        connection.loginfo(plugin, `Parsed ${dsn.isHard ? 'hard' : 'soft'} bounce for ${messageId}`);
        return next(OK);
      }

      // Try FBL
      const fbl = parseFbl(parsed);
      if (fbl.isComplaint) {
        // SECURITY: the original Message-ID is only trustworthy when it comes
        // from the cryptographically signed VERP return-path. The Message-ID
        // header inside the ARF report body is attacker-controllable, so it must
        // never be used on its own to target a suppression — otherwise anyone
        // who can deliver a forged complaint could suppress (and ding the
        // reputation of) an arbitrary recipient. Require the verified VERP id;
        // if the body also carries a Message-ID, it must match the signed one.
        const messageId = verpMessageId;
        if (!messageId) {
          connection.logwarn(plugin, 'FBL complaint received but VERP return-path was missing/unsigned — ignoring (possible forgery)');
          return next(OK);
        }
        if (fbl.originalMessageId && fbl.originalMessageId !== messageId) {
          connection.logwarn(plugin, `FBL complaint body Message-ID (${fbl.originalMessageId}) does not match signed VERP id (${messageId}) — ignoring`);
          return next(OK);
        }
        if (!eventsQueue) return next(OK);

        await eventsQueue.add('complaint', {
          message_id: messageId,
          event_type: 'complaint',
          // Deterministic — see the bounce path above. FBL reports are also
          // re-delivered by providers; a stable key prevents double-counting a
          // single complaint.
          event_key: bounceEventKey(messageId, 'complaint', fbl.recipient),
          payload: {
            recipient: fbl.recipient,
            source: 'fbl',
          },
          occurred_at: new Date().toISOString(),
        });
        connection.loginfo(plugin, `Parsed complaint for ${messageId}`);
        return next(OK);
      }

      // Unknown - log and accept silently
      connection.logwarn(plugin, 'Unknown inbound mail type - not a DSN or FBL');
      return next(OK);
    } catch (err) {
      connection.logerror(plugin, `Parse failed: ${err.message}`);
      return next(OK);
    }
  });
};
