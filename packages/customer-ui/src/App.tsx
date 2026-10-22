import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { useAuth } from './auth';
import { AIAgentPage, AudienceGroupsPage, CampaignsPage, ContactsPage, EmailBuilderPage, EventLogsPage, HelpPage, WorkflowBuilderPage } from './design-pages';

const NAV = [
  { section: 'Main', items: [
    ['/', 'Home', '⌂'], ['/ai-agent', 'AI agent', '✦'], ['/messages', 'Messages', '✉'], ['/contacts', 'Contacts', '♙'], ['/segments', 'Segments', '◌'], ['/lists', 'Lists', '≡'],
  ] },
  { section: 'Messaging', items: [
    ['/campaigns', 'Campaigns', '◈'], ['/automations', 'Automations', '⌘'], ['/templates', 'Templates', '▧'], ['/analytics', 'Analytics', '⌁'], ['/deliverability', 'Deliverability', '✓'],
  ] },
  { section: 'Developers', items: [
    ['/api-keys', 'API keys', '⌑'], ['/webhooks', 'Webhooks', '↗'], ['/event-logs', 'Event logs', '☷'], ['/domains', 'Domains', '◎'],
  ] },
  { section: 'Account', items: [
    ['/team', 'Team', '♧'], ['/billing', 'Billing', '◇'], ['/settings', 'Settings', '⚙'], ['/help', 'Help & docs', '?'],
  ] },
] as const;

const TITLES = Object.fromEntries(NAV.flatMap((group) => group.items.map(([path, label]) => [path, label])));

function message(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'insufficient_role') return 'Your role does not allow this action.';
    if (error.code === 'validation_failed') return 'Check the information and try again.';
    return error.message || error.code;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function AuthScreen() {
  const { status, login, register, confirmMfa } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      if (status === 'mfa') await confirmMfa(String(form.get('code') ?? ''));
      else if (mode === 'login') await login(String(form.get('email')), String(form.get('password')));
      else await register({
        email: String(form.get('email')), password: String(form.get('password')),
        name: String(form.get('name')), org_name: String(form.get('org_name')),
      });
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story" aria-label="Valasys Mail introduction">
        <div className="brand brand-light"><span className="brand-mark">V</span><strong>Valasys</strong></div>
        <div className="auth-copy">
          <span className="eyebrow light">EMAIL OPERATIONS, SIMPLIFIED</span>
          <h1>Send with confidence.<br />Understand every result.</h1>
          <p>Transactional email, customer journeys, deliverability insights, and developer tools in one focused workspace.</p>
          <div className="auth-proof"><span>✓ Verified sending domains</span><span>✓ Real-time event visibility</span><span>✓ Built for teams</span></div>
        </div>
        <small>© 2026 Valasys · Privacy · Terms</small>
      </section>
      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="brand mobile-brand"><span className="brand-mark">V</span><strong>Valasys</strong></div>
          {status === 'mfa' ? <>
            <span className="eyebrow">SECURE SIGN IN</span><h2>Enter your verification code</h2>
            <p className="muted">Use your authenticator app to finish signing in.</p>
            <Field label="Authentication code" name="code" autoComplete="one-time-code" required autoFocus />
          </> : <>
            <span className="eyebrow">{mode === 'login' ? 'WELCOME BACK' : 'START SENDING'}</span>
            <h2>{mode === 'login' ? 'Sign in to Valasys' : 'Create your account'}</h2>
            <p className="muted">{mode === 'login' ? 'Continue to your email workspace.' : 'Set up your team workspace in a few steps.'}</p>
            {mode === 'register' && <div className="form-row"><Field label="Full name" name="name" required /><Field label="Company" name="org_name" required /></div>}
            <Field label="Work email" name="email" type="email" autoComplete="email" required />
            <Field label="Password" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} required />
          </>}
          {error && <div className="alert error" role="alert">{error}</div>}
          <button className="button primary block" disabled={busy}>{busy ? 'Please wait…' : status === 'mfa' ? 'Verify' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
          {status !== 'mfa' && <button type="button" className="text-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
            {mode === 'login' ? 'New to Valasys? Create an account' : 'Already have an account? Sign in'}
          </button>}
        </form>
      </section>
    </main>
  );
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className="field"><span>{label}</span><input {...props} /></label>;
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => { const update = () => setPath(window.location.pathname); window.addEventListener('popstate', update); return () => window.removeEventListener('popstate', update); }, []);
  const go = (next: string) => { window.history.pushState(null, '', next); setPath(next); };
  return [path, go] as const;
}

