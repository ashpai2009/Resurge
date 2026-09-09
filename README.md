# Resurge

**Fault tolerance for coding agents.**

**Your agents can stop. Your work doesn't.**

Resurge supervises a long-running Codex task so you don't have to babysit it. When the usage limit resets at 1:30 AM, when the wifi drops, when the CLI segfaults — Resurge notices, records what was happening, waits, checks that the world is still as the agent left it, and picks up where it stopped.

And when it *can't* be sure that's safe, it stops and tells you why.

---

## Install

Requires Node 20+ and macOS or Linux.

```bash
npm install
npm run build
npm link          # optional, puts `resurge` on your PATH
```

The Codex CLI must be installed separately for real runs. Everything below works without it via the built-in fake agent.

## Usage

```bash
resurge run codex "finish the Apollo Labs reviewer workflow"
```

That's the whole thing. Resurge creates a task, launches Codex, streams its output, and supervises it in the foreground. Task state lives in `~/.resurge`, so the other commands work from any shell and survive Resurge itself dying.

```bash
resurge status              # the most recent task
resurge list                # everything Resurge knows about
resurge resume <task-id>    # pick an interrupted task back up
resurge pause <task-id>     # stop the agent, confirm it died, record it
resurge complete <task-id>  # you reviewed the work; mark it done
```

`resurge status` looks like this:

```
Apollo Labs Reviewer Workflow

Agent          codex
State          RATE_LIMITED
Resume         01:31 AM  in 3 hr
Branch         backend-review
HEAD           abc1234
Dirty files    4
Checkpoint     38 sec ago

Failure
RATE_LIMIT: Error: usage limit reached. Try again at 1:30 AM

Resurge assumes nothing else edits this repository while the task is interrupted.
```

### Try it without Codex

The fake agent simulates every failure mode, costs nothing, and needs no API access:

```bash
export RESURGE_HOME=/tmp/resurge-demo

resurge run fake "demo" --scenario success        # clean exit
resurge run fake "demo" --scenario rate-limit     # waits for the reset time
resurge run fake "demo" --scenario crash          # 3 restarts, then review
resurge run fake "demo" --scenario network        # waits for connectivity
resurge run fake "demo" --scenario noisy-stdout   # prints "429" but is fine
```

### Verification

By default a clean exit is *not* treated as success (see below). Give Resurge a way to check and it will decide for itself:

```bash
resurge run codex "fix the failing tests" -- npm test
```

Everything after `--` is an argv vector, run without a shell. Passing means `COMPLETED`; failing means `REQUIRES_REVIEW` with the output.

---

## How it decides things

Four ideas do most of the work.

**A clean exit is not success.** Codex exits 0 when it finishes, and also when it hits a blocker, asks you a question, or does half the job. So a clean exit lands in `AGENT_EXITED_SUCCESSFULLY` — a real state, not a synonym for done. `COMPLETED` requires either your confirmation (`resurge complete`) or a passing verification command. Resurge trusts exit codes, git state, and test results; it does not trust an agent's account of its own progress.

**The repository is checked against the moment of interruption, not the start.** Resurge snapshots the repo the instant the agent dies, before it waits or retries. On resume it compares *now* against *that* snapshot. Commits the agent made while supervised are already in the baseline, so they never block anything. Commits made while nobody was driving do:

```
Expected HEAD: abc123
Current HEAD:  def456

Repository changed while the agent was interrupted. Automatic resume has been blocked.
```

**Detection never triggers recovery.** The code that recognises a rate limit returns a structured `FailureEvent`; something else decides what to do about it. A regex cannot restart a process. This boundary is enforced by a test, not a convention.

**Nothing is seized on a timeout.** Every task has an exclusive lease. Resurge takes over a lease only when the previous owner is *provably* gone — the process is dead, its PID was recycled, or the machine rebooted. A supervisor that is alive but not responding gets escalated to you, never overridden. The same applies to an agent process that outlived its supervisor: Resurge reports it and refuses to start a second one, rather than killing something it no longer owns.

---

## Test

```bash
npm test                # 159 tests, no Codex or network required
npm run typecheck
npm run test:codex      # opt-in: runs against a real installed Codex CLI
```

The suite spawns real processes to prove the multi-process behaviour: two supervisors racing one stale lease, a supervisor suspended mid-write, an agent that outlives its parent. Everything else runs against the fake agent.

---

## Known limitations

- **Foreground only.** Closing the terminal ends supervision. State survives, and `resurge resume` picks it up — but a multi-hour rate-limit wait needs the terminal to stay open. Detached mode is the top item for v0.2.
- **macOS and Linux only.** The safety model depends on POSIX process identity and process-group signalling. Windows is refused at startup rather than degraded quietly.
- **Single-writer assumption.** While a task is interrupted, Resurge assumes nothing else edits the repository. New, removed, status-changed, or content-changed dirty entries block automatic resume. If you edit the repo yourself during an interruption, inspect the result and resume manually with `--force`.
- **The connectivity probe is advisory.** It checks reachability, not whether Codex is up or your credentials are valid. It is bounded: when the budget expires Resurge tries the resume anyway, because a real failed invocation is better evidence than a probe.
- **Orphans are never reclaimed automatically.** You stop them.
- **Redaction is best-effort.** Persisted text is scanned for common credential shapes. `--no-store-output` drops the output tail, but the goal, failure evidence and file paths are still stored — they are what makes recovery work. Treat `~/.resurge` (mode 0700) as sensitive.
- **Pipes, not a PTY.** Output may differ from an interactive terminal.
- **Session ids come only from `thread.started`.** Anything else falls back to a fresh session with a full continuation prompt, which is safer than resuming the wrong session.
- **Single host.** Leases are not safe on a shared network filesystem.

## What's next (v0.2)

1. **Detached mode** (`--detach`) with log tailing — the biggest real-world gap, since rate-limit waits run for hours.
2. **A `node-pty` launcher** behind the existing `ProcessLauncher` interface, for full interactive-Codex fidelity.
3. **Richer completion evidence** — extend `--verify` into a policy chain (tests, lint, diff review) and make it the recommended default.

## License

MIT
