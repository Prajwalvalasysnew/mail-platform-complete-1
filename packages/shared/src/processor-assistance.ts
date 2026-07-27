// GDPR-13 (compliance implementation plan): Article 32 security of processing,
// and the processor-assistance duties under Article 28(3).
//
// A customer of this platform is a controller; the platform is their
// processor. Art 28(3)(e)(f)(h) obliges the processor to assist with data
// subject rights, security, breach notification, DPIAs and regulator
// inquiries, and to make the information needed to demonstrate compliance
// available to the controller. Until now that information existed only as
// prose in docs/, which a controller cannot verify and cannot attach to their
// own Art 30(1) record.
//
// THE RULE THIS MODULE IS BUILT AROUND: NEVER OVER-CLAIM.
//
// An Article 32 schedule is not marketing copy. A controller reads it to
// decide whether the processing is appropriately secured — and, if there is a
// breach, a regulator reads it to decide whether that decision was reasonable.
// Two failure modes matter, and both are silent:
//
//   1. Claiming a measure is enforced when it is merely switched on. A
//      setting that an operator can flip is a different assurance from a
//      property the code makes structurally true. So the DERIVATION of each
//      measure is declared at the definition site, and a config-derived
//      measure can never resolve to 'enforced' — see resolveState().
//
//   2. Omitting measures that are off. A schedule listing only what a tenant
//      has reads as complete and is not. Every measure this platform knows
//      about is always returned; the ones that are off say so.
//
// What this module deliberately does NOT do is name vendors. Which
// subprocessors are in scope is a deployment fact, not a source-code fact
// (see docs/VENDOR_REGISTER.md) — the code can honestly report which
// integration points are configured, and nothing more.

import { db } from './db.js';
import { resolveTenantRetention } from './retention-policy.js';
import { cardDataPolicy } from './card-data.js';
import { clickhouseEnabled } from './clickhouse.js';

/**
 * How a measure's assurance is established. Declared per measure, not derived
 * from its current value — this is what stops "it happens to be on" from
 * being reported as "the platform guarantees it".
 */
export type MeasureDerivation =
  /** True by construction in code; not switchable per tenant or per deployment. */
  | 'structural'
  /** Depends on a tenant or deployment setting that can be changed. */
  | 'configured'
  /** A documented commitment with no technical enforcement in this codebase. */
  | 'policy';

export type MeasureState = 'enforced' | 'configured' | 'not_enabled' | 'policy_only';

export interface SecurityMeasure {
  id: string;
  /** Which Art 32(1) limb the measure serves. */
  article_32: 'confidentiality' | 'integrity' | 'availability' | 'resilience' | 'testing' | 'pseudonymisation';
  description: string;
  derivation: MeasureDerivation;
  state: MeasureState;
  /** Where a controller or auditor can verify the claim. */
  evidence: string;
  /** Stated whenever the measure is narrower than its name suggests. */
  caveat?: string;
}

/**
 * The single place a measure's state is decided.
 *
 * 'structural' measures are the only ones that may report 'enforced'.
 * 'configured' measures report 'configured' or 'not_enabled' — never
 * 'enforced', however they are set. 'policy' measures always report
 * 'policy_only', because nothing in this repository makes them true.
 */
function resolveState(derivation: MeasureDerivation, active: boolean): MeasureState {
  if (derivation === 'policy') return 'policy_only';
  if (!active) return 'not_enabled';
  return derivation === 'structural' ? 'enforced' : 'configured';
}

function measure(
  m: Omit<SecurityMeasure, 'state'> & { active: boolean },
): SecurityMeasure {
  const { active, ...rest } = m;
  return { ...rest, state: resolveState(m.derivation, active) };
}

/**
 * The Article 32 measures schedule for one tenant, resolved against what is
 * actually in effect for them right now.
 *
 * Every measure the platform knows about is returned, including the ones that
 * are off — a schedule that quietly drops them would read as complete.
 */
