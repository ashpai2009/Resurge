import { JsonTaskStore } from '../../persistence/json-store.js';
import { inspectLease } from '../../persistence/lease.js';
import { pendingCount } from '../../persistence/control.js';
import {
  clockTime,
  colorState,
  dim,
  formatReview,
  goalHeading,
  needsSingleWriterNote,
  relativeTime,
  rows,
  shortSha,
  SINGLE_WRITER_NOTE,
  title,
} from '../format.js';
import type { LoadResult } from '../../persistence/store.js';

/**
 * Read-only. Reports corruption rather than repairing it: two concurrent
 * `status` invocations must never fight over a damaged file, and repair belongs
 * to whoever holds the lease.
 */
export function statusCommand(taskId?: string): number {
  const store = new JsonTaskStore();
  const result = taskId ? store.load(taskId) : mostRecent(store.list());

  if (!result) {
    process.stdout.write(
      taskId ? `No task ${taskId}.\n` : 'No tasks yet. Start one with `resurge start "<task>"`.\n',
    );
    return taskId ? 1 : 0;
  }

  if (!result.ok) {
    process.stdout.write(
      `${title(`Task ${result.taskId}`)}\n\n` +
        `State        ${colorState('REQUIRES_REVIEW')}\n` +
        `Problem      stored state could not be read\n\n${result.reason}\n\n` +
        (result.futureSchema
          ? 'Upgrade Resurge to read this record.\n'
          : 'The file has been left untouched. Inspect it before doing anything else.\n'),
    );
    return 1;
  }

  const task = result.task;
  const snap = task.repo_at_interruption ?? task.repo_at_start;
  const lease = inspectLease(task.task_id);

  const pairs: [string, string][] = [
    ['Agent', task.agent],
    ['State', colorState(task.state)],
  ];

  if (task.resume_at) pairs.push(['Resume', `${clockTime(task.resume_at)}  ${dim(relativeTime(task.resume_at))}`]);
  if (task.session_id) pairs.push(['Session', task.session_id]);
  if (task.detached) pairs.push(['Mode', 'detached']);
  if (task.log_path) pairs.push(['Log', task.log_path]);
  pairs.push(['Branch', snap?.branch ?? '-']);
  pairs.push(['HEAD', shortSha(snap?.head_sha ?? null)]);
  if (snap && snap.entries.length > 0) pairs.push(['Dirty files', String(snap.entries.length)]);
  pairs.push(['Checkpoint', relativeTime(task.updated_at)]);
  if (task.attempts.crash > 0) pairs.push(['Crashes', String(task.attempts.crash)]);
  if (task.attempts.total_resumes > 0) pairs.push(['Resumes', String(task.attempts.total_resumes)]);
  if (lease) {
    pairs.push([
      'Supervisor',
      lease.verdict.kind === 'ACTIVE'
        ? `pid ${lease.lease.owner_pid}`
        : dim(`pid ${lease.lease.owner_pid} (${lease.verdict.kind.toLowerCase()})`),
    ]);
  }
  const pending = pendingCount(task.task_id);
  if (pending > 0) pairs.push(['Pending requests', String(pending)]);
  pairs.push(['Task id', dim(task.task_id)]);

  let out = `${title(goalHeading(task.goal))}\n\n${rows(pairs)}\n`;

  if (task.failure) {
    out += `\n${title('Failure')}\n${task.failure.type}: ${task.failure.evidence}\n`;
  }
  if (task.review_reason) {
    out += `\n${title('Blocked')}\n${formatReview(task.review_reason)}\n`;
  }
  if (task.state === 'AGENT_EXITED_SUCCESSFULLY') {
    out +=
      `\n${dim('The agent exited cleanly. That is not proof the goal is done.')}\n` +
      `${dim(`Review the work, then run: resurge complete ${task.task_id}`)}\n`;
  }
  if (needsSingleWriterNote(task)) {
    out += `\n${dim(SINGLE_WRITER_NOTE)}\n`;
  }

  process.stdout.write(out);
  return 0;
}

function mostRecent(results: LoadResult[]): LoadResult | null {
  return results.length === 0 ? null : results[results.length - 1]!;
}
