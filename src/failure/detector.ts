import type { DetectionInput, FailureEvent, FailureRule } from '../types/failure.js';
import { ACCEPT_THRESHOLD, isFailureExit } from '../types/failure.js';
import { makeCrashRule } from './rules/crash.js';
import { makeNetworkRule } from './rules/network.js';
import { makeRateLimitRule } from './rules/rate-limit.js';
import { makeSessionInvalidRule } from './rules/session-invalid.js';
import type { Clock } from '../util/clock.js';
import { systemClock } from '../util/clock.js';
import { isStructuredFailureEvent } from './evidence.js';

/**
 * Classifies why an agent stopped.
 *
 * This module is pure classification. It never restarts anything, never sees a
 * Task, and never imports from recovery/, supervisor/ or agents/ — a boundary
 * tests/unit/import-boundary.test.ts enforces mechanically, so a future regex
 * cannot quietly grow the power to relaunch a process.
 */
export class FailureDetector {
  private readonly rules: FailureRule[];
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock, rules?: FailureRule[]) {
    this.clock = clock;
    // Order matters. A rate-limited agent also exits non-zero, so the crash
    // rule must be asked last or it would swallow every other classification.
    this.rules = rules ?? [
      makeSessionInvalidRule(clock),
      makeRateLimitRule(clock),
      makeNetworkRule(clock),
      makeCrashRule(clock),
    ];
  }

  /**
   * Returns null when the agent ended cleanly. Otherwise always returns an
   * event: an unrecognised failure is UNKNOWN_FAILURE, which is a conclusion,
   * not an absence of one.
   */
  detect(input: DetectionInput): FailureEvent | null {
    if (!isFailureExit(input.exit) && !input.jsonlEvents.some(isStructuredFailureEvent)) return null;

    let lowConfidence: FailureEvent | null = null;

    for (const rule of this.rules) {
      const event = rule.detect(input);
      if (!event) continue;
      if (event.confidence >= ACCEPT_THRESHOLD) {
        // The crash rule's bare exit-code fallback is intentionally generic.
        // It must not erase a specific-but-weak clue that should send the task
        // to review. A signal death or textual crash signature remains strong
        // enough to win.
        const genericExitFallback =
          lowConfidence !== null &&
          event.type === 'AGENT_CRASH' &&
          event.source === 'exit' &&
          event.confidence <= 0.75;
        if (!genericExitFallback) return event;
        continue;
      }
      if (!lowConfidence || event.confidence > lowConfidence.confidence) lowConfidence = event;
    }

    // A weak match in a high-priority rule must not hide stronger evidence in
    // a later rule. If nothing crossed the action threshold, keep the best weak
    // match so the human reviewing it can see what we nearly concluded.
    if (lowConfidence) {
      return unknown(
        input,
        this.clock,
        `low-confidence ${lowConfidence.type} (${lowConfidence.confidence.toFixed(2)}): ${lowConfidence.evidence}`,
      );
    }

    return unknown(input, this.clock, describeExit(input));
  }
}

function unknown(input: DetectionInput, clock: Clock, evidence: string): FailureEvent {
  return {
    type: 'UNKNOWN_FAILURE',
    evidence,
    // Deliberately not retryable: if we cannot say what went wrong, retrying is
    // a guess, and Resurge escalates instead of guessing.
    retryable: false,
    confidence: 1,
    detectedAt: clock.now().toISOString(),
    source: 'exit',
  };
}

function describeExit(input: DetectionInput): string {
  const { code, signal } = input.exit;
  const how = signal !== null ? `killed by ${signal}` : `exited with code ${code}`;
  const tail = (input.stderrTail || input.stdoutTail).trim().split('\n').slice(-3).join('\n');
  return tail.length > 0 ? `agent ${how}. Last output:\n${tail}` : `agent ${how} with no output`;
}
