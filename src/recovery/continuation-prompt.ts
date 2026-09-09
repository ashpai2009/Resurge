import type { Task } from '../types/task.js';
import { formatEntry } from '../repo/porcelain.js';

/**
 * Builds the prompt used when an exact session resume is not possible.
 *
 * The point is that "continue" is useless to a fresh session: it has no idea
 * what was happening. Everything here comes from observed state — git, process
 * exit, our own failure classification — rather than from anything the agent
 * claimed about its own progress.
 */
export function buildContinuationPrompt(task: Task): string {
  const snap = task.repo_at_interruption ?? task.repo_at_start;
  const sections: string[] = [];

  sections.push('You are resuming an interrupted engineering task.');
  sections.push(`GOAL\n${task.goal}`);
  sections.push(`LAST KNOWN STATE\n${describeState(task)}`);

  sections.push(`REPOSITORY\n${snap?.root ?? '(not a git repository)'}`);
  sections.push(`BRANCH\n${snap?.branch ?? '(detached or unknown)'}`);
  sections.push(`HEAD\n${snap?.head_sha ?? '(unknown)'}`);

  const files = snap?.entries ?? [];
  sections.push(
    `FILES CHANGED\n${files.length === 0 ? '(working tree was clean)' : files.map((e) => `  ${formatEntry(e)}`).join('\n')}`,
  );

  sections.push(`FAILURE THAT INTERRUPTED EXECUTION\n${describeFailure(task)}`);

  if (task.last_output_tail.trim().length > 0) {
    sections.push(`LAST OUTPUT (truncated, secrets masked)\n${tail(task.last_output_tail, 2000)}`);
  }

  sections.push(
    'NEXT ACTION\n' +
      'Re-establish context by inspecting the files listed above and the recent git history, ' +
      'then continue working toward GOAL. Do not restart work that is already committed, and ' +
      'do not revert changes you find in the working tree — they are your own earlier edits.',
  );

  return sections.join('\n\n');
}

function describeState(task: Task): string {
  const when = task.repo_at_interruption?.captured_at ?? task.updated_at;
  const resumes =
    task.attempts.total_resumes > 0
      ? ` This is resume attempt ${task.attempts.total_resumes + 1}.`
      : '';
  return `The agent was interrupted at ${when} and its work was left unfinished.${resumes}`;
}

function describeFailure(task: Task): string {
  if (!task.failure) return 'Unknown — no failure was recorded.';
  const { type, evidence, retryAfter } = task.failure;
  const extra = retryAfter ? `\nReset time recorded: ${retryAfter}` : '';
  return `${type} — ${evidence}${extra}`;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `...\n${text.slice(text.length - max)}`;
}

/** Nudge sent when resuming the *same* session, which already has context. */
export function buildResumeNudge(task: Task): string {
  const failure = task.failure ? `${task.failure.type}: ${task.failure.evidence}` : 'an interruption';
  return (
    `Your previous run was interrupted by ${failure}. ` +
    `Continue working toward the original goal: ${task.goal}. ` +
    `Re-check the working tree before making changes, in case your last edit was partial.`
  );
}
