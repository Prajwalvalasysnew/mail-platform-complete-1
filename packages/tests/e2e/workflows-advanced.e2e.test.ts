// Production workflow capabilities across industries: named business events,
// contact data (tags, attributes, time zone), wait-until-date reminders,
// update-contact and notify steps, entry rules, quiet hours, frequency caps,
// list-join and date-based triggers. Real PG + Redis + BullMQ workflow worker.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain, countMessagesTo, type SeededCustomer } from './harness.js';
import { startWorkflowWorker } from '@platform/worker/workflow-worker.js';
import { enrollAudienceWorkflows, sweepDateTriggeredWorkflows, kickWorkflowRun, localDate, compileWorkflow, db } from '@platform/shared';

let app: FastifyInstance;
let worker: ReturnType<typeof startWorkflowWorker>;
let cust: SeededCustomer;
let domain: string;
let templateId: string;
const silent: any = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return silent; } };
const authed = () => ({ authorization: `Bearer ${cust.apiKey}` });
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

async function publish(name: string, definition: unknown): Promise<string> {
  const create = await app.inject({ method: 'POST', url: '/v1/workflows', headers: authed(), payload: { name: `${name}-${Date.now()}`, definition } });
  expect(create.statusCode, create.body).toBe(201);
  const id = create.json().id as string;
  const res = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/publish`, headers: authed(), payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  return id;
}
async function runsFor(workflowId: string, subject: string) {
  return db.selectFrom('workflow_runs').selectAll().where('workflow_id', '=', workflowId).where('subject_email', '=', subject).orderBy('started_at').execute();
}
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 150)); last = await fn(); }
  return last;
}
const runStatus = (id: string) => db.selectFrom('workflow_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
async function seedContact(email: string, extra: Record<string, unknown> = {}) {
  await db.insertInto('audience_contacts').values({ customer_id: cust.customerId, email, name: 'Ada Lovelace', status: 'Subscribed', consent_confirmed_at: new Date(), ...extra } as any).execute();
}
const trigger = async (id: string, subject: string, context: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/v1/workflows/${id}/trigger`, headers: authed(), payload: { subject_email: subject, context } });

beforeAll(async () => {
  app = await buildTestApp();
  worker = startWorkflowWorker(silent);
  await worker.waitUntilReady();
  cust = await seedCustomer();
  domain = await seedVerifiedDomain(cust.customerId);
  const tpl = await app.inject({ method: 'POST', url: '/v1/templates', headers: authed(), payload: { name: 'wf-order', subject: 'Thanks {{first_name}} for order {{order_id}}', html_body: '<p>Plan {{plan}}</p>' } });
  expect(tpl.statusCode).toBe(201);
  templateId = tpl.json().id;
});
afterAll(async () => { await worker.close(); await app.close(); });

