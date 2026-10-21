// Time-zone aware scheduling helpers for workflows: delivery windows, quiet
// hours ("send window") and "continue at 09:00 in the contact's time zone".
// Pure functions over Intl so DST transitions are handled by the platform's
// tz database; no third-party date library.

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(date: Date, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(out.weekday!),
  };
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** The zone to use: an explicit IANA zone, or the contact's (falling back to the given default, then UTC). */
export function resolveTimeZone(setting: string | undefined, contactTz: unknown, fallback = 'UTC'): string {
  if (setting && setting !== 'contact' && isValidTimeZone(setting)) return setting;
  if (typeof contactTz === 'string' && isValidTimeZone(contactTz)) return contactTz;
  return isValidTimeZone(fallback) ? fallback : 'UTC';
}

/** UTC instant of a wall-clock time in a zone (DST-correct: two-pass offset). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (at: number) => {
    const p = parts(new Date(at), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
  };
  let utc = guess - offset(guess);
  utc = guess - offset(utc);
  return new Date(utc);
}

export function parseClock(value: string): { hour: number; minute: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) throw new Error(`Invalid time '${value}'`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}
const minutesOf = (c: { hour: number; minute: number }) => c.hour * 60 + c.minute;

export interface ClockWindow {
  start: string; // 'HH:MM' local
  end: string; // 'HH:MM' local; end < start means the window spans midnight
  days?: number[]; // allowed local weekdays (0=Sun); empty/undefined = every day
}

/** Is `at` inside the window in `timeZone`? */
export function inWindow(at: Date, window: ClockWindow, timeZone: string): boolean {
  const p = parts(at, timeZone), now = p.hour * 60 + p.minute;
  const s = minutesOf(parseClock(window.start)), e = minutesOf(parseClock(window.end));
  const days = window.days?.length ? window.days : null;
  if (s === e) return !days || days.includes(p.weekday);
  if (s < e) return now >= s && now < e && (!days || days.includes(p.weekday));
  // Overnight window: the part after midnight belongs to the previous day's window.
  if (now >= s) return !days || days.includes(p.weekday);
  if (now < e) return !days || days.includes((p.weekday + 6) % 7);
  return false;
}

/** Earliest instant >= `from` that is inside the window (searches up to 8 days). */
export function nextWindowStart(from: Date, window: ClockWindow, timeZone: string): Date {
  if (inWindow(from, window, timeZone)) return from;
  const start = parseClock(window.start);
  for (let d = 0; d <= 8; d++) {
    const local = parts(new Date(from.getTime() + d * 86_400_000), timeZone);
    const candidate = zonedTimeToUtc(local.year, local.month, local.day, start.hour, start.minute, timeZone);
    if (candidate.getTime() >= from.getTime() && inWindow(candidate, window, timeZone)) return candidate;
  }
  return from; // Misconfigured window (no allowed days): never block forever.
}

/** Next occurrence of a local clock time (optionally on allowed weekdays), strictly after `from`. */
export function nextClockTime(from: Date, clock: string, timeZone: string, days?: number[]): Date {
  const c = parseClock(clock);
  for (let d = 0; d <= 8; d++) {
    const local = parts(new Date(from.getTime() + d * 86_400_000), timeZone);
    const candidate = zonedTimeToUtc(local.year, local.month, local.day, c.hour, c.minute, timeZone);
    if (candidate.getTime() > from.getTime() && (!days?.length || days.includes(parts(candidate, timeZone).weekday))) return candidate;
  }
  return new Date(from.getTime() + 86_400_000);
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDate(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Parse a date-like value (ISO string, epoch ms/seconds, Date). */
export function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value);
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00Z` : value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** 'now', 'now-7d', 'now+2h' or an absolute date, relative to `now`. */
export function resolveRelativeDate(value: unknown, now = new Date()): Date | null {
  if (typeof value === 'string') {
    const m = /^now(?:([+-])(\d{1,5})([mhdw]))?$/.exec(value.trim());
    if (m) {
      if (!m[1]) return now;
      const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[3] as 'm' | 'h' | 'd' | 'w'];
      return new Date(now.getTime() + (m[1] === '-' ? -1 : 1) * Number(m[2]) * unit);
    }
  }
  return parseDateValue(value);
}
