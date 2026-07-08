import type { SupportTicketCategory, SupportTicketPriority } from './schema.js';

export interface SupportTicketTriageInput {
  subject: string;
  messages: Array<{ body: string; internal?: boolean; author_type?: string }>;
  customer?: { tier?: string | null; status?: string | null; billing_status?: string | null };
}

export interface SupportTicketTriageResult {
  summary: string;
  suggested_priority: SupportTicketPriority;
  suggested_category: SupportTicketCategory;
  confidence: number;
  labels: string[];
  model: string;
}

export interface InferenceProvider {
  name: string;
  triageSupportTicket(input: SupportTicketTriageInput): Promise<SupportTicketTriageResult>;
  suggestSupportReply(input: SupportReplySuggestionInput): Promise<SupportReplySuggestionResult>;
}

export interface SupportReplySuggestionInput {
  subject: string;
  category: SupportTicketCategory;
  messages: Array<{ body: string; internal?: boolean; author_type?: string }>;
  agentName?: string;
}

export interface SupportReplySuggestionResult {
  draft: string;
  model: string;
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((t) => text.includes(t));
}

function clampConfidence(n: number): number {
  return Math.max(0, Math.min(1, Number(n.toFixed(4))));
}

export class LocalHeuristicInferenceProvider implements InferenceProvider {
  name = 'local-heuristic-v1';

  async triageSupportTicket(input: SupportTicketTriageInput): Promise<SupportTicketTriageResult> {
    const visible = input.messages.filter((m) => !m.internal);
    const text = `${input.subject}\n${visible.map((m) => m.body).join('\n')}`.toLowerCase();
    const labels: string[] = [];

    let category: SupportTicketCategory = 'general';
    if (includesAny(text, ['invoice', 'billing', 'payment', 'card', 'refund', 'stripe'])) category = 'billing';
    else if (includesAny(text, ['bounce', 'blocked', 'blocklist', 'spamhaus', 'gmail', 'yahoo', 'deferral', 'deliverability'])) category = 'deliverability';
    else if (includesAny(text, ['api', 'webhook', 'sdk', 'error', 'timeout', 'integration', 'dns', 'dkim', 'spf', 'dmarc'])) category = 'technical';
    else if (includesAny(text, ['abuse', 'phishing', 'spam', 'complaint', 'compromised'])) category = 'abuse';
    else if (includesAny(text, ['login', 'password', 'mfa', 'account', 'invite', 'team'])) category = 'account';
    labels.push(category);

    let priority: SupportTicketPriority = 'normal';
    if (includesAny(text, ['urgent', 'down', 'outage', 'cannot send', 'production blocked', 'all mail failing', 'compromised'])) priority = 'urgent';
    else if (includesAny(text, ['blocked', 'failed', 'hard bounce', 'payment failed', 'cannot login'])) priority = 'high';
    else if (includesAny(text, ['question', 'how do i', 'can you explain'])) priority = 'low';
    labels.push(priority);

    const firstBody = visible[0]?.body ?? input.subject;
    const compact = firstBody.replace(/\s+/g, ' ').trim();
    const summary = compact.length > 240 ? `${compact.slice(0, 237)}...` : compact || input.subject;

    const confidence = clampConfidence(0.55 + (category !== 'general' ? 0.2 : 0) + (priority !== 'normal' ? 0.1 : 0));
    return { summary, suggested_priority: priority, suggested_category: category, confidence, labels: [...new Set(labels)], model: this.name };
  }

  async suggestSupportReply(input: SupportReplySuggestionInput): Promise<SupportReplySuggestionResult> {
    // A grounded, safe scaffold for the agent to edit — never auto-sent. It
    // acknowledges the latest customer message and adds a category-specific
    // next step. A real LLM provider would replace this via setInferenceProvider.
    const lastCustomer = [...input.messages].reverse().find((m) => !m.internal && m.author_type === 'customer_user');
    const gist = (lastCustomer?.body ?? input.subject).replace(/\s+/g, ' ').trim().slice(0, 160);
    const nextStep: Record<SupportTicketCategory, string> = {
      general: 'Could you share a bit more detail so we can point you in the right direction?',
      billing: 'I\u2019m reviewing your billing details now and will confirm the charge and any adjustment.',
      deliverability: 'Could you share an affected recipient domain and a recent message ID? That lets us check bounce logs and reputation.',
      technical: 'Could you share the request/response (or error and timestamp) so we can trace it on our side?',
      abuse: 'We take this seriously and are reviewing the account activity now.',
      account: 'I can help with that \u2014 can you confirm the email address on the account so I can verify it securely?',
    };
    const agent = input.agentName ? input.agentName : 'the support team';
    const draft =
      `Hi,\n\nThanks for reaching out, and sorry for the trouble. I understand the issue is: \u201c${gist}\u201d.\n\n` +
      `${nextStep[input.category]}\n\nWe\u2019ll keep this ticket updated until it\u2019s resolved.\n\nBest,\n${agent}`;
    return { draft, model: this.name };
  }
}

let provider: InferenceProvider | null = null;

export function getInferenceProvider(): InferenceProvider {
  if (!provider) provider = new LocalHeuristicInferenceProvider();
  return provider;
}

export function setInferenceProvider(next: InferenceProvider | null): void {
  provider = next;
}