describe('named business events (any industry)', () => {
  it('starts on a custom event, personalizes from contact + event data, waits for a follow-up event and exits on a custom goal', async () => {
    const id = await publish('order-journey', {
      trigger: { type: 'custom_event', event_name: 'order_placed', filters: [{ field: 'trigger.total', op: 'gte', value: 50 }] },
      entry_step_id: 'thanks',
      steps: [
        { id: 'thanks', type: 'send_email', template_id: templateId, from: `shop@${domain}`, next: 'shipped' },
        { id: 'shipped', type: 'wait_for_event', event_types: ['custom:order_shipped'], timeout_seconds: 86_400, scope: 'run', on_event: 'review', on_timeout: null },
        { id: 'review', type: 'delay', duration_seconds: 3600, next: null },
      ],
      goal: { event_type: 'custom:review_left', exit_on_goal: true },
      settings: { allow_reentry: true },
    });
    const subject = uniq('buyer');
    await seedContact(subject, { attributes: { plan: 'gold' } });

    const small = await app.inject({ method: 'POST', url: '/v1/workflows/events', headers: authed(), payload: { event: 'order_placed', email: subject, data: { order_id: 'A-1', total: 10 } } });
    expect(small.statusCode, small.body).toBe(202);
    const big = await app.inject({ method: 'POST', url: '/v1/workflows/events', headers: authed(), payload: { event: 'order_placed', email: subject, data: { order_id: 'A-2', total: 120 } } });
    expect(big.statusCode).toBe(202);

    const [run] = await waitFor(() => runsFor(id, subject), (r) => r.length === 1 && r[0]!.status === 'waiting_event');
    expect(run!.status).toBe('waiting_event');
    expect((run!.context as any).context.order_id).toBe('A-2'); // the filtered-out small order never entered
    const msg = await db.selectFrom('messages').select(['subject', 'html_body']).where('customer_id', '=', cust.customerId).where('to_address', '=', subject).executeTakeFirstOrThrow();
    expect(msg.subject).toBe('Thanks Ada for order A-2');
    expect(msg.html_body).toContain('Plan gold');

    await app.inject({ method: 'POST', url: '/v1/workflows/events', headers: authed(), payload: { event: 'order_shipped', email: subject } });
    expect((await waitFor(() => runStatus(run!.id), (r) => r.status === 'waiting_delay')).status).toBe('waiting_delay');
    await app.inject({ method: 'POST', url: '/v1/workflows/events', headers: authed(), payload: { event: 'review_left', email: subject } });
    expect((await waitFor(() => runStatus(run!.id), (r) => r.status === 'goal_met')).status).toBe('goal_met');
  });

  it('rejects malformed event names and oversized data', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/workflows/events', headers: authed(), payload: { event: 'Order Placed!', email: 'a@example.com' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/workflows/events', headers: authed(), payload: { event: 'x', email: 'a@example.com', data: { blob: 'x'.repeat(20_000) } } })).statusCode).toBe(400);
  });
});

describe('contact-aware logic', () => {
  it('branches on tags, attributes and run engagement, then updates the contact', async () => {
    const id = await publish('vip-branch', {
      trigger: { type: 'api' },
      entry_step_id: 'is_vip',
      steps: [
        { id: 'is_vip', type: 'condition', match: 'all', rules: [{ field: 'contact.tags', op: 'contains', value: 'VIP' }, { field: 'contact.attributes.score', op: 'gte', value: 50 }], on_true: 'tag', on_false: null },
        { id: 'tag', type: 'update_contact', add_tags: ['nurtured'], remove_tags: ['vip'], set_attributes: { stage: 'customer', score: null }, next: 'check' },
        { id: 'check', type: 'condition', match: 'all', rules: [{ field: 'contact.tags', op: 'contains', value: 'nurtured' }, { field: 'run.opened', op: 'is_false' }, { field: 'contact.attributes.stage', op: 'in', value: 'lead, customer' }], on_true: 'done', on_false: null },
        { id: 'done', type: 'exit' },
      ],
    });
    const vip = uniq('vip');
    await seedContact(vip, { tags: ['vip'], attributes: { score: 80 } });
    const run = (await trigger(id, vip)).json().run_id;
    expect(await waitFor(() => runStatus(run), (r) => r.status === 'exited').then((r) => r.status)).toBe('exited');
    const contact = await db.selectFrom('audience_contacts').select(['tags', 'attributes']).where('email', '=', vip).executeTakeFirstOrThrow();
    expect(contact.tags).toEqual(['nurtured']);
    expect(contact.attributes).toEqual({ stage: 'customer' });

    const other = uniq('regular');
    await seedContact(other, { tags: ['vip'], attributes: { score: 10 } });
    const r2 = (await trigger(id, other)).json().run_id;
    expect(await waitFor(() => runStatus(r2), (r) => r.status === 'completed').then((r) => r.status)).toBe('completed');
  });

  it('screens entry: subscription requirement and entry rules', async () => {
    const id = await publish('entry-rules', {
      trigger: { type: 'api' },
      entry_step_id: 'done',
      steps: [{ id: 'done', type: 'exit' }],
      settings: { entry: { require_subscribed: true, match: 'all', rules: [{ field: 'contact.location', op: 'eq', value: 'Berlin' }] } },
    });
    const pending = uniq('pending');
    await seedContact(pending, { status: 'Pending', location: 'Berlin' });
    expect((await trigger(id, pending)).json().reason).toBe('not_subscribed');
    const london = uniq('london');
    await seedContact(london, { location: 'London' });
    expect((await trigger(id, london)).json().reason).toBe('entry_filtered');
    const berlin = uniq('berlin');
    await seedContact(berlin, { location: 'Berlin' });
    expect((await trigger(id, berlin)).statusCode).toBe(202);
  });
});

