/**
 * Minimal argument parsing.
 *
 * A dependency would buy little here: six commands, a handful of flags, and one
 * genuinely important rule — everything after `--` belongs to --verify and must
 * reach execFile untouched.
 */
export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | boolean>;
  /** Argv vector after `--`, used verbatim as the verification command. */
  rest: string[];
}

const VALUE_FLAGS = new Set(['scenario', 'cwd', 'max-crash-retries', 'agent']);

const FLAGS_BY_COMMAND: Record<string, ReadonlySet<string>> = {
  run: new Set(['cwd', 'scenario', 'max-crash-retries', 'no-store-output', 'force']),
  resume: new Set(['cwd', 'scenario', 'force']),
  status: new Set(),
  list: new Set(),
  pause: new Set(),
  complete: new Set(),
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const rest: string[] = [];
  let seenDashDash = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (seenDashDash) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      seenDashDash = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (VALUE_FLAGS.has(body) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) {
        flags.set(body, argv[++i]!);
        continue;
      }
      flags.set(body, true);
      continue;
    }
    positional.push(arg);
  }

  return { command: positional[0], positional: positional.slice(1), flags, rest };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const v = flagString(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Rejects typos instead of silently falling back to a less-safe default. */
export function validateFlags(args: ParsedArgs): string | null {
  if (!args.command) return null;
  const allowed = FLAGS_BY_COMMAND[args.command];
  if (!allowed) return null;

  for (const [name, value] of args.flags) {
    if (name === 'help' || name === 'version') continue;
    if (!allowed.has(name)) return `unknown flag for ${args.command}: --${name}`;
    if (VALUE_FLAGS.has(name) && typeof value !== 'string') {
      return `--${name} requires a value`;
    }
  }
  return null;
}
