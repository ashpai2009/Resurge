import type { Task } from '../../src/types/task.js';
import { SCHEMA_VERSION } from '../../src/persistence/schema.js';
import { newTaskId } from '../../src/persistence/paths.js';

export function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    task_id: newTaskId(),
    agent: 'fake',
    goal: 'test goal',
    session_id: null,
    repo_at_start: null,
    repo_at_interruption: null,
    state: 'RUNNING',
    failure: null,
    review_reason: null,
    resume_at: null,
    child: null,
    attempts: { crash: 0, total_resumes: 0 },
    last_output_tail: '',
    verify_argv: null,
    store_output: true,
    revision: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}
