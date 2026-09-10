import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedArgs } from '../args.js';
import { flagBool, flagString } from '../args.js';
import { launchDetached } from '../detach.js';
import { runCommand } from './run.js';

/**
 * Opinionated happy path: Codex, current directory, detached supervision, and
 * an automatically discovered verification command. The lower-level `run`
 * command remains available when a caller needs to choose every knob.
 */
export async function startCommand(args: ParsedArgs): Promise<number> {
  const goal = args.positional.join(' ').trim();
  if (!goal) {
    process.stderr.write('usage: resurge start "<task>" [-- <verification command...>]\n');
    return 64;
  }

  const cwd = path.resolve(flagString(args, 'cwd') ?? process.cwd());
  const runArgs = buildRunArgs(args, cwd);
  const agent = runArgs.positional[0]!;
  const background = runArgs.flags.get('detach') === true;

  process.stdout.write(
    `Starting ${agent} ${background ? 'in the background' : 'in the foreground'} for ${cwd}\n`,
  );
  if (runArgs.rest.length > 0) {
    process.stdout.write(`Verification: ${formatArgv(runArgs.rest)}\n\n`);
  } else {
    process.stdout.write(
      'Verification: none detected; a clean exit will wait for your confirmation.\n\n',
    );
  }

  return background ? launchDetached(runArgs) : runCommand(runArgs);
}

/** Converts the easy command into the same typed input used by `run`. */
export function buildRunArgs(args: ParsedArgs, cwd: string): ParsedArgs {
  const goal = args.positional.join(' ').trim();
  const agent = flagString(args, 'agent') ?? 'codex';
  const flags = new Map(args.flags);
  flags.delete('agent');
  flags.delete('foreground');
  flags.delete('no-verify');
  if (!flagBool(args, 'foreground')) flags.set('detach', true);

  const rest =
    args.rest.length > 0
      ? [...args.rest]
      : flagBool(args, 'no-verify')
        ? []
        : (detectVerification(cwd) ?? []);

  return { command: 'run', positional: [agent, goal], flags, rest };
}

/**
 * Detects only conventional, shell-free test commands. It deliberately avoids
 * arbitrary Make targets and package scripts whose semantics are unknowable.
 */
export function detectVerification(cwd: string): string[] | null {
  const packageFile = path.join(cwd, 'package.json');
  if (fs.existsSync(packageFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      const test = pkg.scripts?.['test'];
      if (typeof test === 'string' && !/no test specified/i.test(test)) {
        if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return ['pnpm', 'test'];
        if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return ['yarn', 'test'];
        if (fs.existsSync(path.join(cwd, 'bun.lockb')) || fs.existsSync(path.join(cwd, 'bun.lock'))) {
          return ['bun', 'run', 'test'];
        }
        return ['npm', 'test'];
      }
    } catch {
      // `run` will still capture the project safely; malformed project metadata
      // simply means completion remains manual.
    }
  }

  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return ['cargo', 'test'];
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return ['go', 'test', './...'];
  const setupCfg = readText(path.join(cwd, 'setup.cfg'));
  const pyproject = readText(path.join(cwd, 'pyproject.toml'));
  if (
    fs.existsSync(path.join(cwd, 'pytest.ini')) ||
    fs.existsSync(path.join(cwd, 'tox.ini')) ||
    /\[tool:pytest\]/i.test(setupCfg ?? '') ||
    /\[tool\.pytest(?:\.|\])/i.test(pyproject ?? '')
  ) {
    return ['python3', '-m', 'pytest'];
  }
  return null;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function formatArgv(argv: string[]): string {
  return argv.map((part) => (/^[\w./:@+-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}
