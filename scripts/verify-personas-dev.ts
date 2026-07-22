// Read-only verification of development replay visibility in the development DB and Mailpit.
// The admin console reads the same rows. Querying the DB directly avoids depending on
// the running API process's ephemeral admin-session pepper.

import 'dotenv/config';
import { closeDb, db } from '../packages/shared/src/db.js';

const mailpitBase = process.env.DEV_REPLAY_MAILPIT_BASE ?? 'http://localhost:8025';

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '::1'].includes(database.hostname) || database.port === '5434') {
    throw new Error('Refusing non-development database');
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [customers, customersByStatus, messages24h, suppressions, replayMessages, mailpitInfoResponse, mailpitMessagesResponse] = await Promise.all([
    db.selectFrom('customers')
      .select(['id', 'email', 'tier', 'status', 'daily_quota', 'monthly_quota'])
      .where('email', 'like', 'dev-replay-%')
      .orderBy('created_at', 'desc')
      .execute(),
    db.selectFrom('customers')
      .select(['status', (eb) => eb.fn.countAll<number>().as('count')])
      .groupBy('status')
      .execute(),
    db.selectFrom('messages')
      .select(['status', (eb) => eb.fn.countAll<number>().as('count')])
      .where('queued_at', '>=', since)
      .groupBy('status')
      .execute(),
    db.selectFrom('suppressions')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirst(),
    db.selectFrom('messages')
      .select(['customer_id', 'subject', 'status', 'to_address', 'queued_at'])
      .where('subject', 'like', '[DEV REPLAY]%')
      .orderBy('queued_at', 'desc')
      .limit(50)
      .execute(),
    fetch(`${mailpitBase}/api/v1/info`),
    fetch(`${mailpitBase}/api/v1/messages?limit=50`),
  ]);
  for (const response of [mailpitInfoResponse, mailpitMessagesResponse]) {
    if (!response.ok) throw new Error(`Verification request failed: ${response.url} (${response.status})`);
  }

  const mailpitInfo = await mailpitInfoResponse.json() as any;
  const mailbox = await mailpitMessagesResponse.json() as any;
  const mailpitReplayMessages = mailbox.messages
    .filter((message: any) => String(message.Subject).startsWith('[DEV REPLAY]'))
    .map((message: any) => ({ subject: message.Subject, created: message.Created }));

  const messageCounts = Object.fromEntries(messages24h.map((row) => [row.status, Number(row.count)]));

  console.log(JSON.stringify({
    admin: {
      customers,
      overview: {
        customers_by_status: Object.fromEntries(customersByStatus.map((row) => [row.status, Number(row.count)])),
        messages_24h: { by_status: messageCounts, total: Object.values(messageCounts).reduce((sum, count) => sum + count, 0) },
        suppressions_total: Number(suppressions?.count ?? 0),
      },
      replay_messages: replayMessages,
    },
    mailpit: { total: mailpitInfo.Messages, unread: mailpitInfo.Unread, replay_messages: mailpitReplayMessages },
  }, null, 2));
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await closeDb();
    process.exitCode = 1;
  });
