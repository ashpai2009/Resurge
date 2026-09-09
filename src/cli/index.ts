#!/usr/bin/env node
import { parseArgs, validateFlags } from './args.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { listCommand } from './commands/list.js';
import { resumeCommand } from './commands/resume.js';
import { pauseCommand } from './commands/pause.js';
import { completeCommand } from './commands/complete.js';
import { assertSupportedPlatform } from '../util/platform.js';
import { logger } from '../util/logger.js';

const USAGE = `resurge - fault tolerance for coding agents

Usage:
  resurge run <agent> "<task>"     start a supervised task
  resurge status [task-id]         show one task (default: most recent)
  resurge list                     list all known tasks
  resurge resume <task-id>         resume an interrupted task
  resurge pause <task-id>          stop the agent and record the task paused
  resurge complete <task-id>       mark a cleanly-exited task complete

Run flags:
  --cwd <dir>                  repository to supervise (default: current directory)
  --scenario <name>            fake-agent scenario, for testing without quota
  --max-crash-retries <n>      automatic restarts before requiring review (default 3)
  --no-store-output            do not persist the agent output tail
  -- <command...>              verification command; passing it promotes a clean
                               exit to COMPLETED, a failure to REQUIRES_REVIEW

Resume flags:
  --force                      proceed despite a forceable review reason. It never
                               skips the safety gate, and cannot override a live
                               agent process or an active supervisor.

Agents: codex (and "fake" for testing)
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || args.command === 'help' || args.flags.has('help')) {
    process.stdout.write(USAGE);
    return args.command ? 0 : 64;
  }
  if (args.flags.has('version')) {
    process.stdout.write('resurge 0.1.0\n');
    return 0;
  }

  const flagError = validateFlags(args);
  if (flagError) {
    process.stderr.write(`${flagError}\n`);
    return 64;
  }

  // Resurge's safety model depends on POSIX process identity and process-group
  // signalling. Refusing outright beats degrading quietly.
  assertSupportedPlatform();

  switch (args.command) {
    case 'run':
      return runCommand(args);
    case 'status':
      return statusCommand(args.positional[0]);
    case 'list':
      return listCommand();
    case 'resume':
      return resumeCommand(args);
    case 'pause':
      return pauseCommand(args.positional[0]);
    case 'complete':
      return completeCommand(args.positional[0]);
    default:
      process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}`);
      return 64;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    logger.error(err instanceof Error ? err.message : String(err));
    if (process.env['RESURGE_LOG'] === 'debug' && err instanceof Error) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = 1;
  });
