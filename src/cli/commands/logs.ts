import { isTaskId, taskLogFile } from '../../persistence/paths.js';
import { readFileTail } from '../../persistence/fsx.js';
import { JsonTaskStore } from '../../persistence/json-store.js';
import { resolveTaskSelector } from '../task-selector.js';

const LOG_TAIL_BYTES = 256 * 1024;

/** Prints the durable combined stdout/stderr stream from a detached task. */
export function logsCommand(selector: string | undefined): number {
  if (!selector) {
    process.stderr.write('usage: resurge logs <task-id|latest>\n');
    return 64;
  }
  const taskId = resolveTaskSelector(new JsonTaskStore(), selector);
  if (!taskId) {
    process.stderr.write('No tasks yet. Start one with `resurge start "<task>"`.\n');
    return 1;
  }
  if (!isTaskId(taskId)) {
    process.stderr.write(`Invalid task selector: ${selector}. Use a task id or latest.\n`);
    return 64;
  }
  const file = taskLogFile(taskId);
  const tail = readFileTail(file, LOG_TAIL_BYTES);
  if (tail === null) {
    process.stderr.write(`No detached log for task ${taskId}.\n`);
    return 1;
  }
  if (tail.truncated) {
    process.stdout.write(`[showing the last ${LOG_TAIL_BYTES} bytes of ${file}]\n`);
  }
  process.stdout.write(tail.text);
  return 0;
}
