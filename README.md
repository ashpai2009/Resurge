# Resurge

**Fault-tolerant supervision for long-running Codex tasks.**

Coding agents stop for ordinary reasons: usage limits reset hours later, networks disappear, CLI processes crash, and terminals close. Resurge runs Codex under a durable supervisor, records enough state to recover safely, and resumes only after proving that it will not collide with another process or a changed repository.

> **Project status:** v0.1 beta. The core state machine, detached supervision, recovery gates, and multi-process safety model are implemented and tested on macOS. A controlled real-Codex task is still recommended before relying on it for important unattended work.

## Why Resurge

Resurge is not a retry loop around a shell command. It preserves the context and safety boundary of an agent task:

- Keeps the Codex session ID across rate limits, outages, and crashes.
- Parses advertised reset times and waits until the reset plus a safety margin.
- Runs in the background with a private, durable per-task log.
- Captures Git branch, HEAD, dirty status, and dirty-file content fingerprints at interruption.
- Refuses to resume if the repository changed while the agent was stopped.
- Uses fenced leases and process identity to prevent duplicate supervisors and agents.
- Distinguishes a clean agent exit from actual task completion.
- Stops for human review whenever the evidence is ambiguous.

## Requirements

- Node.js 20 or newer
- macOS or Linux
- Git for repository-aware recovery
- The Codex CLI for real tasks

Windows is rejected in v0.1 because the current safety model depends on POSIX process groups, process-start identity, and filesystem primitives.

## Install from source

```bash
cd /path/to/Resurge
npm run setup
```

That installs dependencies, builds Resurge, and links the `resurge` command. Then check the project you want to supervise:

```bash
cd /path/to/your-project
resurge doctor
```

The Codex CLI is installed separately. Resurge checks the installed CLI and the exact start/resume argument forms before launching a real task.

## Quick start

For the normal workflow, one command chooses Codex, the current project, background supervision, and a conventional test command automatically:

```bash
resurge start "finish the reviewer workflow and run its tests"
```

Resurge recognizes standard npm, pnpm, Yarn, Bun, Cargo, Go, and pytest projects. It prints the verification command before starting. If nothing safe is detected, completion remains manual rather than guessing.

To choose the verification command yourself:

```bash
resurge start "finish the reviewer workflow" -- npm run check
```

Resurge immediately prints a task ID and returns control to the terminal:

```text
Task rsg_... started in the background (supervisor pid 12345).
Status: resurge status rsg_...
Logs:   resurge logs rsg_...
Pause:  resurge pause rsg_...
```

Inspect the task from any shell:

```bash
resurge status <task-id>
resurge logs <task-id>
resurge list
```

Pause it safely:

```bash
resurge pause <task-id>
```

Resume it in the background:

```bash
resurge resume <task-id> --detach
```

Omit `--detach` when you want the supervisor and agent output attached to the current terminal.

## Commands

| Command | Purpose |
|---|---|
| `resurge start "<goal>"` | Recommended one-command launch with safe defaults |
| `resurge doctor` | Check Node, platform, project, storage, Git, and Codex readiness |
| `resurge run <agent> "<goal>"` | Start a supervised task |
| `resurge status [task-id]` | Show one task; defaults to the most recent |
| `resurge list` | List all persisted tasks |
| `resurge logs <task-id>` | Print the recent 256 KiB tail of a detached task log |
| `resurge pause <task-id>` | Request a confirmed process-group stop |
| `resurge resume <task-id>` | Resume through the full safety gate |
| `resurge complete <task-id>` | Manually confirm a cleanly exited task is complete |

Important `start` flags:

| Flag | Meaning |
|---|---|
| `--cwd <directory>` | Supervise a different project |
| `--foreground` | Attach supervision and output to the current terminal |
| `--no-verify` | Disable automatic test-command discovery |
| `-- <command...>` | Use this exact verification command |

Advanced `run` flags:

| Flag | Meaning |
|---|---|
| `--detach` | Run the supervisor independently of the terminal |
| `--cwd <directory>` | Set the task working directory |
| `--no-store-output` | Do not retain the bounded output tail in task state |
| `--max-crash-retries <n>` | Override the default three automatic crash restarts |
| `-- <command...>` | Run a shell-free verification argv after a clean exit |

`resume` accepts `--detach`, `--cwd`, and `--force`. Force acknowledges only reviewable repository or retry-policy findings; it never overrides a live orphan, active owner, corrupt state, or uncertain process identity.

## Recovery behavior

### Usage limits

When Codex reports a usage or quota limit, Resurge stores `RATE_LIMITED`, preserves the session, and parses reset formats including:

- `try again at 1:30 AM`
- `retry in 45 minutes`
- `retry-after: 3600`
- ISO-8601 timestamps

A parsed reset gets a one-minute safety margin. Without a usable reset time, Resurge backs off for 5 minutes, 15 minutes, 45 minutes, then 2 hours. Before every resume it verifies the repository, validates the Codex installation, and checks connectivity.

### Network outages

Network failures such as `ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`, unreachable networks, and TLS handshake failures enter `NETWORK_DOWN`. Connectivity probing is advisory and bounded to 15 minutes; after the budget expires, Resurge attempts a real invocation because that provides stronger evidence than a probe.

