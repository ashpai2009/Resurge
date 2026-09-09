import type { PorcelainEntry, RepoSnapshot, RepoVerdict } from '../types/repo.js';
import { entryKey, formatEntry, isConflicted } from './porcelain.js';

/**
 * Compares the repository now against the baseline captured at interruption.
 *
 * The time boundary is the whole point. Comparing against the snapshot taken
 * when the task *started* would reject every commit the agent legitimately made
 * while Resurge was watching it. The question this answers is narrower and
 * correct: did anything change while nobody was driving?
 *
 * Pure function over two snapshots, so it is fully testable without a
 * filesystem, and so recovery logic cannot smuggle side effects in here.
 */
export function verifyRepo(baseline: RepoSnapshot | null, current: RepoSnapshot): RepoVerdict {
  if (baseline === null) {
    return review([
      'No repository snapshot was captured at the point of interruption, so there is no trustworthy baseline to compare against.',
    ]);
  }
  if (baseline.unavailable_reason) {
    return review([`Baseline snapshot is unusable: ${baseline.unavailable_reason}`]);
  }
  if (current.unavailable_reason) {
    return review([`Cannot inspect the repository now: ${current.unavailable_reason}`]);
  }

  // Not a git repository at all: nothing to verify, and nothing to protect.
  if (baseline.root === null && current.root === null) {
    return { kind: 'SAFE_RESUME', reasons: [] };
  }

  const reasons: string[] = [];

  if (baseline.root !== current.root) {
    reasons.push(`Expected repository: ${baseline.root}\nCurrent repository:  ${current.root}`);
  }
  if (baseline.branch !== current.branch) {
    reasons.push(`Expected branch: ${show(baseline.branch)}\nCurrent branch:  ${show(current.branch)}`);
  }
  if (baseline.head_sha !== current.head_sha) {
    reasons.push(`Expected HEAD: ${short(baseline.head_sha)}\nCurrent HEAD:  ${short(current.head_sha)}`);
  }

  const conflicts = current.entries.filter(isConflicted);
  if (conflicts.length > 0) {
    reasons.push(
      `Unresolved merge conflicts in the working tree:\n${conflicts.map((e) => `  ${formatEntry(e)}`).join('\n')}`,
    );
  }

  reasons.push(...compareDirty(baseline.entries, current.entries));

  if (reasons.length > 0) {
    reasons.push('Repository changed while the agent was interrupted. Automatic resume has been blocked.');
    return review(reasons);
  }
  return { kind: 'SAFE_RESUME', reasons: [] };
}

/**
 * Dirty-state comparison.
 *
 * The interruption snapshot is taken only after the child exits, so any work
 * the agent completed is already in the baseline. New, removed, or status-
 * changed entries after that boundary all mean the repository changed while
 * no supervised agent was running.
 *
 * This is safe only under Resurge's documented single-writer assumption: while
 * a task is interrupted, no human or other process edits the repository. That
 * assumption is stated in the README and surfaced by `resurge status`.
 */
function compareDirty(baseline: PorcelainEntry[], current: PorcelainEntry[]): string[] {
  const byKey = new Map(current.map((e) => [entryKey(e), e]));
  const reasons: string[] = [];

  for (const before of baseline) {
    const key = entryKey(before);
    const after = byKey.get(key);
    if (!after) {
      reasons.push(
        `A file that was modified when the agent stopped is no longer modified: ${formatEntry(before)}\n` +
          `Something committed, stashed or reverted it while the agent was interrupted.`,
      );
      continue;
    }
    if (after.x !== before.x || after.y !== before.y) {
      reasons.push(
        `The status of ${key} changed while the agent was interrupted: ` +
          `${before.x}${before.y} -> ${after.x}${after.y}`,
      );
    }
    if (
      before.content_hash !== undefined &&
      after.content_hash !== undefined &&
      after.content_hash !== before.content_hash
    ) {
      reasons.push(`The contents of ${key} changed while the agent was interrupted.`);
    }
  }

  const beforeKeys = new Set(baseline.map(entryKey));
  for (const after of current) {
    const key = entryKey(after);
    if (!beforeKeys.has(key)) {
      reasons.push(
        `A new dirty entry appeared while the agent was interrupted: ${formatEntry(after)}`,
      );
    }
  }

  return reasons;
}

function review(reasons: string[]): RepoVerdict {
  return { kind: 'REQUIRES_REVIEW', reasons };
}

function show(v: string | null): string {
  return v ?? '(detached or unknown)';
}

function short(sha: string | null): string {
  return sha === null ? '(unknown)' : sha.slice(0, 12);
}