function Shell() {
  const { identity, logout, switchOrg } = useAuth();
  const [path, go] = usePath();
  const [mobileNav, setMobileNav] = useState(false);
  const currentOrg = identity?.memberships.find((m) => m.customer_id === identity.current_customer_id);
  const name = identity?.user.name || identity?.user.email.split('@')[0] || 'User';
  return <div className="app-shell">
    <aside className={`sidebar${mobileNav ? ' open' : ''}`}>
      <div className="brand sidebar-brand"><span className="brand-mark">V</span><strong>Valasys</strong><button className="nav-close" onClick={() => setMobileNav(false)} aria-label="Close navigation">×</button></div>
      <div className="workspace-switcher">
        <span className="workspace-avatar">{(currentOrg?.org_name || currentOrg?.customer_name || 'A').slice(0, 1).toUpperCase()}</span>
        <label><span>Workspace</span><select value={identity?.current_customer_id ?? ''} onChange={(e) => void switchOrg(e.target.value)}>
          {identity?.memberships.map((membership) => <option key={membership.customer_id} value={membership.customer_id}>{membership.org_name || membership.customer_name || 'Workspace'}</option>)}
        </select></label>
      </div>
      <nav aria-label="Primary navigation">
        {NAV.map((group) => <div className="nav-group" key={group.section}><div className="nav-label">{group.section}</div>
          {group.items.map(([href, label, icon]) => <button key={href} className={`nav-item${path === href ? ' active' : ''}`} onClick={() => { go(href); setMobileNav(false); }}><span className="nav-icon">{icon}</span>{label}</button>)}
        </div>)}
      </nav>
      <div className="sidebar-foot"><div className="plan-line"><span><b>Pro workspace</b><small>42% monthly volume</small></span><span className="status-dot" /></div><div className="progress"><i /></div></div>
    </aside>
    {mobileNav && <button className="scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <section className="main-column">
      <header className="topbar"><button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation">☰</button><div><span className="breadcrumb">Valasys /</span><strong>{TITLES[path] ?? 'Workspace'}</strong></div><div className="top-actions"><button className="icon-button" title="Notifications">♢</button><span className="user-avatar">{name.slice(0, 2).toUpperCase()}</span><span className="user-copy"><b>{name}</b><small>{identity?.current_role || 'member'}</small></span><button className="text-button compact" onClick={() => void logout()}>Sign out</button></div></header>
      <main className="page"><Page path={path} go={go} /></main>
    </section>
  </div>;
}

function Page({ path, go }: { path: string; go(path: string): void }) {
  if (path === '/') return <Dashboard go={go} />;
  if (path === '/domains') return <Domains />;
  if (path === '/api-keys') return <ApiKeys />;
  if (path === '/webhooks') return <Webhooks />;
  if (path === '/team') return <Team />;
  if (path === '/billing') return <Billing />;
  if (path === '/analytics') return <Analytics />;
  if (path === '/messages') return <Messages />;
  if (path === '/deliverability') return <Deliverability />;
  if (path === '/templates') return <Templates go={go} />;
  if (path === '/automations') return <Automations go={go} />;
  if (path === '/settings') return <Settings />;
  if (path === '/campaigns') return <CampaignsPage go={go} />;
  if (path === '/contacts') return <ContactsPage />;
  if (path === '/segments') return <AudienceGroupsPage kind="Segments" />;
  if (path === '/lists') return <AudienceGroupsPage kind="Lists" />;
  if (path === '/event-logs') return <EventLogsPage />;
  if (path === '/help') return <HelpPage />;
  if (path === '/ai-agent') return <AIAgentPage go={go} />;
  if (path === '/email-builder') return <EmailBuilderPage go={go} />;
  if (path === '/workflow-builder') return <WorkflowBuilderPage go={go} />;
  const missingBackend = false;
  return <FeaturePlaceholder title={TITLES[path] ?? 'Page not found'} backendMissing={missingBackend} />;
}

function Dashboard({ go }: { go(path: string): void }) {
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains });
  const keys = useQuery({ queryKey: ['keys'], queryFn: api.keys });
  const webhooks = useQuery({ queryKey: ['webhooks'], queryFn: api.webhooks });
  const counts = [domains.data?.domains.length ?? '—', keys.data?.keys.length ?? '—', webhooks.data?.webhooks.length ?? '—'];
  return <>
    <PageHeader eyebrow="SENDING OVERVIEW" title="Good afternoon" description="Your workspace setup and sending infrastructure at a glance." action={<button className="button primary" onClick={() => go('/api-keys')}>Create API key</button>} />
    <div className="setup-banner"><div className="setup-icon">↗</div><div><b>Finish setting up Valasys</b><p>Add a sending domain and create an API key before your first production send.</p></div><button className="button" onClick={() => go('/domains')}>Continue setup</button></div>
    <div className="metric-grid">
      <Metric label="Sending domains" value={counts[0]} caption="Configured domains" tone="red" />
      <Metric label="API keys" value={counts[1]} caption="Active credentials" tone="violet" />
      <Metric label="Webhooks" value={counts[2]} caption="Event destinations" tone="green" />
      <Metric label="Account health" value="Ready" caption="Core API connected" tone="amber" />
    </div>
    <div className="dashboard-grid">
      <Card title="Start sending" subtitle="Complete the essentials for reliable delivery."><Checklist items={[
        ['Verify a sending domain', Boolean(domains.data?.domains.length), '/domains'], ['Create an API key', Boolean(keys.data?.keys.length), '/api-keys'], ['Configure event webhooks', Boolean(webhooks.data?.webhooks.length), '/webhooks'],
      ]} go={go} /></Card>
      <Card title="Recent campaigns" subtitle="Campaign data will appear after the campaign service is enabled."><Empty icon="◈" title="No campaigns yet" copy="Campaigns and audiences are being connected as the next backend phase." /></Card>
    </div>
  </>;
}

