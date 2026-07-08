// DKIM selector rotation. Static selectors are an operational liability: a
// compromised key can't be retired cleanly. This manages overlapping selectors
// per domain with a documented lifecycle:
//
//   pending  -> key generated, DNS TXT published, NOT yet signing
//   active   -> the selector we sign with (exactly one per domain)
//   retiring -> superseded; DNS record kept so in-flight mail still verifies
//   retired  -> DNS record removable
//
// Rotation: generate a new key (pending) -> publish DNS -> verify propagation
// -> promote to active (old active -> retiring) -> after a TTL retire it.

import crypto from 'node:crypto';
import { db } from './db.js';
import { encryptSecret } from './encryption.js';

export function generateDkimKeypair(): { publicKey: string; privateKey: string; publicDnsValue: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicDnsValue = publicKey
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  return { publicKey, privateKey, publicDnsValue };
}

function datedSelector(): string {
  const d = new Date();
  return `mp${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Create a new pending DKIM key for a domain and return the DNS record to publish. */
export async function createPendingKey(domainId: string, selector = datedSelector()) {
  const { publicKey, privateKey, publicDnsValue } = generateDkimKeypair();
  const row = await db
    .insertInto('dkim_keys')
    .values({
      domain_id: domainId,
      selector,
      public_key: publicKey,
      private_key: encryptSecret(privateKey),
      state: 'pending',
    })
    .onConflict((oc) => oc.columns(['domain_id', 'selector']).doNothing())
    .returning(['id', 'selector'])
    .executeTakeFirst();
  if (!row) {
    throw new Error(`DKIM selector '${selector}' already exists for this domain.`);
  }
  return { id: row.id, selector, dns_value: `v=DKIM1; k=rsa; p=${publicDnsValue}` };
}

/** Promote a pending key to active; demote the current active to retiring. */
export async function promoteKey(domainId: string, selector: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('dkim_keys')
      .set({ state: 'retiring', retiring_at: new Date() })
      .where('domain_id', '=', domainId)
      .where('state', '=', 'active')
      .execute();
    await trx
      .updateTable('dkim_keys')
      .set({ state: 'active', activated_at: new Date() })
      .where('domain_id', '=', domainId)
      .where('selector', '=', selector)
      .execute();
  });
}

/** Retire keys that have been 'retiring' longer than the TTL (default 7d). */
export async function retireOldKeys(ttlDays = Number(process.env.DKIM_RETIRE_DAYS ?? 7)): Promise<number> {
  const cutoff = new Date(Date.now() - ttlDays * 86400_000);
  const res = await db
    .updateTable('dkim_keys')
    .set({ state: 'retired', retired_at: new Date() })
    .where('state', '=', 'retiring')
    // Grace period is measured from when the key was demoted (retiring_at), not
    // from when it was first activated. Fall back to activated_at for any legacy
    // row that predates retiring_at.
    .where((eb) => eb.or([
      eb('retiring_at', '<', cutoff),
      eb.and([eb('retiring_at', 'is', null), eb('activated_at', '<', cutoff)]),
    ]))
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

/** The active signing key for a domain (selector + decryptable private key). */
export async function getActiveKey(domainId: string) {
  return db
    .selectFrom('dkim_keys')
    .select(['selector', 'private_key'])
    .where('domain_id', '=', domainId)
    .where('state', '=', 'active')
    .executeTakeFirst();
}
