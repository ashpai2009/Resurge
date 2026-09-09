import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/util/clock.js';
import { parseResetTime } from '../../src/failure/reset-time.js';

/** 2026-09-08 22:00 local time. */
function clockAt(iso: string) {
  return new FakeClock(new Date(iso));
}

describe('reset-time parsing', () => {
  it('parses "try again at 1:30 AM" as the next occurrence, rolling past midnight', () => {
    const clock = clockAt('2026-09-08T22:00:00');
    const when = parseResetTime('usage limit reached. try again at 1:30 AM', clock);
    expect(when).not.toBeNull();
    expect(when!.getHours()).toBe(1);
    expect(when!.getMinutes()).toBe(30);
    // 22:00 -> 01:30 means tomorrow.
    expect(when!.getDate()).toBe(9);
  });

  it('keeps a wall-clock time later today on the same day', () => {
    const clock = clockAt('2026-09-08T09:00:00');
    const when = parseResetTime('resets at 11:30 AM', clock);
    expect(when!.getDate()).toBe(8);
    expect(when!.getHours()).toBe(11);
  });

  it('parses 24-hour times without a meridiem', () => {
    const clock = clockAt('2026-09-08T09:00:00');
    const when = parseResetTime('try again at 13:45', clock);
    expect(when!.getHours()).toBe(13);
    expect(when!.getMinutes()).toBe(45);
  });

  it('handles 12 AM and 12 PM correctly', () => {
    const clock = clockAt('2026-09-08T09:00:00');
    expect(parseResetTime('at 12:00 AM', clock)!.getHours()).toBe(0);
    expect(parseResetTime('at 12:00 PM', clock)!.getHours()).toBe(12);
  });

  it('parses relative offsets', () => {
    const clock = clockAt('2026-09-08T10:00:00Z');
    const base = clock.now().getTime();
    expect(parseResetTime('try again in 45 minutes', clock)!.getTime()).toBe(base + 45 * 60_000);
    expect(parseResetTime('retry in 2 hours', clock)!.getTime()).toBe(base + 2 * 3_600_000);
    expect(parseResetTime('back in 90 seconds', clock)!.getTime()).toBe(base + 90_000);
  });

  it('parses a retry-after header value as seconds', () => {
    const clock = clockAt('2026-09-08T10:00:00Z');
    const when = parseResetTime('HTTP 429\nretry-after: 3600', clock);
    expect(when!.getTime()).toBe(clock.now().getTime() + 3_600_000);
  });

  it('parses an ISO-8601 timestamp', () => {
    const clock = clockAt('2026-09-08T10:00:00Z');
    const when = parseResetTime('limit resets at 2026-09-08T11:30:00Z', clock);
    expect(when!.toISOString()).toBe('2026-09-08T11:30:00.000Z');
  });

  it('prefers an explicit retry-after over prose', () => {
    const clock = clockAt('2026-09-08T10:00:00Z');
    const when = parseResetTime('rate limited, try again in 5 minutes\nretry-after: 60', clock);
    expect(when!.getTime()).toBe(clock.now().getTime() + 60_000);
  });

  it('returns null when nothing parses, so the planner falls back to backoff', () => {
    const clock = clockAt('2026-09-08T10:00:00Z');
    expect(parseResetTime('usage limit reached. please try again later.', clock)).toBeNull();
  });

  it('rejects a time in the past rather than sleeping on a bad number', () => {
    const clock = clockAt('2026-09-08T10:00:00Z');
    expect(parseResetTime('resets at 2020-01-01T00:00:00Z', clock)).toBeNull();
  });

  it('rejects a reset time more than 24 hours out', () => {
    const clock = clockAt('2026-09-08T10:00:00Z');
    expect(parseResetTime('resets at 2027-01-01T00:00:00Z', clock)).toBeNull();
    expect(parseResetTime('try again in 200 hours', clock)).toBeNull();
  });

  it('does not treat a bare number as a time', () => {
    const clock = clockAt('2026-09-08T10:00:00Z');
    expect(parseResetTime('processed at 42 files', clock)).toBeNull();
  });
});