function Domains() {
  const queryClient = useQueryClient(); const query = useQuery({ queryKey: ['domains'], queryFn: api.domains });
  const [domain, setDomain] = useState(''); const [notice, setNotice] = useState('');
  const create = useMutation({ mutationFn: api.createDomain, onSuccess: async () => { setDomain(''); setNotice('Domain added. Publish the DNS records, then verify it.'); await queryClient.invalidateQueries({ queryKey: ['domains'] }); } });
  const verify = useMutation({ mutationFn: api.verifyDomain, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['domains'] }); } });
  const remove = useMutation({ mutationFn: api.deleteDomain, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['domains'] }); } });
  return <><PageHeader eyebrow="DEVELOPER" title="Sending domains" description="Authenticate your domains with SPF and DKIM before sending." />
    <Card><form className="inline-form" onSubmit={(e) => { e.preventDefault(); create.mutate(domain); }}><Field label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="mail.example.com" required /><button className="button primary" disabled={create.isPending}>Add domain</button></form>{notice && <div className="alert success">{notice}</div>}{create.error && <div className="alert error">{message(create.error)}</div>}</Card>
    <DataTable headers={['Domain', 'Status', 'DKIM selector', 'Actions']} loading={query.isLoading} error={query.error} empty="No sending domains configured.">{query.data?.domains.map((row) => <tr key={row.id}><td><b>{row.domain}</b></td><td><Status value={row.status || (row.verified_at ? 'verified' : 'pending')} /></td><td className="mono">{row.dkim_selector || 'default'}</td><td className="actions"><button className="button small" onClick={() => verify.mutate(row.id)}>Verify</button><button className="button small danger" onClick={() => remove.mutate(row.id)}>Delete</button></td></tr>)}</DataTable>
  </>;
}

function ApiKeys() {
  const queryClient = useQueryClient(); const query = useQuery({ queryKey: ['keys'], queryFn: api.keys });
  const [name, setName] = useState(''); const [secret, setSecret] = useState('');
  const create = useMutation({ mutationFn: api.createKey, onSuccess: async (row) => { setName(''); setSecret(row.api_key || ''); await queryClient.invalidateQueries({ queryKey: ['keys'] }); } });
  const remove = useMutation({ mutationFn: api.deleteKey, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['keys'] }); } });
  return <><PageHeader eyebrow="DEVELOPER" title="API keys" description="Create scoped credentials for applications that send through Valasys." />
    {secret && <div className="secret-banner"><div><b>Save this key now</b><p>For security, it will not be shown again.</p><code>{secret}</code></div><button className="button" onClick={() => void navigator.clipboard.writeText(secret)}>Copy</button></div>}
    <Card><form className="inline-form" onSubmit={(e) => { e.preventDefault(); create.mutate(name); }}><Field label="Key name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production app" required /><button className="button primary" disabled={create.isPending}>Create key</button></form>{create.error && <div className="alert error">{message(create.error)}</div>}</Card>
    <DataTable headers={['Name', 'Prefix', 'Environment', 'Last used', 'Actions']} loading={query.isLoading} error={query.error} empty="No API keys yet.">{query.data?.keys.map((row) => <tr key={row.id}><td><b>{row.name}</b></td><td className="mono">{row.key_prefix || row.prefix || '—'}…</td><td><Status value={row.key_type || 'secret'} /></td><td>{row.last_used_at ? new Date(row.last_used_at).toLocaleString() : 'Never'}</td><td><button className="button small danger" onClick={() => remove.mutate(row.id)}>Revoke</button></td></tr>)}</DataTable>
  </>;
}

function Webhooks() {
  const queryClient = useQueryClient(); const query = useQuery({ queryKey: ['webhooks'], queryFn: api.webhooks });
  const [url, setUrl] = useState(''); const [secret, setSecret] = useState('');
  const create = useMutation({ mutationFn: api.createWebhook, onSuccess: async (row) => { setUrl(''); setSecret(row.secret || ''); await queryClient.invalidateQueries({ queryKey: ['webhooks'] }); } });
  const update = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateWebhook(id, { enabled }), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['webhooks'] }); } });
  const rotate = useMutation({ mutationFn: api.rotateWebhookSecret, onSuccess: async (row) => { setSecret(row.secret || ''); await queryClient.invalidateQueries({ queryKey: ['webhooks'] }); } });
  const remove = useMutation({ mutationFn: api.deleteWebhook, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['webhooks'] }); } });
  return <><PageHeader eyebrow="DEVELOPER" title="Webhooks" description="Receive signed delivery and engagement events at your endpoint." />
    {secret && <div className="secret-banner"><div><b>Signing secret</b><p>Store it securely. It is shown only once.</p><code>{secret}</code></div><button className="button" onClick={() => void navigator.clipboard.writeText(secret)}>Copy</button></div>}
    <Card><form className="inline-form" onSubmit={(e) => { e.preventDefault(); create.mutate(url); }}><Field label="Endpoint URL" value={url} onChange={(e) => setUrl(e.target.value)} type="url" placeholder="https://example.com/webhooks/valasys" required /><button className="button primary" disabled={create.isPending}>Add endpoint</button></form>{create.error && <div className="alert error">{message(create.error)}</div>}</Card>
    <DataTable headers={['Endpoint', 'Events', 'Status', 'Actions']} loading={query.isLoading} error={query.error} empty="No webhook endpoints configured.">{query.data?.webhooks.map((row) => <tr key={row.id}><td className="mono">{row.url}</td><td>{Array.isArray(row.events) ? row.events.join(', ') : '—'}</td><td><Status value={row.enabled === false ? 'disabled' : 'active'} /></td><td><div className="actions"><button className="button small" onClick={() => update.mutate({ id: row.id, enabled: row.enabled === false })}>{row.enabled === false ? 'Enable' : 'Pause'}</button><button className="button small" onClick={() => rotate.mutate(row.id)}>Rotate secret</button><button className="button small danger" onClick={() => remove.mutate(row.id)}>Delete</button></div></td></tr>)}</DataTable>
  </>;
}

