#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const npmCli = process.env['npm_execpath'];
const npmCommand = npmCli ? [process.execPath, npmCli] : ['npm'];

for (const args of [['ci'], ['run', 'build'], ['link']]) {
  const [command, ...prefix] = npmCommand;
  execFileSync(command, [...prefix, ...args], { stdio: 'inherit' });
}

process.stdout.write('\nResurge is installed. Run `resurge doctor` inside your project.\n');
