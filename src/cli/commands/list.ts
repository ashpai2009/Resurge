import { JsonTaskStore } from '../../persistence/json-store.js';
import { colorState, dim, goalHeading, relativeTime } from '../format.js';

export function listCommand(): number {
  const results = new JsonTaskStore().list();
  if (results.length === 0) {
    process.stdout.write('No tasks yet. Start one with `resurge run codex "<task>"`.\n');
    return 0;
  }

  const lines = results.map((r) => {
    if (!r.ok) {
      return [r.taskId, 'UNREADABLE', '-', dim('stored state could not be parsed')];
    }
    return [
      r.task.task_id,
      r.task.state,
      relativeTime(r.task.updated_at),
      goalHeading(r.task.goal),
    ];
  });

  const idW = Math.max(...lines.map((l) => l[0]!.length));
  const stW = Math.max(...lines.map((l) => l[1]!.length));
  const agoW = Math.max(...lines.map((l) => l[2]!.length));

  for (const [id, state, ago, goal] of lines) {
    const painted = state === 'UNREADABLE' ? state.padEnd(stW) : colorState(state as never) + ' '.repeat(stW - state!.length);
    process.stdout.write(`${id!.padEnd(idW)}  ${painted}  ${dim(ago!.padEnd(agoW))}  ${goal}\n`);
  }
  return 0;
}