function Team() {
  const query = useQuery({ queryKey: ['team'], queryFn: api.team });
  return <><PageHeader eyebrow="ACCOUNT" title="Team" description="People with access to this workspace and their roles." />
    <DataTable headers={['Member', 'Role', 'Status']} loading={query.isLoading} error={query.error} empty="No team members found.">{query.data?.members.map((row) => <tr key={row.user_id || row.id}><td><b>{row.name || row.email}</b><div className="muted small-copy">{row.name ? row.email : ''}</div></td><td>{row.role}</td><td><Status value={row.status || 'active'} /></td></tr>)}</DataTable>
  </>;
}

function Billing() {
  const query = useQuery({ queryKey: ['billing'], queryFn: api.billing });
  const data = query.data;
  return <><PageHeader eyebrow="ACCOUNT" title="Billing" description="Plan, usage allowance, and subscription status." />
    {query.error ? <div className="alert error">{message(query.error)}</div> : <div className="metric-grid"><Metric label="Current plan" value={data?.plan?.name || data?.plan || '—'} caption="Workspace subscription" tone="red" /><Metric label="Status" value={data?.status || data?.billing_status || '—'} caption="Billing state" tone="green" /><Metric label="Monthly quota" value={data?.monthly_quota?.toLocaleString?.() || data?.quota?.toLocaleString?.() || '—'} caption="Included messages" tone="violet" /></div>}
  </>;
}

function Analytics() {
  const [period, setPeriod] = useState('7d');
  const query = useQuery({ queryKey: ['analytics', period], queryFn: () => api.analytics(period) });
  const data = query.data;
  const pct = (value?: number) => `${((value ?? 0) * 100).toFixed(1)}%`;
  return <><PageHeader eyebrow="WORKSPACE" title="Analytics" description="Live delivery and engagement performance from your message events." action={<select className="select-control" value={period} onChange={(e) => setPeriod(e.target.value)}><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select>} />
    {query.error ? <div className="alert error">{message(query.error)}</div> : <div className="metric-grid"><Metric label="Sent" value={data?.sent?.toLocaleString?.() ?? '—'} caption="Queued messages" tone="red" /><Metric label="Delivered" value={data?.delivered?.toLocaleString?.() ?? '—'} caption={`${pct(data?.delivery_rate)} delivery rate`} tone="green" /><Metric label="Opened" value={data?.opened?.toLocaleString?.() ?? '—'} caption={`${pct(data?.open_rate)} open rate`} tone="violet" /><Metric label="Clicked" value={data?.clicked?.toLocaleString?.() ?? '—'} caption={`${pct(data?.click_rate)} click rate`} tone="amber" /></div>}
  </>;
}

function Messages() {
  const query = useQuery({ queryKey: ['messages'], queryFn: api.messages });
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['message', selected], queryFn: () => api.message(selected!), enabled: Boolean(selected) });
  return <><PageHeader eyebrow="WORKSPACE" title="Messages" description="Live transactional message history for this workspace." />
    <DataTable headers={['Recipient', 'Subject', 'Status', 'Queued', '']} loading={query.isLoading} error={query.error} empty="No messages have been sent yet.">{query.data?.messages.map((row) => <tr key={row.message_id}><td>{row.to_address}</td><td><b>{row.subject || '(no subject)'}</b><div className="muted small-copy">{row.from_address}</div></td><td><Status value={row.status || 'queued'} /></td><td>{row.queued_at ? new Date(row.queued_at).toLocaleString() : '—'}</td><td><button className="button small" onClick={() => setSelected(row.message_id)}>View</button></td></tr>)}</DataTable>
    {selected && <div className="drawer-backdrop" onClick={() => setSelected(null)}><aside className="detail-drawer" onClick={(e) => e.stopPropagation()}><header><div><span className="eyebrow">MESSAGE DETAIL</span><h2>{detail.data?.message.subject || 'Loading…'}</h2></div><button className="icon-button" onClick={() => setSelected(null)}>×</button></header>{detail.isLoading ? <div className="table-message">Loading…</div> : detail.error ? <div className="alert error">{message(detail.error)}</div> : <><dl className="detail-list"><div><dt>ID</dt><dd className="mono">{selected}</dd></div><div><dt>From</dt><dd>{detail.data?.message.from_address}</dd></div><div><dt>To</dt><dd>{detail.data?.message.to_address}</dd></div><div><dt>Status</dt><dd><Status value={detail.data?.message.status || 'queued'} /></dd></div></dl><h3>Event timeline</h3><div className="timeline">{detail.data?.events.length ? detail.data.events.map((event: any, index: number) => <div className="timeline-item" key={index}><i /><div><b>{event.event_type}</b><small>{event.occurred_at ? new Date(event.occurred_at).toLocaleString() : '—'}</small></div></div>) : <p className="muted">No events recorded yet.</p>}</div></>}</aside></div>}
  </>;
}

