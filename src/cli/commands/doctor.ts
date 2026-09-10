import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAdapter } from '../../agents/registry.js';
import { ensureLayout, resurgeHome } from '../../persistence/paths.js';
import { captureSnapshot } from '../../repo/snapshot.js';
import { isSupportedPlatform } from '../../util/platform.js';

type Check = { level: 'ok' | 'warn' | 'fail'; label: string; detail: string };

/** Runs every prerequisite check needed by the easy start path. */
export async function doctorCommand(directory?: string): Promise<number> {
  const cwd = path.resolve(directory ?? process.cwd());
  const checks: Check[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    level: nodeMajor >= 20 ? 'ok' : 'fail',
    label: 'Node.js',
    detail: `${process.versions.node}${nodeMajor >= 20 ? '' : ' (20 or newer required)'}`,
  });
  checks.push({
    level: isSupportedPlatform() ? 'ok' : 'fail',
    label: 'Platform',
    detail: `${process.platform}/${process.arch}`,
  });

  try {
    const stat = fs.statSync(cwd);
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.W_OK);
    checks.push({
      level: stat.isDirectory() ? 'ok' : 'fail',
      label: 'Project',
      detail: stat.isDirectory() ? cwd : `${cwd} is not a directory`,
    });
  } catch (err) {
    checks.push({ level: 'fail', label: 'Project', detail: errorText(err) });
  }

  try {
    ensureLayout();
    fs.accessSync(resurgeHome(), fs.constants.R_OK | fs.constants.W_OK);
    const mode = fs.statSync(resurgeHome()).mode & 0o777;
    checks.push({
      level: mode === 0o700 ? 'ok' : 'fail',
      label: 'State',
      detail: `${resurgeHome()} (${mode.toString(8)})`,
    });
  } catch (err) {
    checks.push({ level: 'fail', label: 'State', detail: errorText(err) });
  }

  const snapshot = await captureSnapshot(cwd);
  if (snapshot.unavailable_reason) {
    checks.push({ level: 'fail', label: 'Git', detail: snapshot.unavailable_reason });
  } else if (snapshot.root === null) {
    checks.push({
      level: 'warn',
      label: 'Git',
      detail: 'not a Git repository; repository-change protection will be unavailable',
    });
  } else {
    checks.push({
      level: snapshot.entries.length === 0 ? 'ok' : 'warn',
      label: 'Git',
      detail:
        snapshot.entries.length === 0
          ? snapshot.root
          : `${snapshot.root} (${snapshot.entries.length} existing change${snapshot.entries.length === 1 ? '' : 's'})`,
    });
  }

  try {
    const installation = await createAdapter('codex').installationCheck();
    checks.push({
      level: installation.ok ? 'ok' : 'fail',
      label: 'Codex',
      detail: installation.detail,
    });
  } catch (err) {
    checks.push({ level: 'fail', label: 'Codex', detail: errorText(err) });
  }

  process.stdout.write('Resurge doctor\n\n');
  for (const check of checks) {
    process.stdout.write(`${marker(check.level)} ${check.label.padEnd(10)} ${check.detail}\n`);
  }

  const failures = checks.filter((check) => check.level === 'fail').length;
  const warnings = checks.filter((check) => check.level === 'warn').length;
  process.stdout.write(
    failures === 0
      ? `\nReady to start.${warnings > 0 ? ` ${warnings} warning${warnings === 1 ? '' : 's'}.` : ''}\n`
      : `\nNot ready: ${failures} check${failures === 1 ? '' : 's'} failed.\n`,
  );
  return failures === 0 ? 0 : 1;
}

function marker(level: Check['level']): string {
  if (level === 'ok') return '[ok]  ';
  if (level === 'warn') return '[warn]';
  return '[fail]';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
