import type { ReviewReason, Task, TaskState } from '../types/task.js';

const useColor = (): boolean => process.stdout.isTTY === true && !process.env['NO_COLOR'];

const ESC = String.fromCharCode(27);
const CODES = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
} as const;

type Color = keyof typeof CODES;

function paint(text: string, color: Color): string {
  return useColor() ? `${CODES[color]}${text}${CODES.reset}` : text;
}

const STATE_COLOR: Record<TaskState, Color> = {
  RUNNING: 'blue',
  RATE_LIMITED: 'yellow',
  NETWORK_DOWN: 'yellow',
  AGENT_CRASHED: 'yellow',
  PAUSE_REQUESTED: 'dim',
  STOPPING: 'dim',
  PAUSED: 'dim',
  WAITING_TO_RESUME: 'yellow',
  REQUIRES_REVIEW: 'red',
  AGENT_EXITED_SUCCESSFULLY: 'green',
  COMPLETED: 'green',
  UNKNOWN_FAILURE: 'red',
};

export function colorState(state: TaskState): string {
  return paint(state, STATE_COLOR[state] ?? 'reset');
}

export function title(text: string): string {
  return paint(text, 'bold');
}

export function dim(text: string): string {
  return paint(text, 'dim');
}

export function red(text: string): string {
  return paint(text, 'red');
}

/** Two-column layout used by `resurge status`. */
export function rows(pairs: [string, string][]): string {
  const width = Math.max(...pairs.map(([k]) => k.length)) + 4;
  return pairs.map(([k, v]) => `${k.padEnd(width)}${v}`).join('\n');
}

export function relativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return '-';
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';
  const abs = Math.abs(ms);
  const unit =
    abs < 60_000
      ? `${Math.round(abs / 1000)} sec`
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} min`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)} hr`
          : `${Math.round(abs / 86_400_000)} days`;
  return ms >= 0 ? `${unit} ago` : `in ${unit}`;
}

export function clockTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '-';
}

export function goalHeading(goal: string): string {
  const line = goal.split('\n')[0]!.trim();
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}

export function formatReview(reason: ReviewReason): string {
  return `${red(reason.kind)}\n\n${reason.detail}`;
}

/**
 * Surfaced whenever a task is parked mid-flight. The safety of the dirty-file
 * comparison depends on this assumption, and an unstated assumption is a trap.
 */
export const SINGLE_WRITER_NOTE =
  'Resurge assumes nothing else edits this repository while the task is interrupted.';

export function needsSingleWriterNote(task: Task): boolean {
  return ['RATE_LIMITED', 'NETWORK_DOWN', 'AGENT_CRASHED', 'WAITING_TO_RESUME', 'PAUSED'].includes(
    task.state,
  );
}