function Deliverability() {
  const [tab, setTab] = useState('Overview');
  const queryClient = useQueryClient();
  const summary = useQuery({ queryKey: ['dmarc-summary'], queryFn: api.dmarcSummary });
  const sources = useQuery({ queryKey: ['dmarc-sources'], queryFn: api.dmarcSources });
  const address = useQuery({ queryKey: ['dmarc-address'], queryFn: api.dmarcAddress });
  const suppressions = useQuery({ queryKey: ['suppressions'], queryFn: api.suppressions, enabled: tab === 'Suppressions' });
  const [suppressedEmail, setSuppressedEmail] = useState('');
  const addSuppression = useMutation({ mutationFn: (email: string) => api.addSuppression(email), onSuccess: async () => { setSuppressedEmail(''); await queryClient.invalidateQueries({ queryKey: ['suppressions'] }); } });
  const removeSuppression = useMutation({ mutationFn: api.deleteSuppression, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['suppressions'] }); } });
  const data = summary.data;
  return <><PageHeader eyebrow="WORKSPACE" title="Deliverability" description="Authentication, reputation, inbox placement, suppressions, and compliance." />
    <div className="settings-tabs">{['Overview','Domains & DNS','Inbox placement','Reputation','Suppressions','Compliance'].map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
    {tab === 'Overview' && <>{summary.error || address.error ? <div className="alert error">{message(summary.error || address.error)}</div> : <><div className="metric-grid"><Metric label="Messages observed" value={data?.total_messages?.toLocaleString?.() ?? data?.total?.toLocaleString?.() ?? 0} caption="Last 30 days" tone="red" /><Metric label="DMARC passed" value={data?.passed?.toLocaleString?.() ?? data?.pass_count?.toLocaleString?.() ?? 0} caption="Aligned messages" tone="green" /><Metric label="DMARC failed" value={data?.failed?.toLocaleString?.() ?? data?.fail_count?.toLocaleString?.() ?? 0} caption="Needs attention" tone="amber" /></div><Card title="DMARC reporting address" subtitle="Add this address to the rua value in your DMARC TXT record."><code className="code-block">{address.data?.rua_address || 'Loading…'}</code>{address.data?.dns_hint && <p className="muted mono">{address.data.dns_hint}</p>}</Card></>}<DataTable headers={['Source', 'Domain', 'Messages', 'Disposition']} loading={sources.isLoading} error={sources.error} empty="No DMARC reports received yet.">{sources.data?.sources.map((row, index) => <tr key={`${row.source_ip || row.ip || 'source'}-${index}`}><td className="mono">{row.source_ip || row.ip || row.source || '—'}</td><td>{row.domain || row.header_from || '—'}</td><td>{row.count ?? row.messages ?? 0}</td><td><Status value={row.disposition || (row.dmarc_pass ? 'passed' : 'observed')} /></td></tr>)}</DataTable></>}
    {tab === 'Domains & DNS' && <Domains />}
    {tab === 'Inbox placement' && <div className="dashboard-grid"><Card title="Inbox placement" subtitle="Seed-test readiness across major mailbox providers."><Empty icon="◎" title="No placement test yet" copy="Send a seed test after your sending domain is verified." /><button className="button primary">Create test</button></Card><Card title="Provider coverage"><Checklist items={[["Gmail",false,'/deliverability'],["Microsoft",false,'/deliverability'],["Yahoo",false,'/deliverability']]} go={() => undefined} /></Card></div>}
    {tab === 'Reputation' && <div className="metric-grid"><Metric label="Sender score" value="—" caption="Available after sending" tone="green" /><Metric label="Bounce rate" value="—" caption="Last 30 days" tone="amber" /><Metric label="Complaint rate" value="—" caption="Last 30 days" tone="red" /></div>}
    {tab === 'Suppressions' && <><Card><form className="inline-form" onSubmit={(e) => { e.preventDefault(); addSuppression.mutate(suppressedEmail); }}><Field label="Email address" type="email" value={suppressedEmail} onChange={(e) => setSuppressedEmail(e.target.value)} required /><button className="button primary" disabled={addSuppression.isPending}>Suppress</button></form>{addSuppression.error && <div className="alert error">{message(addSuppression.error)}</div>}</Card><DataTable headers={['Email','Reason','Added','Actions']} loading={suppressions.isLoading} error={suppressions.error} empty="No suppressed recipients.">{suppressions.data?.suppressions.map((row) => <tr key={row.email}><td>{row.email}</td><td><Status value={row.reason} /></td><td>{row.created_at ? new Date(row.created_at).toLocaleString() : '—'}</td><td><button className="button small danger" onClick={() => removeSuppression.mutate(row.email)}>Remove</button></td></tr>)}</DataTable></>}
    {tab === 'Compliance' && <div className="dashboard-grid"><Card title="Consent & unsubscribe"><Checklist items={[["One-click unsubscribe",true,'/settings'],["Suppression enforcement",true,'/deliverability'],["Consent history",true,'/deliverability']]} go={() => undefined} /></Card><Card title="Recommended controls" subtitle="Operational safeguards for compliant sending."><p className="muted">Keep sender identity accurate, retain consent evidence, honor opt-outs immediately, and review complaint rates before each campaign.</p></Card></div>}
  </>;
}

