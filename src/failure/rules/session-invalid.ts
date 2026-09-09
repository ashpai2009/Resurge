import type { DetectionInput, FailureEvent } from '../../types/failure.js';
import { SOURCE_CONFIDENCE_CEILING } from '../../types/failure.js';
import { collectEvidence } from '../evidence.js';
import { lineAround } from './rate-limit.js';
import type { Clock } from '../../util/clock.js';

/**
 * Explicit "that session does not exist" signals.
 *
 * This rule exists so that abandoning a session requires proof. Falling back to
 * a fresh session whenever a resume *fails* would throw away a perfectly good
 * session on a mere rate limit, losing all the agent's accumulated context.
 * Only these messages justify starting over.
 */
const PATTERNS = [
  /\bsession not found\b/i,
  /\bno such (?:session|thread|conversation)\b/i,
  /\binvalid (?:session|thread|conversation)(?: id)?\b/i,
  /\bunknown (?:session|thread|conversation)\b/i,
  /\b(?:session|thread|conversation) (?:has )?expired\b/i,
  /\bcould not (?:find|resume) (?:the )?(?:session|thread)\b/i,
];

export function makeSessionInvalidRule(clock: Clock) {
  return {
    type: 'SESSION_INVALID' as const,
    detect(input: DetectionInput): FailureEvent | null {
      for (const ev of collectEvidence(input)) {
        for (const re of PATTERNS) {
          const m = re.exec(ev.text);
          if (!m) continue;
          return {
            type: 'SESSION_INVALID',
            evidence: lineAround(ev.text, m.index),
            // Retryable, but only as a fresh session — never as the same one.
            retryable: true,
            confidence: Math.min(SOURCE_CONFIDENCE_CEILING[ev.source], 0.9),
            detectedAt: clock.now().toISOString(),
            source: ev.source,
          };
        }
      }
      return null;
    },
  };
}
