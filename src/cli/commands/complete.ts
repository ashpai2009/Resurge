import { JsonTaskStore } from '../../persistence/json-store.js';
import { acquireLease } from '../../persistence/lease.js';
import { LeaseUnavailableError } from '../../types/lease.js';
import { resolveTaskSelector } from '../task-selector.js';

/**
 * `resurge complete <task-id>`
 *
 * The only manual route to COMPLETED, and it is legal from exactly one state.
 * A clean agent exit produces AGENT_EXITED_SUCCESSFULLY; a human deciding the
 * work is actually done is what produces COMPLETED. Nothing here can mark a
 * running, waiting or blocked task complete.
 */
export async function completeCommand(selector: string | undefined): Promise<number> {
  if (!selector) {
    process.stderr.write('usage: resurge complete <task-id|latest>\n');
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
    process.stderr.write(`Cannot complete ${taskId}: stored state could not be read.\n`);
    return 1;
  }
  if (loaded.task.state === 'COMPLETED') {
    process.stdout.write(`Task ${taskId} is already complete.\n`);
    return 0;
  }
  if (loaded.task.state !== 'AGENT_EXITED_SUCCESSFULLY') {
    process.stderr.write(
      `Cannot complete ${taskId}: it is ${loaded.task.state}, not AGENT_EXITED_SUCCESSFULLY.\n` +
        `Only a task whose agent has exited cleanly can be marked complete.\n`,
    );
    return 1;
  }

  try {
    const lease = await acquireLease(taskId);
    try {
      // The record may have changed between the optimistic read above and
      // lease acquisition. Re-read under ownership before making the terminal
      // transition; the store's revision check is the final backstop.
      const fresh = store.load(taskId);
      if (!fresh?.ok) {
        process.stderr.write(`Cannot complete ${taskId}: task state changed or became unreadable.\n`);
        return 1;
      }
      if (fresh.task.state === 'COMPLETED') {
        process.stdout.write(`Task ${taskId} is already complete.\n`);
        return 0;
      }
      if (fresh.task.state !== 'AGENT_EXITED_SUCCESSFULLY') {
        process.stderr.write(
          `Cannot complete ${taskId}: it is now ${fresh.task.state}, not AGENT_EXITED_SUCCESSFULLY.\n`,
        );
        return 1;
      }
      await store.save(lease, { ...fresh.task, state: 'COMPLETED', review_reason: null });
      process.stdout.write(`Task ${taskId} marked complete.\n`);
      return 0;
    } finally {
      await lease.release();
    }
  } catch (err) {
    if (err instanceof LeaseUnavailableError) {
      process.stderr.write(`Cannot complete: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
