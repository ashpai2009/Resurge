import type { DetectionInput, FailureEvent } from '../../types/failure.js';
import { SOURCE_CONFIDENCE_CEILING } from '../../types/failure.js';
import { collectEvidence } from '../evidence.js';
import { lineAround } from './rate-limit.js';
import type { Clock } from '../../util/clock.js';

const PATTERNS = [
  /\bpanic:/i,
  /\bSegmentation fault\b/i,
  /\bAbort trap\b/i,
  /\bfatal error\b/i,
  /\bunhandled (?:exception|rejection)\b/i,
  /\bstack overflow\b/i,
  /\bJavaScript heap out of memory\b/i,
  /^\s*at\s+\S+\s+\(.*:\d+:\d+\)/m,
  /\bTraceback \(most recent call last\)/,
  /\bcommand not found\b/i,
  /\bENOENT\b.*\bspawn\b/i,
];

/**
 * Last rule in the chain: everything that ended badly and is not a rate limit,
 * a network failure or a dead session.
 *
 * Signal death is the strongest signal here and needs no output at all — a
 * SIGSEGV'd process may not have managed to print anything.
 */
export function makeCrashRule(clock: Clock) {
  return {
    type: 'AGENT_CRASH' as const,
    detect(input: DetectionInput): FailureEvent | null {
      const now = clock.now().toISOString();

      if (input.exit.signal !== null) {
        return {
          type: 'AGENT_CRASH',
          evidence: `agent was terminated by ${input.exit.signal}`,
          retryable: true,
          confidence: 0.9,
          detectedAt: now,
          source: 'exit',
        };
      }

      for (const ev of collectEvidence(input)) {
        for (const re of PATTERNS) {
          const m = re.exec(ev.text);
          if (!m) continue;
          return {
            type: 'AGENT_CRASH',
            evidence: lineAround(ev.text, m.index),
            retryable: true,
            confidence: Math.min(SOURCE_CONFIDENCE_CEILING[ev.source], 0.85),
            detectedAt: now,
            source: ev.source,
          };
        }
      }

      // A non-zero exit with nothing else to go on. This is a real crash
      // signal from the process itself, independent of what it printed.
      if (input.exit.code !== null && input.exit.code !== 0) {
        return {
          type: 'AGENT_CRASH',
          evidence: `agent exited with code ${input.exit.code}`,
          retryable: true,
          confidence: 0.75,
          detectedAt: now,
          source: 'exit',
        };
      }
      return null;
    },
  };
}
