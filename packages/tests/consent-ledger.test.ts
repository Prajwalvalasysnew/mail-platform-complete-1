// DB integration tests for the consent ledger (gap analysis Top-20 #8:
// "Suppressions exist, but consent history/preference center is incomplete").
// The ledger is an append-only audit trail of every suppress/unsuppress event
// for GDPR/CAN-SPAM proof. These tests verify events are recorded on every
// consent-changing operation with correct action/reason/source attribution.

import { describe, it, expect } from 'vitest';
import {
  addSuppression,
  addSuppressionsBulk,
  removeSuppression,
  getConsentHistory,
  seedCustomer,
} from '@platform/shared';

const rndEmail = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

describe('consent ledger', () => {
  it('records a suppress event with reason-derived source', async () => {
    const c = await seedCustomer();
    const email = rndEmail('sup');
    await addSuppression(c.customerId, email, 'complaint', 'FBL report');

    const history = await getConsentHistory(c.customerId, email);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'suppress',
      reason: 'complaint',
      source: 'complaint', // derived from reason
      notes: 'FBL report',
    });
  });

  it('derives one_click_unsubscribe / bounce_escalation sources by reason', async () => {
    const c = await seedCustomer();
    const e1 = rndEmail('unsub');
    const e2 = rndEmail('bounce');
    await addSuppression(c.customerId, e1, 'unsubscribe');
    await addSuppression(c.customerId, e2, 'hard_bounce');

    expect((await getConsentHistory(c.customerId, e1))[0].source).toBe('one_click_unsubscribe');
    expect((await getConsentHistory(c.customerId, e2))[0].source).toBe('bounce_escalation');
  });

  it('honors an explicit source + messageId override', async () => {
    const c = await seedCustomer();
    const email = rndEmail('explicit');
    await addSuppression(c.customerId, email, 'unsubscribe', 'One-click via msg_123', undefined, {
      source: 'one_click_unsubscribe',
      messageId: 'msg_123',
    });
    const h = await getConsentHistory(c.customerId, email);
    expect(h[0].source).toBe('one_click_unsubscribe');
    expect(h[0].message_id).toBe('msg_123');
  });

  it('records an unsuppress event on removal, building a full history', async () => {
    const c = await seedCustomer();
    const email = rndEmail('cycle');
    await addSuppression(c.customerId, email, 'manual', 'added by support');
    await removeSuppression(c.customerId, email);
    // Re-suppress to prove the ledger keeps ALL transitions, not just the latest.
    await addSuppression(c.customerId, email, 'unsubscribe');

    const history = await getConsentHistory(c.customerId, email);
    expect(history).toHaveLength(3);
    // Newest first: suppress, unsuppress, suppress.
    expect(history.map((h) => h.action)).toEqual(['suppress', 'unsuppress', 'suppress']);
    expect(history[1]).toMatchObject({ action: 'unsuppress', reason: 'resubscribe', source: 'api' });
  });

  it('does NOT log an unsuppress when nothing was actually removed', async () => {
    const c = await seedCustomer();
    const email = rndEmail('noop');
    // Remove without ever suppressing → no row deleted → no ledger entry.
    await removeSuppression(c.customerId, email);
    expect(await getConsentHistory(c.customerId, email)).toHaveLength(0);
  });

  it('records a ledger row per address on bulk import', async () => {
    const c = await seedCustomer();
    const emails = [rndEmail('bulk1'), rndEmail('bulk2'), rndEmail('bulk3')];
    await addSuppressionsBulk(c.customerId, emails, 'manual', 'imported list');

    for (const email of emails) {
      const h = await getConsentHistory(c.customerId, email);
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({ action: 'suppress', source: 'bulk_import' });
    }
  });

  it('attributes a GDPR erasure removal distinctly', async () => {
    const c = await seedCustomer();
    const email = rndEmail('gdpr');
    await addSuppression(c.customerId, email, 'manual');
    await removeSuppression(c.customerId, email, undefined, { source: 'gdpr_erasure', reason: 'erasure' });
    const h = await getConsentHistory(c.customerId, email);
    expect(h[0]).toMatchObject({ action: 'unsuppress', reason: 'erasure', source: 'gdpr_erasure' });
  });
});