export async function securityMeasures(customerId: string): Promise<SecurityMeasure[]> {
  const customer = await db.selectFrom('customers')
    .select(['tls_required', 'sso_enforced'])
    .where('id', '=', customerId)
    .executeTakeFirst();
  if (!customer) throw new ProcessorAssistanceError(`No such customer: ${customerId}`);

  const retention = await resolveTenantRetention(customerId);
  const cardPolicy = cardDataPolicy();

  return [
    measure({
      id: 'tenant_isolation',
      article_32: 'confidentiality',
      description: 'Every tenant-scoped table is protected by PostgreSQL row-level security, so a query without a tenant context returns nothing rather than another tenant\'s rows.',
      derivation: 'structural',
      active: true,
      evidence: 'rls-isolation.test.ts, tenant-route-rls-guard.test.ts',
    }),
    measure({
      id: 'credential_encryption',
      article_32: 'confidentiality',
      description: 'Stored third-party credentials and DKIM private keys are encrypted with AES-256-GCM before they reach the database.',
      derivation: 'structural',
      active: true,
      evidence: 'encryption.ts, encryption.test.ts',
      caveat: 'Covers application-managed secrets. Full-disk / at-rest encryption of the database and object store is a deployment responsibility and is not asserted here.',
    }),
    measure({
      id: 'audit_tamper_evidence',
      article_32: 'integrity',
      description: 'Audit records are hash-chained and periodically signed, so a deletion or edit inside the log is detectable.',
      derivation: 'structural',
      active: true,
      evidence: 'audit-hash-chain.test.ts, audit-worm.test.ts; checkpoint coverage reported under BASE-10 in control evidence',
    }),
    measure({
      id: 'opt_out_enforcement',
      article_32: 'integrity',
      description: 'Suppression and consent state is checked on the send path itself, so an opt-out cannot be bypassed by any caller.',
      derivation: 'structural',
      active: true,
      evidence: 'suppression.ts, canspam-opt-out-friction.e2e.test.ts',
    }),
    measure({
      id: 'erasure_pseudonymisation',
      article_32: 'pseudonymisation',
      description: 'Erasure replaces recipient identifiers with a per-tenant pseudonym across every table that holds them, preserving aggregate counts without the identity.',
      derivation: 'structural',
      active: true,
      evidence: 'privacy-pseudonym.ts, privacy-pseudonymization.e2e.test.ts',
    }),
    measure({
      id: 'downstream_tls',
      article_32: 'confidentiality',
      description: 'Delivery to recipient servers requires TLS and fails closed on domains observed to accept mail in plaintext.',
      derivation: 'configured',
      active: Boolean(customer.tls_required),
      evidence: 'transport-security.ts, docs/TRANSPORT_SECURITY.md',
      caveat: 'Guarantees the first hop only. Onward relaying by the recipient\'s provider is outside this platform\'s control, which is why special-category content remains prohibited (BASE-15).',
    }),
    measure({
      id: 'sso_enforced',
      article_32: 'confidentiality',
      description: 'Account users must authenticate through the tenant\'s identity provider, so deprovisioning there removes platform access.',
      derivation: 'configured',
      active: Boolean(customer.sso_enforced),
      evidence: 'sso.ts, scim.ts',
    }),
    measure({
      id: 'card_data_barrier',
      article_32: 'confidentiality',
      description: 'Message content is scanned for cardholder data and rejected or redacted before storage, keeping the platform out of PCI DSS scope.',
      derivation: 'configured',
      active: cardPolicy !== 'off',
      evidence: `card-data.ts (policy: ${cardPolicy}), docs/runbooks/CARD_DATA.md`,
    }),
    measure({
      id: 'retention_limits',
      article_32: 'confidentiality',
      description: `Message bodies are purged after ${retention.bodyDays} days and events after ${retention.eventsDays} days by an automated sweep.`,
      derivation: 'configured',
      active: true,
      evidence: 'retention.ts; every sweep is recorded in retention_runs and reported under BASE-06 in control evidence',
      caveat: retention.explicit
        ? undefined
        : 'These are platform defaults; no retention window has been agreed for this tenant specifically.',
    }),
    measure({
      id: 'analytics_replica',
      article_32: 'confidentiality',
      description: 'Event data is mirrored to an external analytics store.',
      derivation: 'configured',
      active: clickhouseEnabled(),
      evidence: 'clickhouse.ts',
      caveat: clickhouseEnabled()
        ? 'This is an additional copy of recipient-linked event data. It must appear in the controller\'s own Art 30 record and in the subprocessor register.'
        : undefined,
    }),
    measure({
      id: 'data_residency',
      article_32: 'confidentiality',
      description: 'Processing, storage, logging and backups pinned to a contractually agreed region.',
      derivation: 'configured',
      // GDPR-11 is open: there is no region-pinning implementation to switch
      // on, so reporting anything else here would be a false claim.
      active: false,
      evidence: 'Not implemented — GDPR-11 in docs/COMPLIANCE_IMPLEMENTATION_PLAN.md',
    }),
    measure({
      id: 'backup_erasure_replay',
      article_32: 'resilience',
      description: 'Erasures are replayed over restored data before a restored node serves traffic, so a restore cannot resurrect erased recipients.',
      derivation: 'policy',
      active: true,
      evidence: 'docs/runbooks/RESTORE_RE_DELETION.md; the replay itself is implemented and tested (privacy-restore-replay.e2e.test.ts)',
      caveat: 'The mechanism is code; running it after every restore is a procedure. Only the procedure makes the guarantee real.',
    }),
    measure({
      id: 'restore_testing',
      article_32: 'availability',
      description: 'Backups are restored on a schedule to prove they are usable.',
      derivation: 'policy',
      active: true,
      evidence: 'docs/RETENTION_AND_DISPOSAL.md, docs/runbooks/RESTORE_RE_DELETION.md',
    }),
    measure({
      id: 'security_testing',
      article_32: 'testing',
      description: 'Regular testing and evaluation of the effectiveness of these measures (Art 32(1)(d)).',
      derivation: 'policy',
      active: true,
      evidence: 'Automated coverage runs per change; independent penetration testing and control effectiveness review are organizational commitments (SOC2-05, SOC2-07)',
      caveat: 'Automated tests demonstrate the measures behave as described. They are not an independent assessment.',
    }),
  ];
}

