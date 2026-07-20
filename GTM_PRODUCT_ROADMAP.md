# Product & GTM Roadmap — From ICP Corpus to Production Launch

**Source basis:** four consolidated ICP/technographic dossiers covering **78
target companies**, mapped end-to-end against the platform's current
capabilities (audited in-repo, feature by feature). This document is the
single plan for (a) what to build, (b) how to keep it production-grade, and
(c) how each build item converts named pipeline.

---

## 1. Market map — the 78 companies by segment

| Segment | ~Count | Representative targets | What they buy |
|---|---|---|---|
| ISPs / telecom / fiber | 10 | Access Technology, Dobson Fiber, Excel Telecom, Fiberzone, Nivid, SR Technologies | SMTP smart host, IP reputation isolation, sub-accounts for hosted clients |
| India SMB / manufacturing / trading | 15 | Warsi Steel, Mega Industries, Sony Traders, Shree Ambica Auto, Saraf Chandra | DNS/SPF fixes, invoice PDFs, low-cost plans (Cashfree billing already built) |
| Healthcare / diagnostics | 5 | Labcorp Nigeria, FocusDx, Healthcare Partners, Life Home Health, Lifeworks | HIPAA posture, TLS enforcement, report attachments, EHR SMTP |
| Media / news / broadcasting | 7 | Anchorage Daily News, WFAA, Indiatimes, Asian News Agency, KBTC, Radio One | Newsletter scale, SendGrid consolidation, engagement analytics, workflows |
| Utilities / municipalities | 6 | Citizens Energy, Easton, Estes Park, Shrewsbury, McKinney | Anti-spoofing (DMARC), critical-alert reliability, priority lane |
| Education | 4 | EdisonLearning, Orange Ulster BOCES, UIC, Engineer NITK | FERPA/Ed Law 2-d posture, parent-notification deliverability, sub-accounts (districts) |
| Finance / legal / professional | 6 | American Express, GE Money, Hightower, BCLP, Pillsbury, Stovl | PCI/FINRA posture, OTP latency, audit trails (built), SSO/SCIM (built) |
| ERP / IT services / BPO | 10 | Velocity (Oracle), CedarCrestone, Premier (JDE), Cybage, Ascent BPO, Idhasoft | ERP SMTP routing, sub-account isolation, helpdesk integrations |
| Franchise / direct-sales / travel | 3 | Dream Vacations, Tupperware India, Soch | Sub-accounts + template self-service, portal OTPs |
| Specialty (maritime, OTT, IoT/CCTV) | 5+ | MTM Ship Management, Digivive, DDS Security, Race Tech | Device/satellite SMTP relay, alert routing |

**Cross-segment demand tally (what the corpus actually asks for):**

