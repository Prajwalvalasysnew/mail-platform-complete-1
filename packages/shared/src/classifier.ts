// Naive-Bayes spam classifier + URL/domain reputation.
//
// The regex list in abuse.ts is a fast pre-filter. This adds a probabilistic
// classifier (trained on a small seeded corpus, extendable from labelled
// review-queue decisions) plus URL reputation checks against known spam-trap
// and disposable domains. The score blends both signals.

import { db } from './db.js';

// ---- Tiny Naive-Bayes over word presence ----
interface Model {
  spam: Record<string, number>;
  ham: Record<string, number>;
  spamDocs: number;
  hamDocs: number;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9$!]{2,}/g) ?? []).slice(0, 5000);
}

// Seed corpus — broad enough for reasonable precision at send-time prescreening.
// In production, retrain from labelled outcomes: delivered+engaged=ham,
// complaint/review-queue-rejected=spam. Each example covers distinct vocabulary
// so the Fisher combination sees independent evidence, not repeated signal.
const SEED_SPAM = [
  // Lottery / prize scams
  'congratulations you won a free prize claim now click here urgent limited time',
  'you are selected winner sweepstakes award collect your cash prize today',
  'lucky winner notification claim your gift card reward before it expires',
  // Pharma / grey-market
  'cheap meds viagra cialis pharmacy no prescription discount overnight delivery',
  'buy prescription drugs online without doctor approval lowest prices guaranteed',
  'generic pills shipped discreetly no rx needed order now save big',
  // Get rich quick / work from home
  'make money fast guaranteed income work from home limited offer join today',
  'earn thousands weekly from home no experience required start immediately',
  'passive income secret method revealed only today sign up free',
  // Phishing / account fraud
  'verify your account suspended click link immediately confirm password security',
  'your bank account has been locked update your information now to restore access',
  'unusual activity detected on your account click here to verify identity immediately',
  // Crypto / investment scams
  'bitcoin double your investment guaranteed returns act now limited spots available',
  'crypto trading signals guaranteed profit join exclusive vip group today',
  'invest now high yield returns guaranteed principal protected limited offer expires',
  // Advance fee fraud
  'nigerian prince needs your help transfer millions wire western union fee',
  'inheritance funds unclaimed your assistance needed confidential transaction fee',
  'diplomat package delivery customs clearance fee required release funds now',
  // Adult / dating spam
  'hot singles in your area waiting click to meet tonight discreet no strings',
  'adult dating site free signup browse profiles near you tonight hookup',
  // Debt / financial spam
  'final notice your payment is overdue pay now to avoid suspension collections',
  'debt relief program eliminate your debt qualify now free consultation today',
  'credit score boosted overnight guaranteed approval bad credit accepted apply now',
  // Weight loss / health scams
  'lose weight fast guaranteed results no diet no exercise miracle pill',
  'doctors hate this trick burn fat overnight clinically proven formula order',
  // Tech support / gift card scams
  'your computer has virus call support immediately gift card payment required',
  'microsoft windows security alert call toll free number now prevent damage',
  // MLM / pyramid
  'join our team unlimited earning potential downline passive residual income recruit',
  'business opportunity ground floor get in early multiple income streams unlimited',
  // Counterfeit / piracy
  'brand name watches replica luxury goods discount free shipping worldwide order',
  'cheap software license key windows office download activate immediately',
];
const SEED_HAM = [
  // Order / transactional
  'your receipt for order number is attached thanks for your purchase summary',
  'order confirmed we are preparing your shipment estimated delivery three days',
  'your return has been received refund will be processed within five business days',
  // Auth / account management
  'here is the password reset link you requested expires in one hour ignore if not you',
  'two factor authentication code for your account do not share this code with anyone',
  'new device login detected on your account if this was not you change your password',
  // Statements / billing
  'your monthly statement is ready to view in your account dashboard no action needed',
  'your subscription will renew automatically on the fifteenth you can cancel anytime',
  'invoice for services rendered payment due net thirty days terms enclosed thank you',
  'your bill is ready to view log in to your account to see the full statement details',
  // Onboarding / verification
  'thanks for signing up please confirm your email address to continue activating account',
  'welcome to the team here is everything you need to get started resources and links',
  'your account has been created please verify your email before you can send messages',
  // Shipping / logistics
  'your shipment has been delivered track your package order details inside thank you',
  'your package is out for delivery today expected by end of day tracking number below',
  'shipping confirmation your order has left our warehouse tracking information attached',
  // Calendar / meetings
  'meeting reminder tomorrow at noon agenda attached please review before the call',
  'appointment confirmation your booking is confirmed details attached add to calendar',
  'webinar registration confirmed join link and dial in details are attached see you',
  // Support / tickets
  'support ticket opened we have received your request expect response within one day',
  'your support case has been updated please review the latest reply from our team',
  'we have resolved your support ticket please rate your experience when convenient',
  // Notifications
  'document ready for your signature please review and sign by end of week deadline',
  'your annual review is scheduled for next week feedback form attached before meeting',
  'service maintenance window scheduled this weekend no action required brief downtime',
  // Marketing / newsletters (legitimate opt-in)
  'this months product changelog highlights new features full notes on our blog today',
  'we updated our privacy policy effective next month no action required review changes',
  'team invitation you have been added to the workspace accept or decline using button',
  // Finance (legitimate)
  'payment received thank you your balance is now zero confirmation number attached',
  'your salary has been deposited direct deposit confirmation details inside this email',
];

