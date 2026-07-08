import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const FEATURES = [
  {
    icon: '📨',
    title: 'Send API',
    description:
      'Single POST to deliver transactional email. HTML, plain text, Handlebars templates, idempotency keys, and scheduled delivery.',
    link: '/docs/guides/sending-email',
  },
  {
    icon: '📦',
    title: 'Batch Sending',
    description:
      'Dispatch thousands of personalised messages in one API call. Per-message variables, partial-failure isolation, and a unified response.',
    link: '/docs/guides/batch-sending',
  },
  {
    icon: '✉️',
    title: 'Templates',
    description:
      'Reusable Handlebars templates with variables, conditionals, loops, and inline defaults. Version-controlled and testable via API.',
    link: '/docs/guides/templates',
  },
  {
    icon: '🔔',
    title: 'Real-time Webhooks',
    description:
      'HMAC-SHA256 signed payloads on every event: delivered, open, click, bounce, complaint, unsubscribe. Automatic retries and a delivery log.',
    link: '/docs/guides/webhooks',
  },
  {
    icon: '👁️',
    title: 'Open & Click Tracking',
    description:
      'Pixel tracking and link rewriting with built-in bot detection. Distinguishes human interactions from Apple MPP and security gateway crawlers.',
    link: '/docs/guides/tracking',
  },
  {
    icon: '🛡️',
    title: 'Deliverability',
    description:
      'DKIM signing, SPF, DMARC alignment, IP warmup scheduling, bounce handling, and complaint rate monitoring out of the box.',
    link: '/docs/guides/deliverability',
  },
  {
    icon: '🚫',
    title: 'Suppressions',
    description:
      'Global do-not-email list with bulk import, CSV export, and quality scoring. Hard-bounce and complaint suppression is automatic.',
    link: '/docs/guides/suppressions',
  },
  {
    icon: '📋',
    title: 'Unsubscribe Groups',
    description:
      'Topic-level opt-outs with one-click unsubscribe (RFC 8058). Let recipients manage preferences without leaving your list entirely.',
    link: '/docs/guides/unsubscribe-groups',
  },
  {
    icon: '🌐',
    title: 'Domain Authentication',
    description:
      'Step-by-step SPF, DKIM, and DMARC setup. Verification API confirms records propagated correctly and explains any failures.',
    link: '/docs/guides/dns-setup',
  },
  {
    icon: '📊',
    title: 'Activity & Analytics',
    description:
      'Full message timeline, delivery event history, open and click verdicts, and usage metrics. Filter by status, tag, domain, or date.',
    link: '/docs/guides/activity-analytics',
  },
  {
    icon: '🔒',
    title: 'Privacy & GDPR',
    description:
      'Per-recipient data deletion and export for Art. 17/15 compliance. Suppression as a consent record with documented retention policy.',
    link: '/docs/guides/privacy-gdpr',
  },
  {
    icon: '⚡',
    title: 'TypeScript SDK',
    description:
      'Official Node.js SDK with full type safety, edge runtime support, and zero dependencies. OpenAPI 3.1 spec available for any language.',
    link: '/docs/SDK',
  },
];

const STEPS = [
  {
    number: '01',
    title: 'Add your sending domain',
    body: 'Publish SPF, DKIM, DMARC, and bounce-path DNS records, then call /v1/domains/:id/verify. Most DNS providers propagate in under five minutes.',
  },
  {
    number: '02',
    title: 'Call the send API',
    body: 'POST to /v1/send from curl, Node, Python, Go, or any HTTP client. Every message returns an ID you can query or subscribe to via webhooks.',
  },
  {
    number: '03',
    title: 'Receive events in real time',
    body: 'Subscribe a webhook endpoint to delivery, open, click, bounce, and complaint events. Payloads are HMAC-signed, retried, and logged for 30 days.',
  },
];

const QUICKSTART_CODE = `curl -X POST https://api.mailplatform.example/v1/send \\
  -H "Authorization: Bearer mp_live_xxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "hello@yourcompany.com",
    "to": "user@example.com",
    "subject": "Welcome!",
    "html": "<h1>You are in!</h1><p>Thanks for signing up.</p>",
    "text": "You are in! Thanks for signing up.",
    "trackingOpens": true,
    "trackingClicks": true
  }'`;