1. SPF/DMARC misconfiguration diagnosis — the door-opener in ~65 of 78 pitches
2. Authenticated SMTP relay — hard requirement for ~27 (devices/ERPs/ISPs can't call REST)
3. Attachment delivery — ~16 (invoices, payroll, lab reports, license keys)
4. OTP / critical-alert latency — ~13 (Amex, GE Money, Tupperware, telecom NOCs)
5. Sub-account / reseller isolation — ~11 (BPO, ISP, BOCES, franchise, dealers)
6. Vendor consolidation off SendGrid/Mandrill/Elastic — ~7 named
7. Compliance gates — HIPAA (5 orgs), PCI, FERPA/Ed Law 2-d, FINRA
8. Newsletter/audience scale + automation — media segment (sellable today)

---

## 2. Platform audit — what exists vs. what gates revenue

**Already production-grade and sellable (verified in-repo):** idempotent send
pipeline with durable outbox; quotas/tiering; content scanning; suppression +
consent ledger; dedicated IP pools with automated warmup + reputation guard;
signed webhooks with ~20h retries + delivery log; templates; **workflow
automation engine** (versioned, durable, simulatable — built this cycle);
batch send; unsubscribe groups + RFC 8058; analytics + ClickHouse; billing
with plans/dunning/invoices across Stripe/PayPal/**Cashfree**; API keys with
scopes; human auth with MFA/WebAuthn/SSO/SCIM; admin ops console; hash-chained
WORM audit; GDPR erasure/export/retention/legal hold; fail-closed tenant RLS;
partitioned hot tables; DLQ + replay; Prometheus/Grafana/alerting; k8s/helm;
runbooks; docs site (fixed and deployable to the docs subdomain this cycle);
OpenAPI + parity guard; error-code registry; Node SDK; 787-test suite.

**Revenue-gating gaps (every one traced to named companies):**

| Gap | Blocks |
|---|---|
| Customer-facing SMTP submission relay | ~27 companies integrate no other way |
| Domain deliverability scanner | The demo/outreach motion for ~65 pitches |
| Attachments on /v1/send | ~16 companies' core payload |
| Per-message priority lane | OTP/alert plays (finance, e-comm, NOC) |
| TLS-required enforcement + HIPAA/PCI trust pages | 5 healthcare + finance security reviews |
| Sub-accounts | ~11 reseller/franchise/district deals |
| SendGrid-compatible shim | ~7 consolidation migrations |
| DMARC aggregate (RUA) monitoring | Municipal/utility anti-spoofing pitch |
| Contacts/segments/campaigns | Full marketing-suite story; workflow segment triggers |
| Customer web dashboard + visual builders | All non-API buyers (frontend phase) |

---

## 3. Build plan

### Phase 1 — Open doors (backend, ~1–2 weeks)
1. **Domain deliverability scanner** — `POST /v1/tools/domain-scan` +
   rate-limited public variant. Parses SPF (10-lookup breach, duplicate
   includes, flattening advice), grades DMARC/MX/DKIM selectors, detects
   current ESPs from SPF includes (the corpus's own technographic trick),
   checks blocklists (reuse existing infra), and emits **copy-paste DNS
   fixes**. Triple use: sales lead magnet on the docs site, onboarding
   diagnostics, scheduled re-scan alerts for existing tenants.
2. **`priority: "critical"` send lane** — per-message flag that jumps the
   queue (outbox priority column already exists); per-tenant p50/p95
   accept→deliver latency metrics to quote in OTP pitches.
3. **TLS-required delivery flag** — per-customer (or per-message) refusal to
   deliver over plaintext SMTP; groundwork for HIPAA/PCI posture.

### Phase 2 — Payloads & migration (~2 weeks)
4. **Attachments** — API + storage (reuse body object store), size caps,
   content-type allowlist, per-tier limits, AV-scan hook, quota weighting.
5. **SendGrid-compatible shim** — `/v3/mail/send` adapter + event-webhook
   format parity (parity test exists); migration guide: "change base URL
   and key."
6. **Compliance trust pages** on the docs site — HIPAA (+BAA position), PCI,
   FERPA/Ed Law 2-d, FINRA; subprocessor list; security whitepaper drawn
   from what's already built (RLS, audit chain, erasure, SSO/SCIM).

### Phase 3 — The big unlock: SMTP relay (~2–3 weeks)
7. **Authenticated SMTP submission service** (port 587/STARTTLS + 465):
   per-customer SMTP credentials (managed like API keys, `smtp` scope),
   MAIL FROM must match a verified sending domain, then the message enters
   the **existing** pipeline (suppression, scanning, quota, DKIM, tracking,
   events) exactly like an API send. Includes per-connection rate limits,
   auth lockouts, and abuse controls. This converts the ISP, telecom, ERP,
   maritime, IoT/CCTV, and healthcare-EHR segments.

### Phase 4 — Reseller tenancy (~3 weeks)
8. **Sub-accounts** — child accounts under a billing parent: isolated
   domains/suppressions/stats/keys, optional shared IP pool vs. per-child,
   parent roll-up reporting and spend caps, template sharing (franchise
   model). Unlocks BPO/ISP/BOCES/franchise/dealer deals and makes the
   Dream Vacations "franchisee self-service" story real.

### Phase 5 — Marketing-suite completion (~3–4 weeks)
9. **Contacts, lists & segments** — contact store with custom attributes,
   list import (reuse list-quality scoring), segment rules engine (reuse
   workflow condition evaluator), suppression-aware counts.
10. **Campaigns** — one-shot sends to segments over the batch pipeline with
    campaign-level analytics; wires the "Contact added to segment" workflow
    trigger the builder UI already envisions; completes DMARC monitoring
    (RUA ingestion + "who sends as your domain" dashboard data).

### Phase 6 — Frontend (parallel track once backend phases 1–3 land)
11. Customer dashboard (the Valasys Mail design): sending overview, domains
    with scanner-driven setup, messages/events explorer, suppressions,
    webhooks, API/SMTP credentials.
12. Visual workflow builder (API is ready: validate/simulate/stats/versions).
13. Drag-and-drop template editor (franchise/SMB requirement).
14. Public marketing site + free scanner page feeding signup.

### Continuous — production-grade reliability workstream
- **SLOs:** 99.9% API availability; p95 accept→handoff < 30s standard,
  < 5s critical lane; webhook delivery success ≥ 99.5% within 24h. Wire
  into existing Prometheus/Alertmanager.
- **Public status page** + incident process (runbooks exist; publish the
  customer-facing layer).
- **DR:** execute the documented backup/restore drill on a schedule; add
  cross-region replica plan from HA_DR.md before enterprise deals close.
- **Abuse hardening for new surfaces:** SMTP auth brute-force lockouts,
  attachment AV scanning, scanner rate limits.
- **Deliverability ops:** Google Postmaster/SNDS ingestion is built — add
  alert thresholds; establish FBL registrations per pool; warmup calendars
  for new dedicated IPs.
- **Load tests:** extend infra/loadtest to cover SMTP ingestion and
  attachment paths before GA.

---

## 4. GTM motion (uses the platform itself)

1. **Scanner-led outreach** — every one of the 78 dossiers opens with a DNS
   finding; the scanner automates producing that finding at scale. Publish
   the free scanner on the docs subdomain; gate the full fix-it report
   behind signup.
2. **Dogfood workflows** — run the outreach sequences in the dossiers as
   platform workflows (API trigger per prospect, delays, open/click
   branches, goal = reply/meeting).
3. **Segment playbooks** — one-page pitch per segment mapping their named
   pain to shipped features: ISPs → relay + sub-accounts; healthcare →
   TLS-required + HIPAA page + attachments; media → consolidation shim +
   newsletters + workflows; finance → priority lane + audit chain;
   utilities → DMARC monitoring + critical lane; franchise → sub-accounts +
   template editor.
4. **Pricing anchors** — the dossiers estimate each target's current spend
   ($440–$5K+/mo); position consolidated plans against those numbers; India
   segment already served by Cashfree billing.

## 5. Success metrics

- Time-to-first-email (signup → verified domain → first accept) < 15 min
- Scanner: scans/week, scan→signup conversion
- Migration: SendGrid-shim tenants, volume consolidated
- Reliability: SLO attainment, DLQ depth, sweep-recovery counts (should stay ~0)
- Revenue coverage: % of the 78 accounts whose gating feature is shipped
  (today ~35%; after Phase 3 ~75%; after Phase 4 ~90%)