/**
 * Integration points that are actually configured in this deployment.
 *
 * Deliberately reports capabilities, not vendor names: which company supplies
 * object storage or the MTA is a contract the code cannot see. A controller
 * needs this to complete their own subprocessor list — it tells them where to
 * look, not who to name.
 */
export function configuredIntegrations(): Array<{ integration: string; personal_data: string }> {
  const out: Array<{ integration: string; personal_data: string }> = [];
  const bodyStorage = (process.env.BODY_STORAGE ?? 'inline').toLowerCase();

  out.push({
    integration: 'Outbound mail transport',
    personal_data: 'Recipient address and full message content',
  });
  if (bodyStorage === 's3') {
    out.push({
      integration: 'S3-compatible object storage (message bodies, attachments, export artifacts)',
      personal_data: 'Message content and recipient data',
    });
  }
  if (clickhouseEnabled()) {
    out.push({
      integration: 'External analytics store',
      personal_data: 'Recipient address and event metadata',
    });
  }
  if (process.env.STRIPE_SECRET_KEY || process.env.PAYPAL_CLIENT_ID || process.env.CASHFREE_APP_ID) {
    out.push({
      integration: 'Payment provider',
      personal_data: 'Account email and provider identifiers. No cardholder data reaches this platform (PCI-01).',
    });
  }
  return out;
}

export interface AssistanceCommitment {
  duty: string;
  article: string;
  /** The endpoint, runbook or mechanism that actually delivers it. */
  delivered_by: string;
}

/**
 * Art 28(3) assistance duties, each tied to the thing that performs it.
 *
 * A commitment with no mechanism named is a promise; naming the endpoint or
 * runbook makes it checkable, and makes a regression visible when the
 * mechanism is removed.
 */
