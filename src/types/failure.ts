/**
 * Structured failure vocabulary.
 *
 * This module and everything under src/failure/ is pure classification: it
 * describes what happened. It must never import from recovery/, supervisor/
 * or agents/, and must never act. tests/unit/import-boundary.test.ts enforces
 * that mechanically.
 */
export type FailureType =
  | 'SESSION_INVALID'
  | 'RATE_LIMIT'
  | 'NETWORK_DOWN'
  | 'AGENT_CRASH'
  | 'UNKNOWN_FAILURE';

/**
 * Where the evidence came from. This ranks how much we trust it: a structured
 * JSONL event from the agent is strong, a line the agent happened to print on
 * stdout is weak (it may just be quoting a log file it was asked to read).
 */
export type EvidenceSource = 'jsonl' | 'stderr' | 'stdout' | 'exit';

/** Confidence ceilings per source. Enforced in failure/detector.ts. */
export const SOURCE_CONFIDENCE_CEILING: Record<EvidenceSource, number> = {
  jsonl: 0.95,
  exit: 0.9,
  stderr: 0.85,
  // Deliberately below ACCEPT_THRESHOLD: stdout text alone can corroborate a
  // classification but can never by itself trigger an automatic recovery.
  stdout: 0.6,
};

/** A classification below this confidence degrades to UNKNOWN_FAILURE. */
export const ACCEPT_THRESHOLD = 0.7;

export interface FailureEvent {
  type: FailureType;
  /** The matched text, shown to the user. Redacted at the storage layer. */
  evidence: string;
  retryable: boolean;
  /** ISO timestamp; only set when a reset time was successfully parsed. */
  retryAfter?: string;
  confidence: number;
  detectedAt: string;
  source: EvidenceSource;
}

/** What the supervisor observed when the child ended. */
export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

/**
 * A child that was killed by a signal reports {code: null, signal: 'SIGSEGV'}.
 * Treating "exit 0" as the success condition would let every signal death pass
 * as a clean finish, so success requires both halves.
 */
export function isCleanExit(exit: ExitInfo): boolean {
  return exit.code === 0 && exit.signal === null;
}

export function isFailureExit(exit: ExitInfo): boolean {
  return !isCleanExit(exit);
}

/** Input to the detector: framed evidence, ranked by source. */
export interface DetectionInput {
  exit: ExitInfo;
  stdoutTail: string;
  stderrTail: string;
  /** Parsed JSONL event objects emitted by the agent, in order. */
  jsonlEvents: unknown[];
}

/**
 * A rule inspects evidence and either recognises it or abstains. Rules never
 * act, never restart anything, and never see a Task.
 */
export interface FailureRule {
  readonly type: FailureType;
  detect(input: DetectionInput): FailureEvent | null;
}
