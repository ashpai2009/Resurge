import { execFileSync } from 'node:child_process';

/**
 * Several tests spawn real child processes to prove multi-process behaviour
 * (lease races, orphan reconciliation). Those children run compiled JS, so the
 * build has to exist before the suite starts — and building here also means a
 * broken build fails the tests rather than passing them against stale output.
 */
export default function setup(): void {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
}
