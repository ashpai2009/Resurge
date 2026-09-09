import { describe, expect, it } from 'vitest';
import { buildResumeArgs, buildStartArgs, CodexAdapter } from '../../src/agents/codex-adapter.js';
import type { LaunchSpec, ProcessLauncher } from '../../src/agents/launcher.js';
import type { AgentProcess } from '../../src/types/agent.js';
import { makeTask } from '../helpers/task.js';

class RecordingLauncher implements ProcessLauncher {
  specs: LaunchSpec[] = [];
  launch(spec: LaunchSpec): AgentProcess {
    this.specs.push(spec);
    return {
      pid: 1,
      pgid: 1,
      startedAt: new Date().toISOString(),
      onStdout: () => {},
      onStderr: () => {},
      wait: async () => ({ code: 0, signal: null }),
      kill: () => {},
    };
  }
}

describe('argv contract', () => {
  it('builds the documented start form', () => {
    expect(buildStartArgs()).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--approve-for-me',
      '-',
    ]);
  });

  it('builds the documented resume form, with --json as an exec option', () => {
    expect(buildResumeArgs('abc-123')).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--approve-for-me',
      'resume',
      'abc-123',
      '-',
    ]);
  });
});

describe('prompts never reach the process list', () => {
  it('sends the goal over stdin, not argv', async () => {
    const launcher = new RecordingLauncher();
    const adapter = new CodexAdapter(launcher);
    const secretish = 'refactor the Apollo billing key rotation';

    await adapter.start(makeTask({ agent: 'codex' }), secretish);

    const spec = launcher.specs[0]!;
    expect(spec.args.join(' ')).not.toContain(secretish);
    expect(spec.args).toEqual(buildStartArgs());
    expect(spec.stdin).toBe(secretish);
  });

  it('sends the continuation prompt over stdin on resume too', async () => {
    const launcher = new RecordingLauncher();
    const adapter = new CodexAdapter(launcher);
    await adapter.resume('sess-1', makeTask(), 'CONTINUATION BODY');
    const spec = launcher.specs[0]!;
    expect(spec.args.join(' ')).not.toContain('CONTINUATION BODY');
    expect(spec.stdin).toBe('CONTINUATION BODY');
  });

  it('launches in the requested workdir even when it is not a Git repository', async () => {
    const launcher = new RecordingLauncher();
    const adapter = new CodexAdapter(launcher);
    await adapter.start(makeTask({ repo_at_start: null, workdir: '/tmp/plain-project' }), 'work');
    expect(launcher.specs[0]?.cwd).toBe('/tmp/plain-project');
  });
});

describe('session-id extraction is allowlist-only', () => {
  const adapter = new CodexAdapter();
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('accepts thread_id from a thread.started event', () => {
    expect(adapter.detectSessionId({ type: 'thread.started', thread_id: uuid })).toBe(uuid);
  });

  it('accepts a nested thread.id on the same event', () => {
    expect(adapter.detectSessionId({ type: 'thread.started', thread: { id: uuid } })).toBe(uuid);
  });

  it('rejects a UUID on any other event type', () => {
    expect(adapter.detectSessionId({ type: 'item.completed', thread_id: uuid })).toBeNull();
  });

  it('rejects a bare UUID with no event structure', () => {
    // Adopting a stray UUID would resume the wrong session, which is worse
    // than starting fresh with a full continuation prompt.
    expect(adapter.detectSessionId(uuid)).toBeNull();
    expect(adapter.detectSessionId({ session_id: uuid })).toBeNull();
  });

  it('rejects a labelled-but-unstructured mention', () => {
    expect(adapter.detectSessionId(`session id: ${uuid}`)).toBeNull();
  });

  it('rejects a non-UUID thread_id', () => {
    expect(adapter.detectSessionId({ type: 'thread.started', thread_id: 'not-a-uuid' })).toBeNull();
  });
});
