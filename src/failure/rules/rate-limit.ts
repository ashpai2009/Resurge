import type { DetectionInput, FailureEvent } from '../../types/failure.js';
import { SOURCE_CONFIDENCE_CEILING } from '../../types/failure.js';
import { collectEvidence, hasErrorContext } from '../evidence.js';
import { parseResetTime } from '../reset-time.js';
import type { Clock } from '../../util/clock.js';

/**
 * Patterns that name a quota problem outright. These carry their own meaning
 * and need no corroboration.
 */
const STRONG = [
  /usage limit reached/i,
  /\byou(?:'ve| have) (?:hit|reached) your (?:usage )?limit/i,
  /\brate[- ]?limit(?:ed|ing)?\b/i,
  /\bquota (?:exceeded|exhausted)\b/i,
  /\bout of (?:credits|quota)\b/i,
  /\btoo many requests\b/i,
  /\binsufficient_quota\b/i,
];

/** Ambiguous on its own: a 429 in prose could be anything. */
const WEAK = [/\b429\b/];

export function makeRateLimitRule(clock: Clock) {
  return {
    type: 'RATE_LIMIT' as const,
    detect(input: DetectionInput): FailureEvent | null {
      for (const ev of collectEvidence(input)) {
        const ceiling = SOURCE_CONFIDENCE_CEILING[ev.source];

        for (const re of STRONG) {
          const m = re.exec(ev.text);
          if (!m) continue;
          const line = lineAround(ev.text, m.index);
          const reset = parseResetTime(ev.text, clock);
          return {
            type: 'RATE_LIMIT',
            evidence: line,
            retryable: true,
            ...(reset ? { retryAfter: reset.toISOString() } : {}),
            confidence: Math.min(ceiling, 0.92),
            detectedAt: clock.now().toISOString(),
            source: ev.source,
          };
        }

        for (const re of WEAK) {
          const m = re.exec(ev.text);
          if (!m) continue;
          // On stdout a bare token must be corroborated; even then it stays
          // below the acceptance threshold and can only support, never decide.
          if (ev.source === 'stdout' && !hasErrorContext(ev.text, m.index)) continue;
          const reset = parseResetTime(ev.text, clock);
          return {
            type: 'RATE_LIMIT',
            evidence: lineAround(ev.text, m.index),
            retryable: true,
            ...(reset ? { retryAfter: reset.toISOString() } : {}),
            confidence: Math.min(ceiling, 0.75),
            detectedAt: clock.now().toISOString(),
            source: ev.source,
          };
        }
      }
      return null;
    },
  };
}

export function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const endRaw = text.indexOf('\n', index);
  const end = endRaw === -1 ? text.length : endRaw;
  return text.slice(start, end).trim().slice(0, 500);
}
