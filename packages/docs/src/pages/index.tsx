import React, {useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import styles from './index.module.css';

type IconName = 'send' | 'server' | 'layout' | 'flow' | 'webhook' | 'shield' | 'key' | 'book' | 'code' | 'search' | 'arrow' | 'life' | 'chart' | 'copy' | 'check';
const PATHS: Record<IconName, string> = {
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  server: 'M3 5h18v6H3zM3 13h18v6H3zM7 8h.01M7 16h.01',
  layout: 'M3 4h18v16H3zM3 9h18M9 9v11',
  flow: 'M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9c0 6-12 3-12 9',
  webhook: 'M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  life: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.93 4.93l4.24 4.24M14.83 14.83l4.24 4.24M14.83 9.17l4.24-4.24M4.93 19.07l4.24-4.24',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M20 6 9 17l-5-5',
};
function Icon({name, size = 18}: {name: IconName; size?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

const PRODUCTS: {icon: IconName; title: string; body: string; to: string; links: [string, string][]}[] = [
  {icon: 'send', title: 'Email API', body: 'Send transactional and marketing email with one HTTPS call, with templates, tags, idempotency and scheduling.', to: '/docs/guides/sending-email',
    links: [['Send email', '/docs/guides/sending-email'], ['Batch sending', '/docs/guides/batch-sending']]},
  {icon: 'server', title: 'SMTP relay', body: 'Point existing apps and devices at the SMTP gateway and authenticate with an API key.', to: '/docs/guides/smtp-relay',
    links: [['Connect over SMTP', '/docs/guides/smtp-relay']]},
  {icon: 'layout', title: 'Templates', body: 'Reusable templates with variables, conditionals and saved versions you can render from the API.', to: '/docs/guides/templates',
    links: [['Template syntax', '/docs/guides/templates'], ['Tracking', '/docs/guides/tracking']]},
  {icon: 'flow', title: 'Workflows', body: 'Journeys triggered by your events, lists or dates, with waits, branches, A/B splits and goals.', to: '/docs/guides/workflows',
    links: [['Build a workflow', '/docs/guides/workflows']]},
  {icon: 'webhook', title: 'Webhooks & activity', body: 'Signed real-time events for deliveries, opens, clicks, bounces and complaints, plus message history.', to: '/docs/guides/webhooks',
    links: [['Webhooks', '/docs/guides/webhooks'], ['Activity & analytics', '/docs/guides/activity-analytics']]},
  {icon: 'shield', title: 'Deliverability', body: 'Authenticate your domain with SPF, DKIM and DMARC, manage suppressions and keep reputation healthy.', to: '/docs/guides/deliverability',
    links: [['Domain setup', '/docs/guides/dns-setup'], ['Suppressions', '/docs/guides/suppressions']]},
];

const API_LINKS: [string, string, string][] = [
  ['POST', 'Send email', '/docs/api-reference#send-email'],
  ['POST', 'Batch send', '/docs/api-reference#batch-send'],
  ['GET', 'List messages', '/docs/api-reference#list-messages'],
  ['GET', 'List domains', '/docs/api-reference#list-domains'],
  ['GET', 'List templates', '/docs/api-reference#list-templates'],
  ['GET', 'List webhooks', '/docs/api-reference#list-webhooks'],
  ['GET', 'List suppressions', '/docs/api-reference#list-suppressions'],
  ['GET', 'List workflows', '/docs/api-reference#list-workflows'],
];

const SAMPLES: {id: string; label: string; code: string}[] = [
  {id: 'curl', label: 'cURL', code: `curl -X POST https://api.mailplatform.example/v1/send \\
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "hello@mail.yourcompany.com",
    "to": "alice@example.com",
    "subject": "Hello",
    "html": "<h1>It works</h1>"
  }'`},
  {id: 'node', label: 'Node.js', code: `import { MailPlatformClient } from '@platform/sdk';

const mp = new MailPlatformClient({
  apiKey: process.env.MAILPLATFORM_API_KEY!,
});

const result = await mp.messages.send({
  from: 'hello@mail.yourcompany.com',
  to: 'alice@example.com',
  subject: 'Hello',
  html: '<h1>It works</h1>',
});`},
  {id: 'python', label: 'Python', code: `import os, requests

response = requests.post(
    "https://api.mailplatform.example/v1/send",
    headers={"Authorization": f"Bearer {os.environ['MAILPLATFORM_API_KEY']}"},
    json={
        "from": "hello@mail.yourcompany.com",
        "to": "alice@example.com",
        "subject": "Hello",
        "html": "<h1>It works</h1>",
    },
    timeout=30,
)
response.raise_for_status()`},
];

function CodeSample() {
  const [tab, setTab] = useState(SAMPLES[0]!.id);
  const [copied, setCopied] = useState(false);
  const sample = SAMPLES.find((s) => s.id === tab)!;
  const copy = () => {
    void navigator.clipboard?.writeText(sample.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className={styles.code}>
      <div className={styles.codeHead}>
        <div className={styles.tabs} role="tablist" aria-label="Language">
          {SAMPLES.map((s) => (
            <button key={s.id} role="tab" aria-selected={s.id === tab} className={clsx(styles.tab, s.id === tab && styles.tabActive)} onClick={() => setTab(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <button className={styles.copy} onClick={copy} aria-label="Copy code">
          <Icon name={copied ? 'check' : 'copy'} size={14} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={styles.codeBody}><code>{sample.code}</code></pre>
    </div>
  );
}

export default function Home(): React.ReactElement {
  const searchAction = useBaseUrl('/search');
  return (
    <Layout title="Documentation" description="Guides and API reference for sending, automating and tracking email with Valasys.">
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <p className={styles.eyebrow}>Valasys documentation</p>
          <h1 className={styles.title}>Everything you need to send email with Valasys</h1>
          <p className={styles.lead}>Guides, API reference and SDKs for sending, automating and tracking email, from your first message to production.</p>
          <form className={styles.search} action={searchAction} method="get" role="search">
            <Icon name="search" />
            <input name="q" type="search" placeholder="Search guides and API reference" aria-label="Search documentation" autoComplete="off" />
            <button type="submit">Search</button>
          </form>
          <div className={styles.quick}>
            <Link className={styles.quickPrimary} to="/docs/guides/getting-started">
              Quickstart <Icon name="arrow" size={15} />
            </Link>
            <Link className={styles.quickLink} to="/docs/api-reference"><Icon name="code" size={15} /> API reference</Link>
            <Link className={styles.quickLink} to="/docs/SDK"><Icon name="book" size={15} /> Node.js SDK</Link>
            <Link className={styles.quickLink} to="/docs/guides/authentication"><Icon name="key" size={15} /> Authentication</Link>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Explore the platform</h2>
            <p>Pick a product area to see how it works and how to integrate it.</p>
          </div>
          <div className={styles.grid}>
            {PRODUCTS.map((p) => (
              <article key={p.title} className={styles.card}>
                <Link to={p.to} className={styles.cardMain}>
                  <span className={styles.cardIcon}><Icon name={p.icon} /></span>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                </Link>
                <div className={styles.cardLinks}>
                  {p.links.map(([label, to]) => (
                    <Link key={to} to={to}>{label} <Icon name="arrow" size={13} /></Link>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className={clsx(styles.section, styles.split)}>
          <div className={styles.splitText}>
            <p className={styles.eyebrow}>Send your first email</p>
            <h2>One request, then you are live</h2>
            <ol className={styles.steps}>
              <li><strong>Create an API key</strong><span>Keys are shown once. Keep them in an environment variable.</span></li>
              <li><strong>Authenticate your domain</strong><span>Publish SPF, DKIM and DMARC records, then verify.</span></li>
              <li><strong>Call the send endpoint</strong><span>Every message gets an ID you can look up or follow with webhooks.</span></li>
            </ol>
            <Link className={styles.textLink} to="/docs/guides/getting-started">Follow the quickstart <Icon name="arrow" size={14} /></Link>
          </div>
          <CodeSample />
        </section>

        <section className={styles.section}>
          <div className={clsx(styles.sectionHead, styles.sectionHeadRow)}>
            <div>
              <h2>API reference</h2>
              <p>REST endpoints authenticated with a bearer API key. Download the <a href={useBaseUrl('/openapi.json')}>OpenAPI spec</a>.</p>
            </div>
            <Link className={styles.textLink} to="/docs/api-reference">All endpoints <Icon name="arrow" size={14} /></Link>
          </div>
          <div className={styles.endpoints}>
            {API_LINKS.map(([method, label, to]) => (
              <Link key={to} to={to} className={styles.endpoint}>
                <span className={clsx('api-method', `api-method--${method.toLowerCase()}`)}>{method}</span>
                <span>{label}</span>
                <Icon name="arrow" size={14} />
              </Link>
            ))}
          </div>
        </section>

        <section className={clsx(styles.section, styles.help)}>
          <Link to="/docs/guides/errors" className={styles.helpCard}>
            <span className={styles.cardIcon}><Icon name="code" /></span>
            <div><h3>Errors & rate limits</h3><p>Error codes, retries and limits for every endpoint.</p></div>
          </Link>
          <Link to="/docs/guides/security-compliance" className={styles.helpCard}>
            <span className={styles.cardIcon}><Icon name="shield" /></span>
            <div><h3>Security & compliance</h3><p>How data is protected, retained and erased.</p></div>
          </Link>
          <Link to="/docs/guides/support" className={styles.helpCard}>
            <span className={styles.cardIcon}><Icon name="life" /></span>
            <div><h3>Get support</h3><p>Open a ticket or check the status of an existing one.</p></div>
          </Link>
        </section>
      </main>
    </Layout>
  );
}
