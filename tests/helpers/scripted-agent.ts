import type { AgentAdapter, AgentProcess } from '../../src/types/agent.js';
import type { Task } from '../../src/types/task.js';

export interface ScriptedRun {
  stdout?: string;
  stderr?: string;
  jsonl?: unknown[];
  exit: { code: number | null; signal: string | null };
  /** Milliseconds the process "runs" for, as observed via the injected clock. */
  runMs?: number;
}

export interface Launch {
  mode: 'start' | 'resume' | 'fresh';
  sessionId?: string;
  prompt: string;
}

/**
 * An adapter whose behaviour is fully scripted, so supervisor state-machine
 * tests do not depend on process timing. Real-process behaviour is covered
 * separately by the fake-agent tests.
 */
export class ScriptedAdapter implements AgentAdapter {
  readonly name = 'scripted';
  readonly launches: Launch[] = [];
  private readonly runs: ScriptedRun[];
  private index = 0;
  installOk = true;
  sessionToEmit: string | null = null;

  constructor(runs: ScriptedRun[]) {
    this.runs = runs;
  }

  private next(mode: Launch['mode'], prompt: string, sessionId?: string): AgentProcess {
    this.launches.push(sessionId ? { mode, prompt, sessionId } : { mode, prompt });
    const run = this.runs[Math.min(this.index++, this.runs.length - 1)]!;

    const stdoutCbs: ((c: string) => void)[] = [];
    const stderrCbs: ((c: string) => void)[] = [];

    const proc: AgentProcess = {
      pid: undefined,
      pgid: undefined,
      startedAt: new Date().toISOString(),
      onStdout: (cb) => stdoutCbs.push(cb),
      onStderr: (cb) => stderrCbs.push(cb),
      wait: async () => {
        // Deliver output after handlers are registered, mirroring a real stream.
        await Promise.resolve();
        const events = run.jsonl ?? (this.sessionToEmit && this.index === 1
          ? [{ type: 'thread.started', thread_id: this.sessionToEmit }]
          : []);
        for (const e of events) for (const cb of stdoutCbs) cb(`${JSON.stringify(e)}\n`);
        if (run.stdout) for (const cb of stdoutCbs) cb(run.stdout);
        if (run.stderr) for (const cb of stderrCbs) cb(run.stderr);
        return run.exit;
      },
      kill: () => {},
    };
    return proc;
  }

  async start(_task: Task, prompt: string): Promise<AgentProcess> {
    return this.next('start', prompt);
  }
  async startFresh(_task: Task, prompt: string): Promise<AgentProcess> {
    return this.next('fresh', prompt);
  }
  async resume(sessionId: string, _task: Task, prompt: string): Promise<AgentProcess> {
    return this.next('resume', prompt, sessionId);
  }
  detectSessionId(event: unknown): string | null {
    if (event && typeof event === 'object') {
      const o = event as Record<string, unknown>;
      if (o['type'] === 'thread.started' && typeof o['thread_id'] === 'string') return o['thread_id'];
    }
    return null;
  }
  supportsSessionResume(): boolean {
    return true;
  }
  async installationCheck(): Promise<{ ok: boolean; detail: string }> {
    return this.installOk ? { ok: true, detail: 'scripted' } : { ok: false, detail: 'not installed' };
  }
}
