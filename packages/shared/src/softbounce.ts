// Soft-bounce escalation. A single soft bounce is transient, but repeated soft
// bounces over a window mean the mailbox is effectively dead. After N soft
// bounces within M days we escalate to a hard suppression.

import { sql } from 'kysely';
import { db } from './db.js';
import { addSuppression } from './suppression.js';

const SOFT_BOUNCE_LIMIT = Number(process.env.SOFT_BOUNCE_LIMIT ?? 5);
const SOFT_BOUNCE_WINDOW_DAYS = Number(process.env.SOFT_BOUNCE_WINDOW_DAYS ?? 7);

/**
 * Record a soft bounce for (customer, email). Returns true if this escalated to
 * a suppression (limit reached within the window).
 */
export async function recordSoftBounce(customerId: string, email: string): Promise<boolean> {
  const e = email.toLowerCase();
  const windowSecs = SOFT_BOUNCE_WINDOW_DAYS * 86400;
  // Single atomic upsert that ALSO handles the window reset inline: if the
  // existing first_seen is older than the window, restart the counter at 1 and
  // reset first_seen; otherwise increment. Doing this in one statement (rather
  // than a read, then a separate reset UPDATE) removes the double-write race
  // where two concurrent bounces both observe an expired window and both reset.
  const row = await db
    .insertInto('soft_bounce_tracker')
    .values({ customer_id: customerId, email: e, count: 1 })
    .onConflict((oc) =>
      oc.columns(['customer_id', 'email']).doUpdateSet({
        count: sql`CASE
          WHEN now() - soft_bounce_tracker.first_seen > make_interval(secs => ${windowSecs})
          THEN 1
          ELSE soft_bounce_tracker.count + 1 END`,
        first_seen: sql`CASE
          WHEN now() - soft_bounce_tracker.first_seen > make_interval(secs => ${windowSecs})
          THEN now()
          ELSE soft_bounce_tracker.first_seen END`,
        last_seen: sql`now()`,
      })
    )
    .returning(['count', 'first_seen'])
    .executeTakeFirstOrThrow();

  // After the atomic update, first_seen is guaranteed to be within the window,
  // so a count at/above the limit means escalation.
  if (row.count >= SOFT_BOUNCE_LIMIT) {
    await addSuppression(customerId, e, 'hard_bounce', `Escalated after ${row.count} soft bounces in ${SOFT_BOUNCE_WINDOW_DAYS}d`);
    await db.deleteFrom('soft_bounce_tracker').where('customer_id', '=', customerId).where('email', '=', e).execute();
    return true;
  }
  return false;
}

/** A recipient who later delivers successfully should have their counter cleared. */
export async function clearSoftBounce(customerId: string, email: string): Promise<void> {
  await db
    .deleteFrom('soft_bounce_tracker')
    .where('customer_id', '=', customerId)
    .where('email', '=', email.toLowerCase())
    .execute();
}