### Agent crashes

Signals, panics, stack traces, and non-zero exits are classified separately from usage and network failures. Resurge automatically restarts a crash at most three times with 2-second, 10-second, and 30-second delays, then requires review. A human-forced retry starts a fresh bounded crash window.

### Invalid sessions

Resurge abandons a session only when Codex explicitly reports that it no longer exists. It then creates a fresh session with a structured continuation prompt containing the original goal, repository state, changed files, previous failure, recent output, and next action.

### Unknown failures

Ambiguous evidence never triggers speculative recovery. The task enters `UNKNOWN_FAILURE` and waits for review.

## Completion is explicit

Exit code zero proves that Codex stopped cleanly; it does not prove the requested engineering work is correct. Without a verification command, the task enters `AGENT_EXITED_SUCCESSFULLY` and waits for:

```bash
resurge complete <task-id>
```

For unattended completion, provide a verification argv:

```bash
resurge run codex "fix the test suite" --detach -- npm test
```

The command runs directly without a shell. A passing command produces `COMPLETED`; a failure produces `REQUIRES_REVIEW` with bounded diagnostic output.

## Safety model

### One writer per task

Every task has an exclusive lease containing a random fencing token, monotonic generation, host identity, boot identity, owner PID, and process-start identity. Lease takeover requires proof that the prior owner is gone: a dead process, a recycled PID, or a reboot. A stale heartbeat alone is never proof.

Every mutation runs under a short-lived guard that rechecks the fencing token and task revision. A displaced or stale writer cannot overwrite its successor.

### Repository-aware resume

The recovery baseline is captured immediately after the child exits—not when the task starts. Work completed by the supervised agent is therefore part of the baseline. Changes made after interruption are blocked, including:

- Branch or HEAD changes
- New or removed dirty entries
- Git status changes
- Content changes that retain the same Git status
- Merge conflicts

Resurge assumes no other writer edits the working tree while a task is interrupted. If you intentionally changed it, inspect the result and use `resume --force` to accept a new baseline.

### Confirmed pause and orphan handling

`pause` records `PAUSE_REQUESTED`, signals the agent’s process group, waits for termination, escalates to `SIGKILL` if necessary, and writes `PAUSED` only after confirmed exit.

If a supervisor dies but its agent remains alive, a new Resurge process reports the orphan and leaves it running. It does not kill a process it no longer owns, and it does not start a competing agent.

### Private state

State lives under `${RESURGE_HOME:-~/.resurge}` with `0700` directories and `0600` files. Goals, failure evidence, session IDs, repository paths, bounded output tails, and detached logs may be sensitive. Common credential shapes are redacted before task-state persistence, but redaction is best-effort rather than a confidentiality guarantee.

## Task states

```text
WAITING_TO_RESUME → RUNNING
RUNNING → RATE_LIMITED | NETWORK_DOWN | AGENT_CRASHED
RUNNING → AGENT_EXITED_SUCCESSFULLY → COMPLETED
RUNNING → PAUSE_REQUESTED → STOPPING → PAUSED
any uncertain or unsafe transition → REQUIRES_REVIEW | UNKNOWN_FAILURE
```

## Test without Codex

The bundled fake agent uses the same process launcher and stream boundaries as the Codex adapter while consuming no quota:

```bash
export RESURGE_HOME=/tmp/resurge-demo

resurge run fake "clean exit" --scenario success
resurge run fake "background task" --scenario delayed --detach
resurge run fake "simulated limit" --scenario rate-limit --detach
resurge run fake "simulated crash" --scenario crash
resurge run fake "misleading output" --scenario noisy-stdout
```

For a deterministic crash-then-recovery demonstration:

```bash
counter_file="$(mktemp)"
FAKE_COUNTER_FILE="$counter_file" \
  resurge run fake "recover after two crashes" \
  --scenario crash-then-success
```

## Development and verification

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The offline suite contains 174 passing tests plus three opt-in Codex compatibility tests. It covers deterministic failure classification, reset-time parsing, state transitions, repository divergence, redaction, stale revisions, real process groups, pause ordering, orphan handling, competing lease takeover, easy-start defaults, detached supervision, and end-to-end CLI behavior.

To validate the installed Codex CLI without starting a paid task:

```bash
npm run test:codex
```

CI runs the offline suite on macOS and Linux with Node.js 20 and 22.

## Current limitations

- A machine shutdown ends the detached supervisor; persisted tasks must be resumed after reboot.
- There is no silent-process stall watchdog. Recovery begins when Codex emits a failure or exits.
- Detached logs are durable but do not yet rotate automatically.
- Pipes are used instead of a PTY, so presentation may differ from an interactive Codex terminal.
- Leases are single-host and are not safe on a shared network filesystem.
- Connectivity checks cannot prove API health, authentication validity, or remaining account quota.
- Real provider behavior can change; the compatibility probe catches CLI argument drift, not every service-side error shape.

## Roadmap

1. Optional inactivity watchdog with conservative escalation rather than blind restart.
2. Log following and rotation for long-running detached tasks.
3. PTY-backed execution behind the existing process-launcher interface.
4. Richer completion policies combining tests, lint, typecheck, and diff review.
5. Startup integration for automatic post-reboot recovery.

## License

[MIT](LICENSE)
