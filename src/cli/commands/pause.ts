import { JsonTaskStore } from '../../persistence/json-store.js';
import { acquireLease, inspectLease } from '../../persistence/lease.js';
import { requestControl } from '../../persistence/control.js';
import { LeaseUnavailableError } from '../../types/lease.js';
import { dim } from '../format.js';
import { reconcileOrphan } from '../../supervisor/orphan.js';
import { resolveTaskSelector } from '../task-selector.js';

/**
 * `resurge pause <task-id>`
 *
 * If a supervisor owns the task, this files a control request rather than
 * touching the record: only the lease owner writes task state, and it is the
 * owner that can actually stop the agent and confirm it died. If nobody owns
 * the task, this process takes the lease and performs the transition itself.
 */
export async function pauseCommand(selector: string | undefined): Promise<number> {
  if (!selector) {
    process.stderr.write('usage: resurge pause <task-id|latest>\n');
    return 64;
  }

  const store = new JsonTaskStore();
  const taskId = resolveTaskSelector(store, selector);
  if (!taskId) {
    process.stderr.write('No tasks yet. Start one with `resurge start "<task>"`.\n');
    return 1;
  }
  const loaded = store.load(taskId);
  if (!loaded) {
    process.stderr.write(`No task ${taskId}.\n`);
    return 1;
  }
  if (!loaded.ok) {
    process.stderr.write(`Cannot pause ${taskId}: stored state could not be read.\n${loaded.reason}\n`);
    return 1;
  }

  const held = inspectLease(taskId);
  if (held && held.verdict.kind === 'ACTIVE') {
    requestControl(taskId, 'pause');
    process.stdout.write(
      `Pause requested for ${taskId}.\n` +
        `${dim(`Supervisor pid ${held.lease.owner_pid} will stop the agent and confirm it exited before recording PAUSED.`)}\n`,
    );
    return 0;
  }

  // A dead supervisor can leave its child alive. Owning the lease proves there
  // is no current supervisor; it does not prove there is no agent process.
  try {
    const lease = await acquireLease(taskId);
    try {
      const fresh = store.load(taskId);
      if (!fresh?.ok) {
        process.stderr.write(`Cannot pause ${taskId}: task state changed or became unreadable.\n`);
        return 1;
      }
      const orphan = reconcileOrphan(fresh.task);
      if (orphan.kind === 'BLOCKED') {
        await store.save(lease, {
          ...fresh.task,
          state: 'REQUIRES_REVIEW',
          review_reason: orphan.reason,
          resume_at: null,
        });
        process.stderr.write(`Cannot pause ${taskId}: ${orphan.reason.detail}\n`);
        return 1;
      }
      await store.save(lease, {
        ...fresh.task,
        state: 'PAUSED',
        child: null,
        resume_at: null,
      });
      process.stdout.write(`Task ${taskId} is paused.\n`);
      return 0;
    } finally {
      await lease.release();
    }
  } catch (err) {
    if (err instanceof LeaseUnavailableError) {
      process.stderr.write(`Cannot pause: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
