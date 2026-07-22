// SMTP submission gateway: a real SMTP client (nodemailer) against the real
// gateway server — auth, verified-sender policy, suppression, storage.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import nodemailer from 'nodemailer';
import { seedCustomer, seedVerifiedDomain, seedSuppression, type SeededCustomer } from './harness.js';
import { db, setAttachmentMalwareScanner } from '@platform/shared';

let smtpServer: any;
let port: number;
let cust: SeededCustomer;
let domain: string;

function client(pass: string) {
  return nodemailer.createTransport({
    host: '127.0.0.1',
    port,
    secure: false,
    ignoreTLS: true,
    auth: { user: 'apikey', pass },
  });
}

beforeAll(async () => {
  process.env.SMTP_GATEWAY_AUTOSTART = 'false';
  process.env.SMTP_AUTH_FAILURE_LIMIT = '3';
  const { buildSmtpServer } = await import('@platform/smtp-gateway');
  smtpServer = buildSmtpServer();
  await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', resolve));
  port = smtpServer.server.address().port;

  cust = await seedCustomer();
  domain = await seedVerifiedDomain(cust.customerId);
});

afterAll(async () => {
  await new Promise<void>((resolve) => smtpServer.close(resolve));
});

describe('SMTP gateway', () => {
  it('accepts an authenticated submission and feeds the platform pipeline', async () => {
    const to = `smtp-user-${Date.now()}@example.com`;
    const info = await client(cust.apiKey).sendMail({
      from: `Machines <alerts@${domain}>`,
      to,
      subject: 'Disk space warning',
      text: 'Volume /dev/sda1 is 91% full.',
    });
    expect(info.response).toContain('250');
    expect(info.accepted).toHaveLength(1);

    const idMatch = info.response.match(/id=(\S+)/);
    expect(idMatch).toBeTruthy();
    const row = await db
      .selectFrom('messages')
      .selectAll()
      .where('message_id', '=', idMatch![1]!)
      .executeTakeFirstOrThrow();
    expect(row.to_address).toBe(to);
    expect(row.from_address).toBe(`alerts@${domain}`);
    expect(row.from_name).toBe('Machines');
    expect(row.subject).toBe('Disk space warning');
    expect(row.tags).toEqual(['smtp']);
    expect(row.status).toBe('queued');
    expect((row.metadata as any)._channel).toBe('smtp');

    const outbox = await db
      .selectFrom('send_outbox')
      .select('status')
      .where('message_id', '=', row.message_id)
      .executeTakeFirst();
    expect(outbox).toBeTruthy();
  });

  it('carries attachments through the SMTP path with the same validation', async () => {
    const to = `smtp-att-${Date.now()}@example.com`;
    const info = await client(cust.apiKey).sendMail({
      from: `billing@${domain}`,
      to,
      subject: 'Invoice attached',
      text: 'See attachment',
      attachments: [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4 smtp invoice'), contentType: 'application/pdf' }],
    });
    expect(info.response).toContain('250');
    const id = info.response.match(/id=(\S+)/)![1]!;
    const row = await db.selectFrom('messages').select('attachments').where('message_id', '=', id).executeTakeFirstOrThrow();
    expect(row.attachments![0]!.filename).toBe('invoice.pdf');
    expect(row.attachments![0]!.content_type).toBe('application/pdf');
  });

  it('rejects executable attachments over SMTP', async () => {
    await expect(
      client(cust.apiKey).sendMail({
        from: `billing@${domain}`,
        to: 'x@example.com',
        subject: 'totally fine',
        text: 'x',
        attachments: [{ filename: 'payload.exe', content: Buffer.from('MZ...') }],
      })
    ).rejects.toThrow(/not deliverable/i);
  });

  it('rejects malware detected through the SMTP attachment path', async () => {
    try {
      setAttachmentMalwareScanner({
        name: 'smtp-e2e-av',
        async scan() { return { clean: false, threat: 'Eicar-Test-Signature' }; },
      });
      await expect(
        client(cust.apiKey).sendMail({
          from: `billing@${domain}`,
          to: 'malware@example.com',
          subject: 'renamed malware',
          text: 'x',
          attachments: [{ filename: 'renamed.pdf', content: Buffer.from('%PDF-1.4 fake') }],
        })
      ).rejects.toThrow(/malware scanning/i);
    } finally {
      setAttachmentMalwareScanner(undefined);
    }
  });

  it('rejects bad credentials and locks out after repeated failures', async () => {
    await expect(
      client('mp_live_definitely_not_a_real_key_000000').sendMail({
        from: `alerts@${domain}`, to: 'x@example.com', subject: 'x', text: 'x',
      })
    ).rejects.toThrow(/535|Authentication failed/i);
    await expect(
      client('mp_live_definitely_not_a_real_key_000000').verify()
    ).rejects.toThrow();
    // Third attempt from the same IP hits the lockout (limit=3).
    await expect(
      client('mp_live_definitely_not_a_real_key_000001').verify()
    ).rejects.toThrow();
    await expect(
      client(cust.apiKey).verify()
    ).rejects.toThrow(/Too many failed authentication/i);
    // Clear the lockout for the remaining tests.
    const { redis } = await import('@platform/shared');
    const keys = await redis.keys('smtp:authfail:*');
    if (keys.length) await redis.del(...keys);
  });

  it("rejects keys lacking the send/smtp scope", async () => {
    const limited = await seedCustomer({ scopes: ['domains'] });
    await expect(client(limited.apiKey).verify()).rejects.toThrow(/scope/i);
  });

  it('rejects MAIL FROM on an unverified domain before DATA', async () => {
    await expect(
      client(cust.apiKey).sendMail({
        from: 'alerts@not-my-domain.example',
        to: 'x@example.com',
        subject: 'x',
        text: 'x',
      })
    ).rejects.toThrow(/not registered/i);
  });

  it('accepts but silently drops suppressed recipients', async () => {
    const suppressed = `smtp-supp-${Date.now()}@example.com`;
    await seedSuppression(cust.customerId, suppressed);
    const info = await client(cust.apiKey).sendMail({
      from: `alerts@${domain}`,
      to: suppressed,
      subject: 'x',
      text: 'x',
    });
    expect(info.response).toContain('suppressed');
    const count = await db
      .selectFrom('messages')
      .select(db.fn.countAll().as('c'))
      .where('to_address', '=', suppressed)
      .executeTakeFirst();
    expect(Number((count as any).c)).toBe(0);
  });
});
