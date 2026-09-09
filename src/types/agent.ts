import type { Task } from './task.js';

/**
 * A running agent process, as the supervisor sees it.
 *
 * Deliberately stream-shaped rather than pty-shaped: swapping node-pty in for
 * v0.2 means rewriting only the launcher, not the supervisor.
 */
export interface AgentProcess {
  pid: number | undefined;
  pgid: number | undefined;
  startedAt: string;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  /**
   * Resolves when the process ends. Must return the SAME promise on every call:
   * the supervisor and the stop routine both await it, and a fresh promise per
   * call would leave one of them waiting forever.
   */
  wait(): Promise<{ code: number | null; signal: string | null }>;
  /** Signals the whole process group, so agent subprocesses die too. */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * The extension point. Codex is the only implementation in v0.1; ClaudeAdapter
 * and GeminiAdapter should be addable without touching the supervisor.
 */
export interface AgentAdapter {
  readonly name: string;

  start(task: Task, prompt: string): Promise<AgentProcess>;
  resume(sessionId: string, task: Task, prompt: string): Promise<AgentProcess>;
  startFresh(task: Task, continuationPrompt: string): Promise<AgentProcess>;

  /** Extracts a session id from one parsed JSONL event, or null. */
  detectSessionId(event: unknown): string | null;
  supportsSessionResume(): boolean;

  /**
   * Proves the binary is installed and its argv parses. Explicitly NOT a
   * health check: it says nothing about authentication or API availability.
   */
  installationCheck(): Promise<{ ok: boolean; detail: string }>;
}