function Templates({ go }: { go(path: string): void }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['templates'], queryFn: api.templates });
  const [form, setForm] = useState({ name: '', subject: '', text_body: '' });
  const create = useMutation({ mutationFn: api.createTemplate, onSuccess: async () => { setForm({ name: '', subject: '', text_body: '' }); await queryClient.invalidateQueries({ queryKey: ['templates'] }); } });
  const remove = useMutation({ mutationFn: api.deleteTemplate, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['templates'] }); } });
  return <><PageHeader eyebrow="ENGAGE" title="Templates" description="Reusable, validated message content stored in the platform." action={<button className="button primary" onClick={() => go('/email-builder')}>Open email builder</button>} />
    <Card><form className="stack-form" onSubmit={(e) => { e.preventDefault(); create.mutate(form); }}><div className="form-row"><Field label="Template name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /><Field label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required /></div><label className="field"><span>Text body</span><textarea value={form.text_body} onChange={(e) => setForm({ ...form, text_body: e.target.value })} rows={5} placeholder="Hello {{name}}," required /></label><button className="button primary" disabled={create.isPending}>Create template</button>{create.error && <div className="alert error">{message(create.error)}</div>}</form></Card>
    <DataTable headers={['Name', 'Subject', 'Updated', 'Actions']} loading={query.isLoading} error={query.error} empty="No templates yet.">{query.data?.templates.map((row) => <tr key={row.id}><td><b>{row.name}</b></td><td>{row.subject}</td><td>{row.updated_at ? new Date(row.updated_at).toLocaleString() : '—'}</td><td><button className="button small danger" onClick={() => remove.mutate(row.id)}>Delete</button></td></tr>)}</DataTable>
  </>;
}

function Automations({ go }: { go(path: string): void }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['workflows'], queryFn: api.workflows });
  const [name, setName] = useState(''); const [description, setDescription] = useState('');
  const create = useMutation({ mutationFn: api.createWorkflow, onSuccess: async () => { setName(''); setDescription(''); await queryClient.invalidateQueries({ queryKey: ['workflows'] }); } });
  const remove = useMutation({ mutationFn: api.deleteWorkflow, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['workflows'] }); } });
  return <><PageHeader eyebrow="ENGAGE" title="Automations" description="Create workflow drafts backed by the platform workflow engine." action={<button className="button primary" onClick={() => go('/workflow-builder')}>Open workflow builder</button>} />
    <Card><form className="inline-form" onSubmit={(e) => { e.preventDefault(); create.mutate({ name, description }); }}><Field label="Workflow name" value={name} onChange={(e) => setName(e.target.value)} required /><Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} /><button className="button primary" disabled={create.isPending}>Create draft</button></form>{create.error && <div className="alert error">{message(create.error)}</div>}</Card>
    <DataTable headers={['Workflow', 'Status', 'Runs', 'Updated', 'Actions']} loading={query.isLoading} error={query.error} empty="No automations yet.">{query.data?.workflows.map((row) => <tr key={row.id}><td><b>{row.name}</b><div className="muted small-copy">{row.description}</div></td><td><Status value={row.status || 'draft'} /></td><td>{row.active_runs ?? 0} active / {row.total_runs ?? 0} total</td><td>{row.updated_at ? new Date(row.updated_at).toLocaleString() : '—'}</td><td><button className="button small danger" onClick={() => remove.mutate(row.id)}>Archive</button></td></tr>)}</DataTable>
  </>;
}

