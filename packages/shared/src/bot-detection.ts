// Open/click bot & machine-event detection.
//
// Email "opens" and "clicks" are notoriously noisy. A large and growing share of
// recorded opens are not humans:
//   - Apple Mail Privacy Protection (MPP) pre-fetches every tracking pixel from
//     Apple's proxy the moment mail is delivered, regardless of whether the user
//     ever opens it. Since iOS 15 this is the single largest source of fake opens.
//   - Corporate security gateways (Microsoft Defender for Office 365 "Safe Links",
//     Proofpoint URLDefense, Barracuda, Mimecast, Cisco) pre-fetch/scan every
//     link and image in an email before delivery to detect phishing/malware.
//   - Gmail's image proxy (GoogleImageProxy) fetches images server-side.
//   - Generic bots, crawlers, and monitoring tools.
//
// A naive tracker counts all of these as engagement, which (a) inflates open/
// click rates into meaningless numbers and (b) corrupts any downstream logic
// that keys off engagement (re-engagement campaigns, send-time optimization,
// list hygiene). A production ESP must classify each event.
//
// This module blends several independent signals into a single verdict with a
// confidence score and a human-readable reason. No single signal is trusted
// alone; the combination is what makes it accurate. The verdict is advisory and
// fully transparent — the raw event is still recorded, just flagged — so nothing
// is silently dropped and the heuristics can be tuned from real data.

export type BotVerdict = 'human' | 'bot' | 'suspicious';

export interface BotSignal {
  name: string;
  // Positive weight = more bot-like; negative = more human-like.
  weight: number;
  detail?: string;
}

export interface BotClassification {
  verdict: BotVerdict;
  // 0..1 — confidence that the event is machine-generated (not human).
  botScore: number;
  reasons: string[];
  signals: BotSignal[];
  // Convenience: should this event count toward human engagement metrics?
  countsAsHuman: boolean;
}

export interface BotDetectionInput {
  userAgent?: string | null;
  ip?: string | null;
  eventType: 'opened' | 'clicked';
  // Milliseconds between message delivery (or send) and this event, if known.
  // Very small values strongly indicate an automated pre-fetch.
  msSinceDelivery?: number | null;
  // For clicks: was there a prior *human* open on this message? A click with no
  // preceding human open is a classic scanner pattern.
  hadPriorHumanOpen?: boolean;
}

// ---------------------------------------------------------------------------
// Signal 1: known machine user-agents.
// Substrings are matched case-insensitively against the UA string. Sources:
// Apple MPP, major security gateways, image proxies, and common bot tokens.
// ---------------------------------------------------------------------------

interface UaRule { needle: string; label: string; verdict: 'bot' | 'suspicious'; }

const MACHINE_UA_RULES: UaRule[] = [
  // Image proxies (server-side fetch, never a human eyeball)
  { needle: 'googleimageproxy', label: 'Gmail image proxy', verdict: 'bot' },
  { needle: 'ggpht.com', label: 'Google proxy', verdict: 'bot' },
  { needle: 'yahoomailproxy', label: 'Yahoo mail proxy', verdict: 'bot' },
  // Apple Mail Privacy Protection: the open comes from Apple's relay and the UA
  // is a generic Mozilla string, so UA alone is weak — IP + timing carry it.
  // Security gateways / link scanners
  { needle: 'barracuda', label: 'Barracuda security gateway', verdict: 'bot' },
  { needle: 'proofpoint', label: 'Proofpoint', verdict: 'bot' },
  { needle: 'urldefense', label: 'Proofpoint URLDefense', verdict: 'bot' },
  { needle: 'mimecast', label: 'Mimecast', verdict: 'bot' },
  { needle: 'microsoft-companionapp', label: 'Microsoft scanner', verdict: 'bot' },
  { needle: 'bingpreview', label: 'Bing preview', verdict: 'bot' },
  { needle: 'msoffice', label: 'MS Office prefetch', verdict: 'suspicious' },
  { needle: 'symantec', label: 'Symantec gateway', verdict: 'bot' },
  { needle: 'mailscanner', label: 'MailScanner', verdict: 'bot' },
  { needle: 'cloudmark', label: 'Cloudmark', verdict: 'bot' },
  { needle: 'forcepoint', label: 'Forcepoint gateway', verdict: 'bot' },
  { needle: 'cisco', label: 'Cisco security', verdict: 'suspicious' },
  // Generic automation / crawlers
  { needle: 'bot', label: 'generic bot token', verdict: 'suspicious' },
  { needle: 'crawler', label: 'crawler', verdict: 'suspicious' },
  { needle: 'spider', label: 'spider', verdict: 'suspicious' },
  { needle: 'curl/', label: 'curl', verdict: 'bot' },
  { needle: 'wget/', label: 'wget', verdict: 'bot' },
  { needle: 'python-requests', label: 'python-requests', verdict: 'bot' },
  { needle: 'python-urllib', label: 'python urllib', verdict: 'bot' },
  { needle: 'go-http-client', label: 'Go http client', verdict: 'bot' },
  { needle: 'java/', label: 'Java http client', verdict: 'bot' },
  { needle: 'okhttp', label: 'OkHttp client', verdict: 'bot' },
  { needle: 'headlesschrome', label: 'headless Chrome', verdict: 'bot' },
  { needle: 'phantomjs', label: 'PhantomJS', verdict: 'bot' },
  { needle: 'apache-httpclient', label: 'Apache HttpClient', verdict: 'bot' },
  { needle: 'monitoring', label: 'monitoring agent', verdict: 'suspicious' },
  { needle: 'uptime', label: 'uptime monitor', verdict: 'suspicious' },
];

