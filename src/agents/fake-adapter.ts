import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, AgentProcess } from '../types/agent.js';
import type { Task } from '../types/task.js';
import { CodexAdapter } from './codex-adapter.js';
import { ChildProcessLauncher, type ProcessLauncher } from './launcher.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Resolves scripts/fake-agent.js from either src/ or dist/. */
export const FAKE_AGENT_SCRIPT = path.resolve(here, '..', '..', 'scripts', 'fake-agent.js');

/**
 * Drives scripts/fake-agent.js through the same argv shape as the real Codex
 * adapter, so supervisor behaviour can be tested — and demonstrated — without
 * an installed Codex and without spending real quota.
 *
 * Registered only when explicitly asked for (`resurge run fake ...`).
 */
export class FakeAdapter implements AgentAdapter {
  readonly name = 'fake';
  private readonly launcher: ProcessLauncher;
  private readonly codex = new CodexAdapter();
  private readonly scenario: string;

  constructor(scenario = 'success', launcher: ProcessLauncher = new ChildProcessLauncher()) {
    this.scenario = scenario;
    this.launcher = launcher;
  }

  async start(task: Task, prompt: string): Promise<AgentProcess> {
    return this.launch(['exec', '--json', '-'], task, prompt);
  }

  async startFresh(task: Task, continuationPrompt: string): Promise<AgentProcess> {
    return this.start(task, continuationPrompt);
  }

  async resume(sessionId: string, task: Task, prompt: string): Promise<AgentProcess> {
    return this.launch(['exec', '--json', 'resume', sessionId, '-'], task, prompt);
  }

  /** Same allowlist as Codex: only the documented thread.started event. */
  detectSessionId(event: unknown): string | null {
    return this.codex.detectSessionId(event);
  }

  supportsSessionResume(): boolean {
    return true;
  }

  async installationCheck(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: `fake-agent (scenario: ${this.scenario})` };
  }

  private launch(args: string[], task: Task, prompt: string): AgentProcess {
    const extra = ['--scenario', this.scenario];
    const counter = process.env['FAKE_COUNTER_FILE'];
    if (counter) extra.push('--counter-file', counter);
    const delay = process.env['FAKE_DELAY_MS'];
    if (delay) extra.push('--delay-ms', delay);

    return this.launcher.launch({
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT, ...args, ...extra],
      cwd: task.workdir ?? task.repo_at_start?.root ?? process.cwd(),
      stdin: prompt,
    });
  }
}
