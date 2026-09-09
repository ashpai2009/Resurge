import type { DetectionInput, EvidenceSource } from '../types/failure.js';

/**
 * One piece of evidence with its provenance.
 *
 * Ranking evidence by source is what stops a task whose own output happens to
 * contain "429" or "ECONNRESET" — because the agent was reading a log file, say
 * — from being misread as a rate limit. Structured events the agent emitted
 * about itself are trustworthy; text it printed is not.
 */
export interface Evidence {
  source: EvidenceSource;
  text: string;
}

/** How much of stdout counts as "near the end", for context matching. */
export const STDOUT_TAIL_BYTES = 2048;

/**
 * Only Codex protocol events that explicitly report a turn-level failure are
 * trusted as structured failure evidence. Agent messages and command output
 * also arrive as JSONL, but their text describes the task and must not be
 * mistaken for telemetry about Codex itself.
 */
export function isStructuredFailureEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const type = (event as Record<string, unknown>)['type'];
  return type === 'error' || type === 'turn.failed';
}

/** Words that make an error-ish token plausible as a real failure. */
const ERROR_CONTEXT = /\b(error|failed|failure|exception|refused|unable|cannot|denied|retry|request|status|aborted)\b/i;

/**
 * Builds the evidence list in descending order of trust.
 *
 * stdout is included but truncated to the tail, because a failure that killed
 * the process is reported at the end, whereas an incidental mention could be
 * anywhere.
 */
export function collectEvidence(input: DetectionInput): Evidence[] {
  const out: Evidence[] = [];

  for (const event of input.jsonlEvents) {
    if (isStructuredFailureEvent(event)) {
      out.push({ source: 'jsonl', text: JSON.stringify(event) });
    }
  }
  if (input.stderrTail.trim().length > 0) {
    out.push({ source: 'stderr', text: input.stderrTail });
  }
  const tail = input.stdoutTail.slice(-STDOUT_TAIL_BYTES);
  if (tail.trim().length > 0) {
    out.push({ source: 'stdout', text: tail });
  }
  return out;
}

/**
 * Whether a weak token (like a bare "429") is corroborated by error context on
 * the same or an adjacent line. Applied only to stdout, where an unqualified
 * match means very little.
 */
export function hasErrorContext(text: string, matchIndex: number): boolean {
  const lines = text.split('\n');
  let offset = 0;
  let lineNo = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length + 1;
    if (matchIndex < offset + len) {
      lineNo = i;
      break;
    }
    offset += len;
  }
  const window = [lines[lineNo - 1], lines[lineNo], lines[lineNo + 1]]
    .filter((l): l is string => typeof l === 'string')
    .join('\n');
  return ERROR_CONTEXT.test(window);
}