function Settings() {
  const { identity } = useAuth(); const queryClient = useQueryClient();
  const [tab, setTab] = useState('General');
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
  const sso = useQuery({ queryKey: ['sso'], queryFn: api.sso });
  const updateSso = useMutation({ mutationFn: api.setSso, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['sso'] }); } });
  const revoke = useMutation({ mutationFn: api.revokeSession, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['sessions'] }); } });
  const tabs = ['General','Sending','Team','Security','Privacy','Billing','Notifications'];
  return <><PageHeader eyebrow="ACCOUNT" title="Settings" description="Workspace, sending domains, team, security, privacy and billing." />
    <div className="settings-tabs">{tabs.map((item) => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{item}</button>)}</div>
    {tab === 'General' && <div className="dashboard-grid"><Card title="Workspace" subtitle="Identity shown across Valasys"><div className="stack-form"><Field label="Workspace name" defaultValue={identity?.memberships.find((m) => m.customer_id === identity.current_customer_id)?.org_name || 'Workspace'} /><Field label="Default time zone" defaultValue="Asia/Calcutta" /><button className="button primary">Save changes</button></div></Card><Card title="Profile" subtitle="Signed-in account"><dl className="detail-list"><div><dt>Name</dt><dd>{identity?.user.name || '—'}</dd></div><div><dt>Email</dt><dd>{identity?.user.email}</dd></div><div><dt>Role</dt><dd>{identity?.current_role}</dd></div></dl></Card></div>}
    {tab === 'Sending' && <><Card title="Default sender" subtitle="Used when a campaign or API call does not set its own."><div className="form-row"><Field label="From name" defaultValue="Valasys" /><Field label="From email" defaultValue="hello@example.com" /></div></Card><Domains /></>}
    {tab === 'Team' && <Team />}
    {tab === 'Security' && <><div className="dashboard-grid"><Card title="Organization security" subtitle="Enterprise sign-in policy"><label className="toggle-line"><span><b>Require SSO</b><small>Enforce your configured identity provider.</small></span><input type="checkbox" checked={Boolean(sso.data?.sso_enforced)} disabled={sso.isLoading || updateSso.isPending} onChange={(e) => updateSso.mutate(e.target.checked)} /></label>{(sso.error || updateSso.error) && <div className="alert error">{message(sso.error || updateSso.error)}</div>}</Card><Card title="Multi-factor authentication"><dl className="detail-list"><div><dt>Status</dt><dd><Status value={identity?.user.mfa_enabled ? 'enabled' : 'not enabled'} /></dd></div><div><dt>Method</dt><dd>Authenticator app</dd></div></dl></Card></div><DataTable headers={['Device', 'IP address', 'Created', 'Actions']} loading={sessions.isLoading} error={sessions.error} empty="No active sessions found.">{sessions.data?.sessions.map((row) => <tr key={row.id}><td>{row.user_agent || 'Unknown device'}</td><td className="mono">{row.ip || '—'}</td><td>{row.created_at ? new Date(row.created_at).toLocaleString() : '—'}</td><td><button className="button small danger" onClick={() => revoke.mutate(row.id)}>Sign out</button></td></tr>)}</DataTable></>}
    {tab === 'Privacy' && <div className="dashboard-grid"><Card title="Data residency & retention" subtitle="Control where workspace data is stored."><dl className="detail-list"><div><dt>Region</dt><dd>United States</dd></div><div><dt>Events</dt><dd>30 days</dd></div><div><dt>Messages</dt><dd>90 days</dd></div></dl></Card><Card title="Privacy requests" subtitle="GDPR and CCPA access or deletion requests."><p className="muted">Export your own account data or start a recipient privacy request through the API.</p><div className="actions"><button className="button">Export my data</button><button className="button">New request</button></div></Card></div>}
    {tab === 'Billing' && <Billing />}
    {tab === 'Notifications' && <Card title="Alerts" subtitle="Choose which operational events notify your team.">{['Deliverability warnings','Domain authentication changes','Usage reaches 80%','Webhook endpoint failures','Weekly performance digest'].map((item, index) => <label className="toggle-line setting-row" key={item}><span><b>{item}</b><small>Email and in-app notification</small></span><input type="checkbox" defaultChecked={index < 4} /></label>)}</Card>}
  </>;
}

function FeaturePlaceholder({ title, backendMissing }: { title: string; backendMissing: boolean }) {
  return <><PageHeader eyebrow="WORKSPACE" title={title} description={backendMissing ? 'This design is retained from the latest customer UI; its backend service is the next implementation phase.' : 'This screen is being connected to the existing platform service through a human-session gateway.'} />
    <Card><Empty icon={backendMissing ? '◇' : '↗'} title={backendMissing ? `${title} backend required` : `${title} integration in progress`} copy={backendMissing ? 'The repository does not yet contain native campaigns, contacts, lists, or segment APIs. The interface stays gated so it never presents mock data as live.' : 'The core API capability exists, but currently accepts API keys. A session-safe customer route will be added before this page is enabled.'} /></Card></>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) { return <header className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</header>; }
function Card({ title, subtitle, children }: { title?: string; subtitle?: string; children: ReactNode }) { return <section className="card">{title && <header className="card-head"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</header>}<div className="card-body">{children}</div></section>; }
function Metric({ label, value, caption, tone }: { label: string; value: ReactNode; caption: string; tone: string }) { return <section className={`metric ${tone}`}><div className="metric-top"><span>{label}</span><i /></div><strong>{value}</strong><small>{caption}</small></section>; }
function Status({ value }: { value: string }) { const low = value.toLowerCase(); const tone = /active|verified|secret|ready|paid/.test(low) ? 'good' : /fail|disabled|revoked|past/.test(low) ? 'bad' : 'warn'; return <span className={`status ${tone}`}>{value}</span>; }
function Empty({ icon, title, copy }: { icon: string; title: string; copy: string }) { return <div className="empty"><span>{icon}</span><h3>{title}</h3><p>{copy}</p></div>; }
function Checklist({ items, go }: { items: Array<[string, boolean, string]>; go(path: string): void }) { return <div className="checklist">{items.map(([label, done, path]) => <button key={label} onClick={() => go(path)}><span className={done ? 'done' : ''}>{done ? '✓' : ''}</span><b>{label}</b><small>{done ? 'Complete' : 'Continue'} →</small></button>)}</div>; }
function DataTable({ headers, children, loading, error, empty }: { headers: string[]; children: ReactNode; loading: boolean; error: unknown; empty: string }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children;
  return <section className="card table-card">{loading ? <div className="table-message">Loading…</div> : error ? <div className="alert error table-alert">{message(error)}</div> : !rows || (Array.isArray(rows) && rows.length === 0) ? <div className="table-message">{empty}</div> : <div className="table-wrap"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>}</section>;
}