export default function Home(): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title="Transactional email API for developers"
      description={siteConfig.tagline}
    >
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <header className={clsx('hero', styles.heroBanner)}>
        <div className="container">
          <div className={styles.heroBadge}>
            <span className={styles.heroBadgeDot} />
            <span>API v2 stable · OpenAPI 3.1</span>
          </div>
          <h1 className={styles.heroTitle}>
            Transactional email<br />built for developers
          </h1>
          <p className={styles.heroSubtitle}>
            Send, track, and manage transactional email through a simple REST API.
            DKIM signing, real-time webhooks, bot-filtered tracking, and full GDPR
            tooling — ready out of the box.
          </p>
          <div className={styles.heroButtons}>
            <Link
              className="button button--primary button--lg"
              to="/docs/guides/getting-started"
            >
              Get started in 5 minutes →
            </Link>
            <Link
              className={clsx('button button--lg', styles.heroButtonOutline)}
              to="/docs/api-reference"
            >
              API Reference
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* ── Quickstart code block ────────────────────────────────────────── */}
        <section className={styles.quickstart}>
          <div className="container">
            <div className={styles.codeBlock}>
              <div className={styles.codeHeader}>
                <div className={styles.codeDots}>
                  <span className={clsx(styles.codeDot, styles.codeDotRed)} />
                  <span className={clsx(styles.codeDot, styles.codeDotYellow)} />
                  <span className={clsx(styles.codeDot, styles.codeDotGreen)} />
                </div>
                <span className={styles.codeLabel}>Send your first email</span>
                <Link to="/docs/guides/getting-started" className={styles.codeLink}>
                  Full quickstart →
                </Link>
              </div>
              <pre className={styles.code}>{QUICKSTART_CODE}</pre>
            </div>
          </div>
        </section>

        {/* ── How it works ─────────────────────────────────────────────────── */}
        <section className={styles.howItWorks}>
          <div className="container">
            <h2 className={styles.sectionTitle}>How it works</h2>
            <p className={styles.sectionSubtitle}>
              Three steps from sign-up to delivered email.
            </p>
            <div className={styles.steps}>
              {STEPS.map((s, i) => (
                <div key={s.number} className={styles.step}>
                  <div className={styles.stepNumberWrap}>
                    <span className={styles.stepNumber}>{s.number}</span>
                    {i < STEPS.length - 1 && <span className={styles.stepConnector} />}
                  </div>
                  <div className={styles.stepContent}>
                    <h3 className={styles.stepTitle}>{s.title}</h3>
                    <p className={styles.stepBody}>{s.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Feature grid ─────────────────────────────────────────────────── */}
        <section className={styles.features}>
          <div className="container">
            <h2 className={styles.sectionTitle}>
              Everything you need to send at scale
            </h2>
            <p className={styles.sectionSubtitle}>
              A complete transactional email platform — API, SDK, deliverability
              tools, and compliance built in.
            </p>
            <div className={styles.featureGrid}>
              {FEATURES.map((f) => (
                <Link key={f.title} to={f.link} className={styles.featureCard}>
                  <span className={styles.featureIcon}>{f.icon}</span>
                  <h3 className={styles.featureTitle}>{f.title}</h3>
                  <p className={styles.featureDescription}>{f.description}</p>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* ── Bottom CTA ───────────────────────────────────────────────────── */}
        <section className={styles.bottomCta}>
          <div className="container">
            <h2 className={styles.ctaTitle}>Ready to send?</h2>
            <p className={styles.ctaSubtitle}>
              Add your domain and deliver your first email in under five minutes.
            </p>
            <div className={styles.heroButtons}>
              <Link
                className="button button--primary button--lg"
                to="/docs/guides/getting-started"
              >
                Start building →
              </Link>
              <Link
                className={clsx('button button--lg', styles.ctaButtonOutline)}
                to="/docs/api-reference"
              >
                View API reference
              </Link>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
