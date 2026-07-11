import { describe, it, expect, afterEach } from 'vitest';
import { CapturingPlatformMailer, db, runDunningSweep, seedCustomer, setPlatformMailer } from '@platform/shared';

afterEach(() => setPlatformMailer(null));

describe('billing dunning scheduler', () => {
  it('sends each stage once and restricts expired grace', async () => {
    const mailer = new CapturingPlatformMailer();
    setPlatformMailer(mailer);
    const customer = await seedCustomer({ billingStatus: 'past_due' });
    const graceEnds = new Date(Date.now() + 23 * 3600_000);
    await db.insertInto('billing_dunning_state').values({
      customer_id: customer.customerId, state: 'grace', failure_count: 1,
      grace_ends_at: graceEnds, last_failure_at: new Date(),
    }).execute();

    const first = await runDunningSweep(new Date(), { customerId: customer.customerId });
    expect(first).toMatchObject({ sent: 2, restricted: 0, failed: 0 });
    expect(mailer.sent.map((email) => email.subject)).toEqual(expect.arrayContaining([
      expect.stringContaining('Payment failed'), expect.stringContaining('grace period ends soon'),
    ]));
    const second = await runDunningSweep(new Date(), { customerId: customer.customerId });
    expect(second.sent).toBe(0);
    expect(mailer.sent).toHaveLength(2);

    const expired = await runDunningSweep(new Date(graceEnds.getTime() + 1000), { customerId: customer.customerId });
    expect(expired).toMatchObject({ restricted: 1, sent: 1, failed: 0 });
    expect(await db.selectFrom('billing_dunning_state').select('state').where('customer_id', '=', customer.customerId).executeTakeFirstOrThrow()).toMatchObject({ state: 'restricted' });
    expect(mailer.sent.at(-1)?.subject).toContain('Sending restricted');
  });

  it('sends recovery notification once', async () => {
    const mailer = new CapturingPlatformMailer();
    setPlatformMailer(mailer);
    const customer = await seedCustomer({ billingStatus: 'active' });
    await db.insertInto('billing_dunning_state').values({
      customer_id: customer.customerId, state: 'recovered', failure_count: 1, recovered_at: new Date(),
    }).execute();
    expect(await runDunningSweep(new Date(), { customerId: customer.customerId })).toMatchObject({ sent: 1, failed: 0 });
    expect(mailer.sent[0]?.subject).toContain('sending restored');
    expect((await runDunningSweep(new Date(), { customerId: customer.customerId })).sent).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });
});
