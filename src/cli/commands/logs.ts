import { isTaskId, taskLogFile } from '../../persistence/paths.js';
import { readFileTail } from '../../persistence/fsx.js';

const LOG_TAIL_BYTES = 256 * 1024;

/** Prints the durable combined stdout/stderr stream from a detached task. */
export function logsCommand(taskId: string | undefined): number {
  if (!taskId || !isTaskId(taskId)) {
    process.stderr.write('usage: resurge logs <task-id>\n');
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