export function assistanceCommitments(): AssistanceCommitment[] {
  return [
    {
      duty: 'Assist the controller in responding to data subject access, erasure, rectification, restriction, objection and portability requests.',
      article: 'Art 28(3)(e)',
      delivered_by: 'POST /v1/privacy/delete-recipient, GET /v1/privacy/export-recipient, POST /v1/privacy/rectify-recipient, POST /v1/privacy/restrict-recipient, POST /v1/privacy/object, and the case workflow under /v1/privacy/cases',
    },
    {
      duty: 'Assist with security of processing (Art 32).',
      article: 'Art 28(3)(f)',
      delivered_by: 'GET /v1/privacy/processing-record — the measures schedule in this response, resolved against this tenant\'s live configuration',
    },
    {
      duty: 'Notify the controller without undue delay after becoming aware of a personal data breach.',
      article: 'Art 33(2)',
      delivered_by: 'docs/runbooks/INCIDENT_AND_BREACH.md — notification path and timeline. The processor does not notify the supervisory authority on the controller\'s behalf.',
    },
    {
      duty: 'Assist with data protection impact assessments and prior consultation.',
      article: 'Art 28(3)(f), Art 35-36',
      delivered_by: 'GET /v1/privacy/processing-record (processing categories, retention in effect, configured integrations) plus docs/DATA_INVENTORY.md',
    },
    {
      duty: 'Make available the information necessary to demonstrate compliance and allow for audits.',
      article: 'Art 28(3)(h)',
      delivered_by: 'GET /v1/privacy/processing-record, GET /v1/audit-logs, and control evidence under SOC2-06',
    },
    {
      duty: 'Delete or return personal data at the end of the provision of services.',
      article: 'Art 28(3)(g)',
      delivered_by: 'GET /v1/privacy/export-recipient for return; account closure triggers erasure under BASE-03. Regulatory retention locks (SEC-04) and legal holds override deletion where law requires.',
    },
  ];
}

export class ProcessorAssistanceError extends Error {
  readonly code = 'not_found';
}

export interface ProcessingRecord {
  /** Art 30(2)(a): the controller this record is produced for. */
  controller_customer_id: string;
  generated_at: string;
  processing: {
    categories: string[];
    data_subjects: string[];
    personal_data_categories: string[];
    retention_in_effect: { message_bodies_days: number; events_days: number; tenant_specific: boolean };
  };
  configured_integrations: Array<{ integration: string; personal_data: string }>;
  security_measures: SecurityMeasure[];
  assistance: AssistanceCommitment[];
  summary: {
    measures_total: number;
    enforced: number;
    configured: number;
    not_enabled: number;
    policy_only: number;
    /** Called out explicitly so a controller does not have to diff the list. */
    not_enabled_ids: string[];
  };
  /** Stated in the payload itself so it cannot be separated from the data. */
  scope_note: string;
}

/**
 * The Art 30(2) record of processing carried out on behalf of one controller,
 * with the Art 32 schedule and Art 28(3) commitments attached.
 */
export async function processingRecord(customerId: string): Promise<ProcessingRecord> {
  const measures = await securityMeasures(customerId);
  const retention = await resolveTenantRetention(customerId);
  const count = (s: MeasureState) => measures.filter((m) => m.state === s).length;

  return {
    controller_customer_id: customerId,
    generated_at: new Date().toISOString(),
    processing: {
      categories: [
        'Transmission of email messages composed by the controller',
        'Delivery status and engagement event recording',
        'Suppression and consent state management',
        'Abuse and deliverability protection',
        'Data subject request handling on the controller\'s instruction',
      ],
      data_subjects: [
        'Recipients of the controller\'s messages',
        'The controller\'s own account users',
      ],
      personal_data_categories: [
        'Email addresses',
        'Message content supplied by the controller',
        'Delivery and engagement events, including timestamps and coarse client information',
        'Account user identity and authentication metadata',
      ],
      retention_in_effect: {
        message_bodies_days: retention.bodyDays,
        events_days: retention.eventsDays,
        tenant_specific: retention.explicit,
      },
    },
    configured_integrations: configuredIntegrations(),
    security_measures: measures,
    assistance: assistanceCommitments(),
    summary: {
      measures_total: measures.length,
      enforced: count('enforced'),
      configured: count('configured'),
      not_enabled: count('not_enabled'),
      policy_only: count('policy_only'),
      not_enabled_ids: measures.filter((m) => m.state === 'not_enabled').map((m) => m.id),
    },
    scope_note:
      'Generated from this tenant\'s live configuration. "enforced" means the platform makes the measure true by construction; ' +
      '"configured" means it is currently switched on and could be switched off; "policy_only" means it is an organizational ' +
      'commitment with no technical enforcement in the platform. Measures that are off are listed with state "not_enabled" ' +
      'rather than omitted. This record does not name subprocessors — that is a deployment fact (docs/VENDOR_REGISTER.md) — ' +
      'and it is not an independent assessment or a certification.',
  };
}