describe('time-aware waits and sending rules', () => {
  it('waits until one day before an appointment, and exits when the date already passed', async () => {
    const id = await publish('appointment-reminder', {
      trigger: { type: 'api' },
      entry_step_id: 'remind_at',
      steps: [
        { id: 'remind_at', type: 'wait_until', mode: 'field', field: 'context.appointment_at', offset_seconds: -86_400, if_missed: 'exit', next: 'send' },
        { id: 'send', type: 'send_email', template_id: templateId, from: `clinic@${domain}`, next: null },
      ],
      settings: { allow_reentry: true },
    });
    const at = new Date(Date.now() + 3 * 86_400_000);
    const patient = uniq('patient');
    const run = (await trigger(id, patient, { appointment_at: at.toISOString() })).json().run_id;
    const parked = await waitFor(() => runStatus(run), (r) => r.status === 'waiting_delay');
    expect(Math.abs(new Date(parked.wake_at as any).getTime() - (at.getTime() - 86_400_000))).toBeLessThan(2000);

    const late = (await trigger(id, uniq('late'), { appointment_at: new Date(Date.now() + 3_600_000).toISOString() })).json().run_id;
    expect((await waitFor(() => runStatus(late), (r) => r.status === 'exited')).status).toBe('exited');
  });

  it('continues at a local clock time in the contact time zone', async () => {
    const id = await publish('morning-send', {
      trigger: { type: 'api' },
      entry_step_id: 'at9',
      steps: [{ id: 'at9', type: 'wait_until', mode: 'time_of_day', time: '09:00', timezone: 'contact', next: null }],
    });
    const tokyo = uniq('tokyo');
    await seedContact(tokyo, { timezone: 'Asia/Tokyo' });
    const run = (await trigger(id, tokyo)).json().run_id;
    const parked = await waitFor(() => runStatus(run), (r) => r.status === 'waiting_delay');
    const wake = new Date(parked.wake_at as any);
    expect(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(wake)).toBe('09:00');
    expect(wake.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
  });

  it('holds email outside quiet hours and when the frequency cap is reached', async () => {
    const now = new Date(), hour = now.getUTCHours();
    // A one-hour window that is guaranteed not to include "now".
    const start = `${String((hour + 2) % 24).padStart(2, '0')}:00`, end = `${String((hour + 3) % 24).padStart(2, '0')}:00`;
    const quiet = await publish('quiet-hours', {
      trigger: { type: 'api' }, entry_step_id: 'send',
      steps: [{ id: 'send', type: 'send_email', template_id: templateId, from: `news@${domain}`, next: null }],
      settings: { send_window: { start, end, timezone: 'UTC' } },
    });
    const sleeper = uniq('sleeper');
    const run = (await trigger(quiet, sleeper)).json().run_id;
    const parked = await waitFor(() => runStatus(run), (r) => r.status === 'waiting_delay');
    expect(new Date(parked.wake_at as any).getUTCHours()).toBe((hour + 2) % 24);
    expect(await countMessagesTo(cust.customerId, sleeper)).toBe(0);

    const capped = await publish('capped', {
      trigger: { type: 'api' }, entry_step_id: 'send',
      steps: [{ id: 'send', type: 'send_email', template_id: templateId, from: `news@${domain}`, next: null }],
      settings: { frequency_cap: { max: 2, days: 7 } },
    });
    const busy = uniq('busy');
    for (let i = 0; i < 2; i++) {
      await db.insertInto('messages').values({ message_id: `<cap-${i}-${Date.now()}@${domain}>`, customer_id: cust.customerId, from_address: `news@${domain}`, to_address: busy, subject: 'x', status: 'delivered', ip_pool: 'marketing', headers: {}, tags: [], metadata: {} } as any).execute();
    }
    const r2 = (await trigger(capped, busy)).json().run_id;
    const held = await waitFor(() => runStatus(r2), (r) => r.status === 'waiting_delay');
    expect(new Date(held.wake_at as any).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(await countMessagesTo(cust.customerId, busy)).toBe(2);
  });

  it('notifies the team with rendered details', async () => {
    const id = await publish('lead-alert', {
      trigger: { type: 'api' }, entry_step_id: 'alert',
      steps: [{ id: 'alert', type: 'notify', to: [`sales@${domain}`], from: `alerts@${domain}`, subject: 'New lead: {{first_name}} at {{company}}', body: 'Score {{score}} — {{email}}', next: null }],
    });
    const lead = uniq('lead');
    await seedContact(lead, { company: 'Analytical Engines' });
    const run = (await trigger(id, lead, { score: 88 })).json().run_id;
    expect((await waitFor(() => runStatus(run), (r) => r.status === 'completed')).status).toBe('completed');
    const alert = await db.selectFrom('messages').select(['subject', 'text_body', 'tags']).where('customer_id', '=', cust.customerId).where('to_address', '=', `sales@${domain}`).orderBy('queued_at', 'desc').executeTakeFirstOrThrow();
    expect(alert.subject).toBe('New lead: Ada at Analytical Engines');
    expect(alert.text_body).toBe(`Score 88 — ${lead}`);
    expect(alert.tags).toContain('notify');
    expect(await countMessagesTo(cust.customerId, lead)).toBe(0);
  });
});

describe('list-join and date-based triggers', () => {
  it('enrolls contacts added to a list', async () => {
    const list = await db.insertInto('audience_collections').values({ customer_id: cust.customerId, kind: 'list', name: `Newsletter ${Date.now()}` }).returning('id').executeTakeFirstOrThrow();
    const id = await publish('welcome-series', { trigger: { type: 'audience', collection_id: list.id }, entry_step_id: 'wait', steps: [{ id: 'wait', type: 'delay', duration_seconds: 3600, next: null }] });
    const subscriber = uniq('subscriber');
    const runs = await db.transaction().execute((trx) => enrollAudienceWorkflows(cust.customerId, list.id, [subscriber], trx as any));
    expect(runs).toHaveLength(1);
    await kickWorkflowRun(runs[0]!, cust.customerId);
    const run = await waitFor(() => runStatus(runs[0]!), (r) => r.status === 'waiting_delay');
    expect(run.workflow_id).toBe(id);
    expect(run.trigger_source).toBe('audience');
  });

  it('enrolls birthdays once per local day', async () => {
    const id = await publish('birthday', {
      trigger: { type: 'date', field: 'contact.attributes.birthday', offset_days: 0, recurrence: 'yearly', hour: 0, timezone: 'UTC' },
      entry_step_id: 'wait', steps: [{ id: 'wait', type: 'delay', duration_seconds: 3600, next: null }],
      settings: { allow_reentry: true, reentry_cooldown_seconds: 300 * 86_400 },
    });
    const today = localDate(new Date(), 'UTC');
    const birthday = uniq('birthday'), notToday = uniq('later');
    await seedContact(birthday, { attributes: { birthday: `1990-${today.slice(5)}` } });
    await seedContact(notToday, { attributes: { birthday: '1990-01-01' === `1990-${today.slice(5)}` ? '1990-06-15' : '1990-01-01' } });
    await sweepDateTriggeredWorkflows(new Date());
    expect(await runsFor(id, birthday)).toHaveLength(1);
    expect(await runsFor(id, notToday)).toHaveLength(0);
    await sweepDateTriggeredWorkflows(new Date());
    expect(await runsFor(id, birthday)).toHaveLength(1);
  });
});

describe('builder documents for different industries run on the engine', () => {
  const node = (id: string, t: string, extra: Record<string, unknown> = {}) => ({ id, t, ...extra });
  const graph = (nodes: any[], edges: [string, string, string?][]) => ({ nodes: [{ id: 'trigger', t: 'trigger' }, ...nodes], edges: edges.map(([from, to, port], i) => ({ id: `e${i}`, from, to, port: port ?? 'out' })) });
  const ctx = () => ({ from: `hello@${domain}`, domains: [domain], templates: [templateId], workspaceTz: 'UTC' });

  it('healthcare: appointment confirmation, then a reminder one day before the visit', async () => {
    const definition = compileWorkflow({
      name: 'Appointment reminders', tkey: 'appt', tcfg: {}, settings: { reentry: 'every', goal: 'none', quiet: false, cap: false, entry: 'all' },
      graph: graph([node('confirm', 'email', { template: templateId, subject: 'See you soon, {{first_name}}' }), node('before', 'wait', { mode: 'date', field: 'context.appointment_at', direction: 'before', amount: 1, unit: 'days', ifMissed: 'exit' }), node('remind', 'email', { template: templateId })],
        [['trigger', 'confirm'], ['confirm', 'before'], ['before', 'remind']]),
    }, ctx());
    const id = await publish('clinic', definition);
    const patient = uniq('clinic');
    await seedContact(patient);
    const at = new Date(Date.now() + 4 * 86_400_000);
    await app.inject({ method: 'POST', url: '/v1/workflows/events', headers: authed(), payload: { event: 'appointment_booked', email: patient, data: { appointment_at: at.toISOString() } } });
    const [run] = await waitFor(() => runsFor(id, patient), (r) => r[0]?.status === 'waiting_delay');
    expect(Math.abs(new Date(run!.wake_at as any).getTime() - (at.getTime() - 86_400_000))).toBeLessThan(2000);
    const sent = await db.selectFrom('messages').select('subject').where('to_address', '=', patient).execute();
    expect(sent.map((m) => m.subject)).toEqual(['See you soon, Ada']);
  });

  it('e-commerce: abandoned checkout tags the shopper and alerts the team for big carts', async () => {
    const definition = compileWorkflow({
      name: 'Abandoned checkout', tkey: 'cart', tcfg: {}, settings: { reentry: '30d', goal: 'order', quiet: false, cap: false, entry: 'subscribed' },
      graph: graph([
        node('tag', 'update', { action: 'add_tag', value: 'cart-abandoner' }),
        node('big', 'branch', { rules: [{ field: 'context.cart_value', op: 'gte', value: '200' }] }),
        node('alert', 'notify', { to: `sales@${domain}`, subject: 'Big cart: {{email}}', msg: 'Cart worth {{cart_value}}' }),
        node('mail', 'email', { template: templateId }),
      ], [['trigger', 'tag'], ['tag', 'big'], ['big', 'alert', 'yes'], ['big', 'mail', 'no'], ['alert', 'mail']]),
    }, ctx());
    expect(definition.goal).toEqual({ event_type: 'custom:order_placed', exit_on_goal: true });
    const id = await publish('cart', definition);
    const shopper = uniq('shopper');
    await seedContact(shopper);
    await app.inject({ method: 'POST', url: '/v1/workflows/events', headers: authed(), payload: { event: 'checkout_abandoned', email: shopper, data: { cart_value: 250 } } });
    const [run] = await waitFor(() => runsFor(id, shopper), (r) => r[0]?.status === 'completed');
    expect(run!.status).toBe('completed');
    expect((await db.selectFrom('audience_contacts').select('tags').where('email', '=', shopper).executeTakeFirstOrThrow()).tags).toContain('cart-abandoner');
    const alert = await db.selectFrom('messages').select('text_body').where('to_address', '=', `sales@${domain}`).where('subject', '=', `Big cart: ${shopper}`).executeTakeFirstOrThrow();
    expect(alert.text_body).toBe('Cart worth 250');
    expect(await countMessagesTo(cust.customerId, shopper)).toBe(1);
  });
});
