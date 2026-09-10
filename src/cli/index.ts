#!/usr/bin/env node
import { flagBool, flagString, parseArgs, validateFlags } from './args.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { listCommand } from './commands/list.js';
import { resumeCommand } from './commands/resume.js';
import { pauseCommand } from './commands/pause.js';
import { completeCommand } from './commands/complete.js';
import { logsCommand } from './commands/logs.js';
import { startCommand } from './commands/start.js';
import { doctorCommand } from './commands/doctor.js';
import { claimDetachedRequest, launchDetached } from './detach.js';
import { assertSupportedPlatform } from '../util/platform.js';
import { logger } from '../util/logger.js';

const USAGE = `resurge - fault tolerance for coding agents

Usage:
  resurge start "<task>"            easy start: Codex + background + auto tests
  resurge doctor                    check that this project is ready
  resurge status [task-id]          show progress (default: most recent)

Advanced:
  resurge run <agent> "<task>"     start a supervised task
  resurge list                     list task history, times, and log files
  resurge resume <task-id>         resume an interrupted task
  resurge pause <task-id>          stop the agent and record the task paused
  resurge complete <task-id>       mark a cleanly-exited task complete
  resurge logs <task-id>           print the recent tail of a detached task log

Start flags:
  --cwd <dir>                  project to supervise (default: current directory)
  --foreground                 keep output attached to this terminal
  --no-verify                  do not auto-detect a test command
  -- <command...>              use this exact verification command

Advanced run flags:
  --cwd <dir>                  repository to supervise (default: current directory)
  --scenario <name>            fake-agent scenario, for testing without quota
  --max-crash-retries <n>      automatic restarts before requiring review (default 3)
  --no-store-output            do not persist the agent output tail
  --detach                     supervise in the background and write a task log
  -- <command...>              verification command; passing it promotes a clean
                               exit to COMPLETED, a failure to REQUIRES_REVIEW

Resume flags:
  --force                      proceed despite a forceable review reason. It never
                               skips the safety gate, and cannot override a live
                               agent process or an active supervisor.
  --detach                     keep supervising in the background after resume

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

  // Doctor reports unsupported platforms as a check instead of throwing before
  // it has a chance to explain what is wrong.
  if (args.command === 'doctor') return doctorCommand(flagString(args, 'cwd'));

  // Resurge's safety model depends on POSIX process identity and process-group
  // signalling. Refusing outright beats degrading quietly.
  assertSupportedPlatform();

  if ((args.command === 'run' || args.command === 'resume') && flagBool(args, 'detach')) {
    return launchDetached(args);
  }

  switch (args.command) {
    case 'start':
      return startCommand(args);
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
    case 'logs':
      return logsCommand(args.positional[0]);
    case '__detached': {
      const request = claimDetachedRequest(args.positional[0] ?? '');
      if (!request) {
        process.stderr.write('Detached launch request is missing or invalid.\n');
        return 1;
      }
      return request.args.command === 'run'
        ? runCommand(request.args, {
            taskId: request.taskId,
            detached: true,
            logPath: request.logPath,
          })
        : resumeCommand(request.args, { detached: true, logPath: request.logPath });
    }
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
