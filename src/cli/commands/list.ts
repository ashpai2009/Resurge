import { JsonTaskStore } from '../../persistence/json-store.js';
import type { TaskState } from '../../types/task.js';
import { colorState, dateTime, dim, goalHeading } from '../format.js';

const ONGOING_STATES = new Set<TaskState>([
  'RUNNING',
  'RATE_LIMITED',
  'NETWORK_DOWN',
  'AGENT_CRASHED',
  'PAUSE_REQUESTED',
  'STOPPING',
  'WAITING_TO_RESUME',
]);

export function listCommand(): number {
  const results = new JsonTaskStore().list();
  if (results.length === 0) {
    process.stdout.write('No tasks yet. Start one with `resurge run codex "<task>"`.\n');
    return 0;
  }

  const lines = results.map((r) => {
    if (!r.ok) {
      return {
        id: r.taskId,
        state: 'UNREADABLE',
        started: '-',
        ended: '-',
        goal: dim('stored state could not be parsed'),
        logPath: null,
      };
    }
    return {
      id: r.task.task_id,
      state: r.task.state,
      started: dateTime(r.task.created_at),
      ended: ONGOING_STATES.has(r.task.state) ? 'ongoing' : dateTime(r.task.updated_at),
      goal: goalHeading(r.task.goal),
      logPath: r.task.log_path ?? null,
    };
  });

  const idW = Math.max('TASK ID'.length, ...lines.map((l) => l.id.length));
  const stW = Math.max('STATE'.length, ...lines.map((l) => l.state.length));
  const startW = Math.max('STARTED'.length, ...lines.map((l) => l.started.length));
  const endW = Math.max('ENDED'.length, ...lines.map((l) => l.ended.length));

  process.stdout.write(
    `${dim('TASK ID'.padEnd(idW))}  ${dim('STATE'.padEnd(stW))}  ` +
      `${dim('STARTED'.padEnd(startW))}  ${dim('ENDED'.padEnd(endW))}  ${dim('GOAL')}\n`,
  );

  for (const line of lines) {
    const painted =
      line.state === 'UNREADABLE'
        ? line.state.padEnd(stW)
        : colorState(line.state as TaskState) + ' '.repeat(stW - line.state.length);
    process.stdout.write(
      `${line.id.padEnd(idW)}  ${painted}  ${line.started.padEnd(startW)}  ` +
        `${line.ended.padEnd(endW)}  ${line.goal}\n`,
    );
    if (line.logPath) process.stdout.write(`  ${dim(`log: ${line.logPath}`)}\n`);
  }
  return 0;
}
