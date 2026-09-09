import type { DetectionInput, FailureEvent } from '../../types/failure.js';
import { SOURCE_CONFIDENCE_CEILING } from '../../types/failure.js';
import { collectEvidence, hasErrorContext } from '../evidence.js';
import { lineAround } from './rate-limit.js';
import type { Clock } from '../../util/clock.js';

/** Unambiguous transport failures. */
const STRONG = [
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bECONNREFUSED\b/,
  /\bENETUNREACH\b/,
  /\bEHOSTUNREACH\b/,
  /\bgetaddrinfo\b/,
  /\bsocket hang up\b/i,
  /\bnetwork (?:is )?unreachable\b/i,
  /\bdns (?:lookup )?fail/i,
  /\bunable to (?:resolve|reach) host\b/i,
  /\bTLS (?:handshake|connection) (?:failed|error)\b/i,
  /\bcertificate (?:has expired|verify failed)\b/i,
];

/** Could equally be an application-level error the agent is reporting. */
const WEAK = [/\bECONNRESET\b/, /\bETIMEDOUT\b/, /\b50[234]\b/, /\btimed? ?out\b/i];

export function makeNetworkRule(clock: Clock) {
  return {
    type: 'NETWORK_DOWN' as const,
    detect(input: DetectionInput): FailureEvent | null {
      for (const ev of collectEvidence(input)) {
        const ceiling = SOURCE_CONFIDENCE_CEILING[ev.source];

        for (const re of STRONG) {
          const m = re.exec(ev.text);
          if (!m) continue;
          return {
            type: 'NETWORK_DOWN',
            evidence: lineAround(ev.text, m.index),
            retryable: true,
            confidence: Math.min(ceiling, 0.88),
            detectedAt: clock.now().toISOString(),
            source: ev.source,
          };
        }

        for (const re of WEAK) {
          const m = re.exec(ev.text);
          if (!m) continue;
          if (ev.source === 'stdout' && !hasErrorContext(ev.text, m.index)) continue;
          return {
            type: 'NETWORK_DOWN',
            evidence: lineAround(ev.text, m.index),
            retryable: true,
            confidence: Math.min(ceiling, 0.74),
            detectedAt: clock.now().toISOString(),
            source: ev.source,
          };
        }
      }
      return null;
    },
  };
}