function matchMachineUa(ua: string): UaRule | null {
  const s = ua.toLowerCase();
  for (const rule of MACHINE_UA_RULES) {
    if (s.includes(rule.needle)) return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signal 2: datacenter / mail-provider / security-vendor IP ranges.
// Real recipients open mail from residential / mobile / corporate-egress IPs.
// An open from an AWS/GCP/Azure range or a known proxy range is a machine.
//
// This is a curated, conservative starter set covering the highest-volume
// offenders. In production you would augment this from an IP-intelligence feed
// (e.g. an ASN/datacenter dataset refreshed regularly); the matcher below works
// for any CIDR list you load.
// ---------------------------------------------------------------------------

const DATACENTER_CIDRS: Array<{ cidr: string; label: string }> = [
  // Apple Mail Privacy Protection relay egress (Apple Private Relay / iCloud).
  { cidr: '17.0.0.0/8', label: 'Apple (MPP relay)' },
  // Google (Gmail image proxy, GCP).
  { cidr: '66.249.80.0/20', label: 'Google proxy' },
  { cidr: '64.233.160.0/19', label: 'Google' },
  { cidr: '209.85.128.0/17', label: 'Google' },
  { cidr: '172.217.0.0/16', label: 'Google' },
  { cidr: '35.190.0.0/17', label: 'Google Cloud' },
  { cidr: '34.64.0.0/10', label: 'Google Cloud' },
  // Microsoft / Outlook / Defender / Azure.
  { cidr: '40.92.0.0/15', label: 'Microsoft Outlook/Defender' },
  { cidr: '40.107.0.0/16', label: 'Microsoft Exchange Online' },
  { cidr: '52.100.0.0/14', label: 'Microsoft' },
  { cidr: '13.64.0.0/11', label: 'Azure' },
  { cidr: '20.0.0.0/8', label: 'Azure' },
  // Amazon AWS (broad; many scanners and proxies run here).
  { cidr: '3.0.0.0/9', label: 'AWS' },
  { cidr: '18.32.0.0/11', label: 'AWS' },
  { cidr: '52.0.0.0/11', label: 'AWS' },
  { cidr: '54.144.0.0/12', label: 'AWS' },
  // Proofpoint.
  { cidr: '67.231.144.0/20', label: 'Proofpoint' },
  { cidr: '148.163.128.0/17', label: 'Proofpoint' },
  // Mimecast.
  { cidr: '205.139.110.0/24', label: 'Mimecast' },
  { cidr: '195.130.217.0/24', label: 'Mimecast' },
  // Barracuda.
  { cidr: '64.235.144.0/20', label: 'Barracuda' },
];

// Parse an IPv4 dotted-quad to a uint32. Returns null for non-IPv4 / invalid.
function ipv4ToInt(ip: string): number | null {
  // Strip an IPv4-mapped IPv6 prefix (::ffff:1.2.3.4) which trustProxy can yield.
  const cleaned = ip.replace(/^::ffff:/i, '');
  const parts = cleaned.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function cidrContains(cidr: string, ipInt: number): boolean {
  const [base, bitsStr] = cidr.split('/') as [string, string];
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const bits = Number(bitsStr);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function matchDatacenter(ip: string): string | null {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return null; // IPv6 or invalid — no match in this set
  for (const { cidr, label } of DATACENTER_CIDRS) {
    if (cidrContains(cidr, ipInt)) return label;
  }
  return null;
}

// Timing threshold: an open/click within this window of delivery is almost
// certainly an automated pre-fetch (a human can't realistically receive, open,
// and render an email this fast).
const PREFETCH_MS = 2000;
// A slightly wider window that is suspicious but not conclusive on its own.
const FAST_MS = 5000;

/**
 * Classify an open/click event as human, bot, or suspicious by blending
 * user-agent, IP, timing, and click-without-open signals.
 *
 * Decision rule:
 *   - Any single strong "bot" signal (machine UA flagged 'bot', datacenter IP,
 *     sub-2s prefetch) => verdict 'bot'.
 *   - Accumulated weaker signals crossing a threshold => 'suspicious'.
 *   - Otherwise 'human'.
 */
export function classifyEngagement(input: BotDetectionInput): BotClassification {
  const signals: BotSignal[] = [];
  const ua = (input.userAgent ?? '').trim();
  const ip = (input.ip ?? '').trim();

  // --- User-agent signals ---
  if (ua.length === 0) {
    signals.push({ name: 'empty_user_agent', weight: 0.5, detail: 'no User-Agent header' });
  } else {
    const uaRule = matchMachineUa(ua);
    if (uaRule) {
      signals.push({
        name: 'machine_user_agent',
        weight: uaRule.verdict === 'bot' ? 1.0 : 0.5,
        detail: uaRule.label,
      });
    }
  }

  // --- IP / datacenter signal ---
  if (ip) {
    const dc = matchDatacenter(ip);
    if (dc) {
      signals.push({ name: 'datacenter_ip', weight: 1.0, detail: dc });
    }
  }

  // --- Timing signal ---
  if (typeof input.msSinceDelivery === 'number' && input.msSinceDelivery >= 0) {
    if (input.msSinceDelivery <= PREFETCH_MS) {
      signals.push({
        name: 'prefetch_timing',
        weight: 1.0,
        detail: `${input.msSinceDelivery}ms after delivery (<= ${PREFETCH_MS}ms)`,
      });
    } else if (input.msSinceDelivery <= FAST_MS) {
      signals.push({
        name: 'fast_timing',
        weight: 0.4,
        detail: `${input.msSinceDelivery}ms after delivery`,
      });
    }
  }

  // --- Click-without-human-open signal ---
  if (input.eventType === 'clicked' && input.hadPriorHumanOpen === false) {
    signals.push({
      name: 'click_without_open',
      weight: 0.5,
      detail: 'click with no preceding human open',
    });
  }

  // --- Blend ---
  // A strong signal (weight >= 1.0) is decisive. Otherwise accumulate.
  const hasStrong = signals.some((s) => s.weight >= 1.0);
  const total = signals.reduce((acc, s) => acc + s.weight, 0);
  // Squash to 0..1 for a readable confidence.
  const botScore = Math.max(0, Math.min(1, hasStrong ? Math.max(0.85, total / 2) : total / 2));

  let verdict: BotVerdict;
  if (hasStrong) {
    verdict = 'bot';
  } else if (total >= 0.5) {
    verdict = 'suspicious';
  } else {
    verdict = 'human';
  }

  const reasons = signals.map((s) => (s.detail ? `${s.name}: ${s.detail}` : s.name));
  if (reasons.length === 0) reasons.push('no machine signals detected');

  return {
    verdict,
    botScore: Number(botScore.toFixed(3)),
    reasons,
    signals,
    countsAsHuman: verdict === 'human',
  };
}

// Exported for testing and for callers that want to extend the rule sets.
export const _internal = {
  matchMachineUa,
  matchDatacenter,
  ipv4ToInt,
  cidrContains,
  PREFETCH_MS,
  FAST_MS,
  DATACENTER_CIDRS,
  MACHINE_UA_RULES,
};
