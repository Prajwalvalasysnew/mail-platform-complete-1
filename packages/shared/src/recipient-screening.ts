import { sql } from 'kysely';
import { db, type DbExecutor } from './db.js';
import { redis } from './redis.js';

const SUPPRESSION_TTL_SECONDS = 3600;

function suppressionKey(customerId: string, email: string): string {
  return `supp:${customerId}:${email}`;
}

export interface RecipientComplianceScreening {
  suppressed: Set<string>;
  restricted: Set<string>;
  sensitivePiLimited: Set<string>;
  intel: Map<string, { trap: boolean; disposable: boolean }>;
}

/**
 * Resolve every recipient-level send gate in one tenant-scoped SQL statement.
 *
 * Suppression cache hits remain Redis-only. Cache misses, active processing
 * restrictions, active sensitive-PI limits, and global domain intelligence are
 * then fetched together. This preserves the same fail-closed RLS boundary while
 * avoiding four independent database statements per send.
 */
export async function screenRecipientCompliance(
  customerId: string,
  emails: string[],
  executor: DbExecutor = db,
): Promise<RecipientComplianceScreening> {
  const normalized = [...new Set(emails.map((email) => email.toLowerCase()))];
  const suppressed = new Set<string>();
  const restricted = new Set<string>();
  const sensitivePiLimited = new Set<string>();
  const intel = new Map<string, { trap: boolean; disposable: boolean }>();
  if (normalized.length === 0) {
    return { suppressed, restricted, sensitivePiLimited, intel };
  }

  const cached = await redis.mget(
    ...normalized.map((email) => suppressionKey(customerId, email)),
  );
  const suppressionMisses: string[] = [];
  for (let index = 0; index < normalized.length; index++) {
    const email = normalized[index]!;
    if (cached[index] === '1') suppressed.add(email);
    else if (cached[index] !== '0') suppressionMisses.push(email);
  }

  // Keep the suppression branch syntactically valid when every address was a
  // cache hit. The impossible empty address cannot match a normalized email.
  const suppressionCandidates = suppressionMisses.length ? suppressionMisses : [''];
  const result = await sql<{
    email: string;
    kind: 'suppressed' | 'restricted' | 'sensitive_pi' | 'intel';
    category: string | null;
  }>`
    with input(email) as (
      select unnest(array[${sql.join(normalized)}]::text[])
    )
    select lower(s.email) as email, 'suppressed'::text as kind, null::text as category
    from suppressions s
    where s.customer_id = ${customerId}::uuid
      and lower(s.email) in (${sql.join(suppressionCandidates)})

    union all

    select lower(r.email), 'restricted'::text, null::text
    from processing_restrictions r
    where r.customer_id = ${customerId}::uuid
      and r.released_at is null
      and lower(r.email) in (${sql.join(normalized)})

    union all

    select lower(l.email), 'sensitive_pi'::text, null::text
    from sensitive_pi_limits l
    where l.customer_id = ${customerId}::uuid
      and l.released_at is null
      and lower(l.email) in (${sql.join(normalized)})

    union all

    select i.email, 'intel'::text, d.category::text
    from input i
    join recipient_domain_intel d
      on d.domain = split_part(i.email, '@', 2)
  `.execute(executor);

  for (const row of result.rows) {
    if (row.kind === 'suppressed') suppressed.add(row.email);
    else if (row.kind === 'restricted') restricted.add(row.email);
    else if (row.kind === 'sensitive_pi') sensitivePiLimited.add(row.email);
    else {
      intel.set(row.email, {
        trap: row.category === 'spam_trap',
        disposable: row.category === 'disposable',
      });
    }
  }

  if (suppressionMisses.length > 0) {
    const pipeline = redis.pipeline();
    for (const email of suppressionMisses) {
      pipeline.setex(
        suppressionKey(customerId, email),
        SUPPRESSION_TTL_SECONDS,
        suppressed.has(email) ? '1' : '0',
      );
    }
    await pipeline.exec();
  }

  // Preserve the previous batch helper's complete per-email map.
  for (const email of normalized) {
    if (!intel.has(email)) intel.set(email, { trap: false, disposable: false });
  }
  return { suppressed, restricted, sensitivePiLimited, intel };
}
