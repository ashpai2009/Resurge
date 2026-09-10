import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs, validateFlags } from '../../src/cli/args.js';
import { buildRunArgs, detectVerification } from '../../src/cli/commands/start.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resurge-start-'));
  dirs.push(dir);
  return dir;
}

describe('easy start', () => {
  it('defaults to Codex, detached mode, and detected npm tests', () => {
    const cwd = tempProject();
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    const parsed = parseArgs(['start', 'fix', 'the', 'project']);
    const run = buildRunArgs(parsed, cwd);

    expect(validateFlags(parsed)).toBeNull();
    expect(run).toMatchObject({
      command: 'run',
      positional: ['codex', 'fix the project'],
      rest: ['npm', 'test'],
    });
    expect(run.flags.get('detach')).toBe(true);
  });

  it('lets an explicit verification argv and foreground mode override defaults', () => {
    const cwd = tempProject();
    const parsed = parseArgs([
      'start',
      'repair it',
      '--foreground',
      '--',
      'npm',
      'run',
      'check',
    ]);
    const run = buildRunArgs(parsed, cwd);

    expect(run.flags.has('detach')).toBe(false);
    expect(run.rest).toEqual(['npm', 'run', 'check']);
  });

  it('can disable verification discovery', () => {
    const cwd = tempProject();
    fs.writeFileSync(path.join(cwd, 'Cargo.toml'), '[package]\nname = "demo"\n');
    const run = buildRunArgs(parseArgs(['start', 'work', '--no-verify']), cwd);
    expect(run.rest).toEqual([]);
  });
});

describe('verification discovery', () => {
  it('uses the package manager lockfile without invoking a shell', () => {
    const cwd = tempProject();
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    expect(detectVerification(cwd)).toEqual(['pnpm', 'test']);
  });

  it('ignores the default npm placeholder test', () => {
    const cwd = tempProject();
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    expect(detectVerification(cwd)).toBeNull();
  });

  it('recognizes conventional Rust, Go, and Python projects', () => {
    const rust = tempProject();
    fs.writeFileSync(path.join(rust, 'Cargo.toml'), '');
    expect(detectVerification(rust)).toEqual(['cargo', 'test']);

    const go = tempProject();
    fs.writeFileSync(path.join(go, 'go.mod'), 'module example.com/demo\n');
    expect(detectVerification(go)).toEqual(['go', 'test', './...']);

    const python = tempProject();
    fs.writeFileSync(path.join(python, 'pytest.ini'), '[pytest]\n');
    expect(detectVerification(python)).toEqual(['python3', '-m', 'pytest']);

    const genericPython = tempProject();
    fs.writeFileSync(path.join(genericPython, 'pyproject.toml'), '[project]\nname = "demo"\n');
    expect(detectVerification(genericPython)).toBeNull();
  });
});
