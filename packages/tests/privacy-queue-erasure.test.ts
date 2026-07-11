import { describe, it, expect } from 'vitest';
import {
  sendQueue, eventsQueue, webhooksQueue, deadLetterQueue, purgeQueuedMessageData,
} from '@platform/shared';

describe('privacy queue erasure', () => {
  it('removes matching payloads from normal queues and the DLQ without touching unrelated jobs', async () => {
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    const erased = `m-erased-${suffix}`;
    const keep = `m-keep-${suffix}`;
    const ids = {
      send: `privacySend${suffix}`,
      event: `privacyEvent${suffix}`,
      webhook: `privacyWebhook${suffix}`,
      dlq: `privacyDlq${suffix}`,
      keep: `privacyKeep${suffix}`,
    };
    await sendQueue.add('send', { message_id: erased, customer_id: 'customer-a' }, { jobId: ids.send });
    await eventsQueue.add('event', { message_id: erased, customer_id: 'customer-a', event_type: 'delivered' }, { jobId: ids.event });
    await webhooksQueue.add('deliver', { webhook_id: 'w1', event_id: 'e1', event_type: 'delivered', payload: { message_id: erased } }, { jobId: ids.webhook });
    await deadLetterQueue.add('dead', {
      source_queue: 'events', data: { message_id: erased, payload: { secret: 'recipient data' } },
      failed_reason: 'test', attempts_made: 5, dead_lettered_at: new Date().toISOString(),
    }, { jobId: ids.dlq });
    await sendQueue.add('send', { message_id: keep, customer_id: 'customer-a' }, { jobId: ids.keep });

    const result = await purgeQueuedMessageData(erased);
    expect(result).toMatchObject({ removed: 4, active: 0 });
    expect(await sendQueue.getJob(ids.send)).toBeUndefined();
    expect(await eventsQueue.getJob(ids.event)).toBeUndefined();
    expect(await webhooksQueue.getJob(ids.webhook)).toBeUndefined();
    expect(await deadLetterQueue.getJob(ids.dlq)).toBeUndefined();
    expect(await sendQueue.getJob(ids.keep)).toBeTruthy();
    await (await sendQueue.getJob(ids.keep))?.remove();
  });
});
