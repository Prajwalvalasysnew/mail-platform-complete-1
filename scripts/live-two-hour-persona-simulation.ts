/**
 * Local-only, long-running customer-behaviour simulation.
 *
 * It creates isolated customers across plans/industries, sends real messages
 * through the normal API -> queue -> worker -> Mailpit route, and periodically
 * performs the kinds of reads a customer dashboard and application perform.
 * No external recipients, provider calls, or sender reputation are involved.
 *
 * Defaults: 120 minutes, 24 delivered messages/minute (2,880 total).
 * Example:
 *   $env:PERSONA_SIM_CONFIRM='1'; npx tsx scripts/live-two-hour-persona-simulation.ts
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import {
  closeDb,
  closeQueues,
  closeRedis,
  db,
  generateApiKeyV2,
} from '../packages/shared/src/index.js';

const apiBase = (process.env.PERSONA_SIM_API_BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const trackerBase = (process.env.PERSONA_SIM_TRACKER_BASE ?? 'http://localhost:4000').replace(/\/$/, '');
const mailpitBase = (process.env.PERSONA_SIM_MAILPIT_BASE ?? 'http://localhost:8025').replace(/\/$/, '');
const durationMinutes = positiveInt(process.env.PERSONA_SIM_DURATION_MINUTES, 120);
const sendsPerMinute = positiveInt(process.env.PERSONA_SIM_SENDS_PER_MINUTE, 24);
const runId = `persona-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

type Tier = 'free' | 'paid' | 'enterprise';
type PersonaSpec = {
  industry: string;
  tier: Tier;
  name: string;
  address: string;
  weight: number;
  kind: string;
};
type Persona = PersonaSpec & { customerId: string; domain: string; apiKey: string };

const specs: PersonaSpec[] = [
  { industry: 'saas', tier: 'paid', name: 'Northstar SaaS', address: '18 Market Street, Austin, TX 78701', weight: 4, kind: 'product update' },
  { industry: 'ecommerce', tier: 'paid', name: 'Acme Commerce', address: '40 Warehouse Lane, Columbus, OH 43215', weight: 5, kind: 'order update' },
  { industry: 'healthcare', tier: 'enterprise', name: 'Harbor Health', address: '220 Care Avenue, Boston, MA 02110', weight: 2, kind: 'appointment notice' },
  { industry: 'education', tier: 'enterprise', name: 'Summit Education', address: '70 Campus Drive, Madison, WI 53703', weight: 2, kind: 'course notification' },
  { industry: 'finance', tier: 'enterprise', name: 'Cedar Finance', address: '5 Exchange Plaza, New York, NY 10005', weight: 3, kind: 'account notice' },
  { industry: 'nonprofit', tier: 'free', name: 'Kindred Foundation', address: '12 Community Road, Portland, OR 97205', weight: 1, kind: 'volunteer update' },
  { industry: 'travel', tier: 'paid', name: 'Trailhead Travel', address: '90 Terminal Way, Denver, CO 80202', weight: 3, kind: 'itinerary update' },
  { industry: 'marketplace', tier: 'paid', name: 'Maker Market', address: '31 Artisan Square, Brooklyn, NY 11201', weight: 3, kind: 'seller notification' },
  { industry: 'developer_tools', tier: 'paid', name: 'Relay Developer Tools', address: '55 Code Street, Seattle, WA 98101', weight: 3, kind: 'build notification' },
  { industry: 'media', tier: 'enterprise', name: 'Beacon Media', address: '10 Studio Row, Los Angeles, CA 90028', weight: 2, kind: 'subscriber update' },
  { industry: 'logistics', tier: 'enterprise', name: 'Route Logistics', address: '85 Freight Drive, Chicago, IL 60606', weight: 3, kind: 'shipment update' },
  { industry: 'real_estate', tier: 'free', name: 'Hearth Realty', address: '28 Main Street, Raleigh, NC 27601', weight: 1, kind: 'listing update' },
];

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function local(url: string, label: string) {
  const host = new URL(url).hostname;
  assert(['localhost', '127.0.0.1', '::1'].includes(host), `Refusing non-local ${label}: ${host}`);
}
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function headers(apiKey: string) {
  return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
}
async function json(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { response, body };
}

async function seedPersona(spec: PersonaSpec, index: number): Promise<Persona> {
  const customerId = crypto.randomUUID();
  const slug = `${spec.industry}-${runId}-${index}`.replace(/[^a-z0-9-]/gi, '').toLowerCase();
  const domain = `${slug}.local.test`;
  const key = generateApiKeyV2('secret');
  const quota = spec.tier === 'free' ? 100 : spec.tier === 'paid' ? 50_000 : 1_000_000;
  await db.insertInto('customers').values({
    id: customerId,
    email: `${slug}@local.test`,
    name: spec.name,
    tier: spec.tier,
    daily_quota: quota,
    monthly_quota: quota * 30,
    status: 'active',
    billing_status: 'active',
    email_verified_at: new Date(),
    physical_address: spec.address,
  } as any).execute();
  await db.insertInto('api_keys').values({
    customer_id: customerId,
    name: `persona simulation ${runId}`,
    key_prefix: key.prefix,
    key_hash: key.hash,
    key_type: key.key_type,
    scopes: ['send', 'messages', 'domains', 'templates', 'suppressions', 'webhooks'],
    expires_at: new Date(Date.now() + (durationMinutes + 30) * 60_000),
  } as any).execute();
  await db.insertInto('sending_domains').values({
    customer_id: customerId,
    domain,
    dkim_selector: 'mail',
    dkim_public_key: 'persona-simulation-public-key',
    dkim_private_key: 'persona-simulation-private-key',
    verified_at: new Date(),
    dkim_verified: true,
    spf_verified: true,
    dmarc_verified: true,
  } as any).execute();
  return { ...spec, customerId, domain, apiKey: key.plaintext };
}

function pickPersona(personas: Persona[], sequence: number): Persona {
  const total = personas.reduce((sum, p) => sum + p.weight, 0);
  let needle = sequence % total;
  for (const persona of personas) {
    needle -= persona.weight;
    if (needle < 0) return persona;
  }
  return personas[0]!;
}

function subject(persona: Persona, sequence: number) {
  const topics = ['Welcome', 'Receipt', 'Status update', 'Action needed', 'Your weekly summary', 'Confirmation'];
  return `[PERSONA ${runId}] ${persona.industry.toUpperCase()} ${topics[sequence % topics.length]} #${sequence}`;
}

async function sendMessage(persona: Persona, sequence: number) {
  const payload = {
    from: `notifications@${persona.domain}`,
    to: `user-${sequence % 200}@${persona.industry}.simulated.local.test`,
    subject: subject(persona, sequence),
    text: `${persona.name}: this is a simulated ${persona.kind} for local reliability testing. Reference ${sequence}.`,
    html: `<p>${persona.name}: this is a simulated <strong>${persona.kind}</strong>.</p><p>Reference ${sequence}.</p><p><a href="https://example.test/${persona.industry}/${sequence}">View details</a></p>`,
    tags: ['persona-simulation', persona.industry, persona.tier, persona.kind.replaceAll(' ', '-')],
    tracking: { opens: true, clicks: true },
  };
  return json(`${apiBase}/v1/send`, {
    method: 'POST',
    headers: { ...headers(persona.apiKey), 'idempotency-key': `${runId}-${sequence}` },
    body: JSON.stringify(payload),
  });
}

async function dashboardActivity(persona: Persona, tick: number) {
  const paths = ['/v1/profile', '/v1/usage/quota', '/v1/messages?limit=20', '/v1/activity?limit=20', '/v1/domains', '/v1/templates'];
  const path = paths[tick % paths.length]!;
  const response = await fetch(`${apiBase}${path}`, { headers: { authorization: `Bearer ${persona.apiKey}` } });
  await response.body?.cancel();
  return response.status;
}

async function validTrackerActivity(persona: Persona) {
  const latest = await db
    .selectFrom('messages')
    .innerJoin('tracked_links', 'tracked_links.message_id', 'messages.message_id')
    .select(['messages.message_id', 'tracked_links.id'])
    .where('messages.customer_id', '=', persona.customerId)
    .orderBy('messages.accepted_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!latest) return;
  const encoded = Buffer.from(latest.message_id.replace(/[<>]/g, '')).toString('base64url');
  const [open, click] = await Promise.all([
    fetch(`${trackerBase}/o/${encoded}`),
    fetch(`${trackerBase}/c/${encoded}/${latest.id}`, { redirect: 'manual' }),
  ]);
  await open.body?.cancel();
  await click.body?.cancel();
}

async function snapshot(startedAt: number, attempted: number, accepted: number, rejected: number, dashboardErrors: number) {
  const [health, mailpit, delivered] = await Promise.all([
    json(`${apiBase}/health`),
    json(`${mailpitBase}/api/v1/messages?limit=1`),
    db.selectFrom('messages').select(db.fn.countAll<number>().as('count')).where('tags', '@>', JSON.stringify(['persona-simulation']) as any).executeTakeFirst(),
  ]);
  const mailpitCount = Number(mailpit.body?.total ?? mailpit.body?.messages?.length ?? 0);
  console.log(JSON.stringify({
    type: 'minute_snapshot', run_id: runId, elapsed_minutes: Number(((Date.now() - startedAt) / 60_000).toFixed(1)),
    attempted, accepted, rejected, dashboard_errors: dashboardErrors,
    api_health: health.response.status, message_rows: Number(delivered?.count ?? 0), mailpit_visible: mailpitCount,
    timestamp: new Date().toISOString(),
  }));
}

async function main() {
  assert(process.env.PERSONA_SIM_CONFIRM === '1', 'Set PERSONA_SIM_CONFIRM=1 to start the local simulation.');
  local(apiBase, 'API'); local(trackerBase, 'tracker'); local(mailpitBase, 'Mailpit');
  const dbHost = new URL(process.env.DATABASE_URL ?? '').hostname;
  assert(['localhost', '127.0.0.1', '::1'].includes(dbHost), `Refusing non-local database: ${dbHost}`);
  const personas = await Promise.all(specs.map(seedPersona));
  const startedAt = Date.now();
  const deadline = startedAt + durationMinutes * 60_000;
  const interval = Math.max(250, Math.floor(60_000 / sendsPerMinute));
  let attempted = 0, accepted = 0, rejected = 0, dashboardErrors = 0, trackerErrors = 0;
  let nextDashboard = startedAt, nextTracker = startedAt + 30_000, nextSnapshot = startedAt + 60_000;
  console.log(JSON.stringify({ type: 'started', run_id: runId, duration_minutes: durationMinutes, sends_per_minute: sendsPerMinute, target_messages: durationMinutes * sendsPerMinute, personas: personas.map(({ apiKey, ...p }) => p) }));

  while (Date.now() < deadline) {
    const sequence = attempted + 1;
    const persona = pickPersona(personas, sequence);
    const result = await sendMessage(persona, sequence);
    attempted++;
    if (result.response.status === 202) accepted++; else { rejected++; console.log(JSON.stringify({ type: 'send_rejected', sequence, industry: persona.industry, tier: persona.tier, status: result.response.status, body: result.body })); }

    const now = Date.now();
    if (now >= nextDashboard) {
      const reads = await Promise.all(personas.map((p, i) => dashboardActivity(p, attempted + i).catch(() => 0)));
      dashboardErrors += reads.filter((status) => status < 200 || status >= 400).length;
      nextDashboard = now + 20_000;
    }
    if (now >= nextTracker) {
      try { await validTrackerActivity(persona); } catch { trackerErrors++; }
      nextTracker = now + 30_000;
    }
    if (now >= nextSnapshot) {
      await snapshot(startedAt, attempted, accepted, rejected, dashboardErrors);
      nextSnapshot = now + 60_000;
    }
    const wait = interval - (Date.now() - now);
    if (wait > 0) await sleep(wait);
  }
  await snapshot(startedAt, attempted, accepted, rejected, dashboardErrors);
  console.log(JSON.stringify({ type: 'completed', run_id: runId, attempted, accepted, rejected, dashboard_errors: dashboardErrors, tracker_errors: trackerErrors, timestamp: new Date().toISOString() }));
}

main()
  .finally(() => Promise.all([closeQueues(), closeRedis(), closeDb()]))
  .catch((error) => { console.error(error); process.exitCode = 1; });
