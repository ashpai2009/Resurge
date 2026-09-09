/** Leveled logging to stderr, so stdout stays clean for command output. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env['RESURGE_LOG'] ?? 'info').toLowerCase();
  return ORDER[raw as LogLevel] ?? ORDER.info;
}

function emit(level: LogLevel, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold()) return;
  const line = `[resurge] ${level}: ${msg}`;
  if (extra !== undefined) process.stderr.write(`${line} ${format(extra)}\n`);
  else process.stderr.write(`${line}\n`);
}

function format(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const logger = {
  debug: (m: string, e?: unknown) => emit('debug', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
};
