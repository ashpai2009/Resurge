import type { Clock } from '../util/clock.js';

/**
 * Extracts a rate-limit reset time from agent output.
 *
 * Everything resolves against an injected Clock: "try again at 1:30 AM" means
 * nothing without knowing what time it is now, and a wall-clock-reading parser
 * cannot be tested for the interesting case (the rollover past midnight).
 *
 * Returns null when nothing parses. That is a normal outcome, not a failure —
 * the planner falls back to configured backoff.
 */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

export function parseResetTime(text: string, clock: Clock): Date | null {
  const now = clock.now();
  for (const extract of EXTRACTORS) {
    const candidate = extract(text, now);
    if (candidate && isSane(candidate, now)) return candidate;
  }
  return null;
}

/**
 * A reset time in the past means we misread something, and one more than a day
 * out is almost certainly a date parsed out of unrelated text. Either way,
 * backoff is a better answer than sleeping on a bad number.
 */
function isSane(when: Date, now: Date): boolean {
  const delta = when.getTime() - now.getTime();
  return Number.isFinite(delta) && delta > 0 && delta <= MAX_FUTURE_MS;
}

type Extractor = (text: string, now: Date) => Date | null;

/** `retry-after: 3600` — a header-style value, always in seconds. */
const retryAfterHeader: Extractor = (text, now) => {
  const m = /retry[-_ ]?after\s*[:=]\s*(\d{1,6})\b/i.exec(text);
  if (!m) return null;
  return new Date(now.getTime() + Number(m[1]) * 1000);
};

/** `try again in 45 minutes`, `retry in 2 hours`, `in 90 seconds`. */
const relative: Extractor = (text, now) => {
  const m = /\bin\s+(\d{1,5})\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const ms = unit.startsWith('s')
    ? value * 1000
    : unit.startsWith('m')
      ? value * 60_000
      : value * 3_600_000;
  return new Date(now.getTime() + ms);
};

/** A full ISO-8601 timestamp, e.g. `resets at 2026-09-08T01:30:00Z`. */
const iso: Extractor = (text) => {
  const m = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/.exec(text);
  if (!m) return null;
  const parsed = new Date(m[1]!.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * `try again at 1:30 AM`, `resets at 01:30`, `available again at 11 PM`.
 *
 * Interpreted as the next occurrence of that wall-clock time in local time: if
 * it has already passed today, it means tomorrow. This is the rollover case
 * that makes the injected clock worth having.
 */
const wallClock: Extractor = (text, now) => {
  const m =
    /\b(?:at|until|after)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(text);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3]?.toLowerCase().replace(/\./g, '');

  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else {
    // Without am/pm this is only a time if it looks like one (had minutes).
    if (m[2] === undefined) return null;
    if (hour > 23) return null;
  }

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
};

// Order matters: an explicit retry-after header beats prose, and an ISO
// timestamp is more precise than a bare wall-clock time.
const EXTRACTORS: Extractor[] = [retryAfterHeader, iso, relative, wallClock];