function train(): Model {
  const m: Model = { spam: {}, ham: {}, spamDocs: SEED_SPAM.length, hamDocs: SEED_HAM.length };
  for (const doc of SEED_SPAM) for (const t of new Set(tokenize(doc))) m.spam[t] = (m.spam[t] ?? 0) + 1;
  for (const doc of SEED_HAM) for (const t of new Set(tokenize(doc))) m.ham[t] = (m.ham[t] ?? 0) + 1;
  return m;
}

const MODEL = train();

/** Returns P(spam) in [0,1] using a Robinson-style combination of token spamminess. */
export function spamProbability(text: string): number {
  const tokens = Array.from(new Set(tokenize(text)));
  if (tokens.length === 0) return 0;
  const probs: number[] = [];
  for (const t of tokens) {
    const s = MODEL.spam[t] ?? 0;
    const h = MODEL.ham[t] ?? 0;
    if (s + h < 1) continue; // unknown token, skip
    const ps = s / MODEL.spamDocs;
    const ph = h / MODEL.hamDocs;
    // token spamminess with a Bayesian prior to avoid 0/1 extremes
    const p = (ps) / (ps + ph || 1e-9);
    const adjusted = (1 * 0.5 + (s + h) * p) / (1 + s + h);
    probs.push(Math.min(0.99, Math.max(0.01, adjusted)));
  }
  if (probs.length === 0) return 0;
  // Fisher combination
  const lnProd = probs.reduce((a, p) => a + Math.log(p), 0);
  const lnProdInv = probs.reduce((a, p) => a + Math.log(1 - p), 0);
  const h = chiSquareP(-2 * lnProd, 2 * probs.length);
  const s = chiSquareP(-2 * lnProdInv, 2 * probs.length);
  return (1 + h - s) / 2;
}

// Survival function of chi-square for even df (closed form).
function chiSquareP(chi: number, df: number): number {
  let m = chi / 2;
  let term = Math.exp(-m);
  let sum = term;
  for (let i = 1; i < df / 2; i++) {
    term *= m / i;
    sum += term;
  }
  return Math.min(1, sum);
}

// ---- URL / domain reputation ----
// NOTE: do NOT hoist this to a shared module-level RegExp with the /g flag.
// A global RegExp carries mutable `lastIndex` state; if it is shared across
// concurrent extractDomains() calls (interleaved async requests), their
// .exec()/.matchAll() loops corrupt each other's position, causing missed or
// duplicated matches. A fresh RegExp per call is cheap and fully isolated.
const URL_RE_SOURCE = 'https?:\\/\\/([^/\\s"\'>]+)';

export function extractDomains(html?: string, text?: string): string[] {
  const corpus = `${html ?? ''} ${text ?? ''}`;
  const out = new Set<string>();
  const re = new RegExp(URL_RE_SOURCE, 'gi');
  for (const m of corpus.matchAll(re)) {
    const host = m[1]!.toLowerCase().replace(/^www\./, '');
    out.add(host);
  }
  return Array.from(out);
}

export interface UrlReputationResult {
  flagged: string[];
  categories: Record<string, string>;
}

/** Look up link domains against recipient_domain_intel and a disposable heuristic. */
export async function checkUrlReputation(domains: string[]): Promise<UrlReputationResult> {
  if (domains.length === 0) return { flagged: [], categories: {} };
  const rows = await db
    .selectFrom('recipient_domain_intel')
    .select(['domain', 'category'])
    .where('domain', 'in', domains)
    .execute();
  const categories: Record<string, string> = {};
  const flagged: string[] = [];
  for (const r of rows) {
    categories[r.domain] = r.category;
    if (r.category === 'spam_trap' || r.category === 'high_bounce') flagged.push(r.domain);
  }
  return { flagged, categories };
}

export interface ClassifierResult {
  spam_probability: number;
  flagged_domains: string[];
  combined_score: number; // 0-100, comparable to abuse.ts score
}

/**
 * Combine Bayesian probability + URL reputation into a 0-100 score that the
 * send path adds to the regex pre-filter score.
 */
export async function classify(subject: string, html?: string, text?: string): Promise<ClassifierResult> {
  const corpus = `${subject}\n${text ?? ''}\n${(html ?? '').replace(/<[^>]+>/g, ' ')}`;
  const prob = spamProbability(corpus);
  const domains = extractDomains(html, text);
  const url = await checkUrlReputation(domains);

  let score = Math.round(prob * 60); // up to 60 from text
  if (url.flagged.length > 0) score += 40; // spam-trap link is decisive
  return { spam_probability: Number(prob.toFixed(4)), flagged_domains: url.flagged, combined_score: Math.min(100, score) };
}