function Onboarding({ done }: { done(): void }) {
  const [step, setStep] = useState(1); const [domain, setDomain] = useState(''); const [secret, setSecret] = useState(''); const [error, setError] = useState('');
  const steps = ['About your sending','Verify a domain','Create an API key','Send your first email','Ready to send'];
  async function addDomain() { setError(''); try { if (domain) await api.createDomain(domain); setStep(3); } catch (cause) { setError(message(cause)); } }
  async function createKey() { setError(''); try { const row = await api.createKey('Onboarding key'); setSecret(row.api_key || 'Key created'); setStep(4); } catch (cause) { setError(message(cause)); } }
  return <main className="onboarding"><aside className="onboarding-rail"><div className="brand"><span className="brand-mark">V</span><strong>Valasys</strong></div><span className="eyebrow">GET SET UP · ABOUT 5 MIN</span>{steps.map((item,i) => <div className={`onboarding-step ${step === i+1 ? 'active' : ''} ${step > i+1 ? 'done' : ''}`} key={item}><span>{step > i+1 ? '✓' : i+1}</span><b>{item}</b></div>)}</aside><section className="onboarding-main">
    {step === 1 && <div className="onboarding-card"><span className="eyebrow">STEP 1 OF 5</span><h1>Tell us about your sending</h1><p>This tunes benchmarks, compliance guidance, templates and AI suggestions.</p><label className="field"><span>Your role</span><select><option>Developer</option><option>Marketer</option><option>Founder</option><option>Operations</option></select></label><label className="field"><span>What will you send?</span><select><option>Transactional and marketing</option><option>Transactional email</option><option>Marketing campaigns</option></select></label><label className="field"><span>Monthly volume</span><select><option>10k–100k</option><option>Under 10k</option><option>100k–1m</option><option>Over 1m</option></select></label><button className="button primary" onClick={() => setStep(2)}>Continue</button></div>}
    {step === 2 && <div className="onboarding-card"><span className="eyebrow">STEP 2 OF 5</span><h1>Verify your sending domain</h1><p>Add the domain you will use in From addresses. We’ll show the required SPF and DKIM records.</p><Field label="Sending domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="mail.example.com" /><div className="actions"><button className="button primary" onClick={() => void addDomain()}>Add domain</button><button className="button" onClick={() => setStep(3)}>Skip for now</button></div>{error && <div className="alert error">{error}</div>}</div>}
    {step === 3 && <div className="onboarding-card"><span className="eyebrow">STEP 3 OF 5</span><h1>Create your first API key</h1><p>Use this credential from your application or SMTP client. It is shown once.</p>{secret ? <div className="secret-banner"><code>{secret}</code><button className="button" onClick={() => void navigator.clipboard.writeText(secret)}>Copy</button></div> : <button className="button primary" onClick={() => void createKey()}>Create API key</button>}<button className="button" onClick={() => setStep(4)}>Continue</button>{error && <div className="alert error">{error}</div>}</div>}
    {step === 4 && <div className="onboarding-card"><span className="eyebrow">STEP 4 OF 5</span><h1>Send your first email</h1><p>Paste this example into your application after verifying your email and sending domain.</p><pre className="code-block">{`curl -X POST http://localhost:3000/v1/send \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"from":"hello@${domain || 'example.com'}","to":"you@example.com","subject":"Hello from Valasys","text":"It works!"}'`}</pre><div className="actions"><button className="button primary" onClick={() => setStep(5)}>I’m ready</button><button className="button" onClick={() => setStep(5)}>Skip test</button></div></div>}
    {step === 5 && <div className="onboarding-card centered"><span className="success-orb">✓</span><span className="eyebrow">SETUP COMPLETE</span><h1>You’re ready to send</h1><p>Your workspace is connected. Continue to the dashboard to monitor sending, build campaigns and automate journeys.</p><button className="button primary" onClick={done}>Open workspace</button></div>}
  </section></main>;
}

export function App() {
  const { status } = useAuth();
  const [onboarding, setOnboarding] = useState(sessionStorage.getItem('valasys.onboarding') === 'true');
  if (status === 'restoring') return <div className="splash"><span className="brand-mark">V</span><p>Opening your workspace…</p></div>;
  if (status === 'authenticated' && onboarding) return <Onboarding done={() => { sessionStorage.removeItem('valasys.onboarding'); setOnboarding(false); }} />;
  return status === 'authenticated' ? <Shell /> : <AuthScreen />;
}
