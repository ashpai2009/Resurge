import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A throwaway git repository for tests that need real git behaviour. */
export class TempRepo {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(path.join(os.tmpdir(), 'resurge-repo-'));
    this.git(['init', '-q']);
    // `git init -b` is not available on older git; set the branch explicitly.
    this.git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    this.git(['config', 'user.email', 'test@example.com']);
    this.git(['config', 'user.name', 'Resurge Test']);
    this.write('README.md', '# fixture\n');
    this.git(['add', '.']);
    this.commit('initial');
  }

  git(args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8' });
  }

  write(rel: string, contents: string): void {
    writeFileSync(path.join(this.dir, rel), contents);
  }

  commit(message: string): void {
    this.git(['commit', '-q', '--allow-empty', '-m', message]);
  }

  head(): string {
    return this.git(['rev-parse', 'HEAD']).trim();
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
