# Resurge

**Your coding agent stops. Your work doesn't.**

Long agent tasks fail for boring reasons. You hit a usage limit at 1 a.m. and the reset is four hours away. The Wi-Fi drops. The CLI crashes. You close your laptop lid, or the terminal window, and everything dies with it.

Resurge runs Codex under a supervisor that survives all of that. It watches the agent, saves enough state to pick up where things stopped, waits out the limit or the outage, and starts the agent again — but **only after proving it is safe to do so**. If it cannot prove that, it stops and tells you why instead of guessing.

> **Status:** v0.1 beta. The state machine, background supervision, recovery gates, and multi-process safety model are implemented and tested on macOS and Linux. Before trusting it with important unattended work, run one real Codex task and watch what it does.

---

## Table of contents

- [Is Resurge for you?](#is-resurge-for-you)
- [Requirements](#requirements)
- [Install](#install)
- [Your first task](#your-first-task)
- [Everyday commands](#everyday-commands)
- [Reading the status output](#reading-the-status-output)
- [Why "finished" needs proof](#why-finished-needs-proof)
- [Try it without using any Codex quota](#try-it-without-using-any-codex-quota)
- [What Resurge does when things break](#what-resurge-does-when-things-break)
- [When Resurge refuses to resume](#when-resurge-refuses-to-resume)
- [Command reference](#command-reference)
- [Configuration](#configuration)
- [How the safety model works](#how-the-safety-model-works)
- [Known limitations](#known-limitations)
- [Development](#development)
- [License](#license)

---

## Is Resurge for you?

Resurge helps if you run **long, unattended Codex tasks** — the kind you start and walk away from.

**Good fit**

- "Refactor this module and keep the tests green" started before bed.
- Any task long enough to hit a five-hour usage limit partway through.
- Work you want to keep running after you close the terminal.

**Not needed**

- Short interactive sessions where you are watching the screen anyway.
- Tasks where you want to approve every step yourself.

Resurge is not a retry loop. A retry loop re-runs a command and hopes. Resurge keeps the agent's session, remembers exactly what your repository looked like when things stopped, and refuses to continue if the world changed underneath it.

---

## Requirements

| You need | Why |
|---|---|
| **Node.js 20 or newer** | Resurge is a Node CLI |
| **macOS or Linux** | The safety model uses POSIX process groups and process identity. Windows is refused rather than half-supported |
| **Git** | Optional, but without it Resurge cannot protect you from repository changes |
| **The Codex CLI** | Installed and signed in separately. Resurge supervises it; it does not bundle it |

---

## Install

Resurge is not on npm yet, so install it from the source checkout:

```bash
cd /path/to/Resurge
npm run setup
```

That one command installs dependencies, builds the project, and links a global `resurge` command.

Then go to the project you actually want to work on and confirm everything is ready:

```bash
cd /path/to/your-project
resurge doctor
```

You should see a list of checks:

```text
Node.js    v22.14.0
Platform   darwin/arm64
Project    /path/to/your-project
State      /Users/you/.resurge (700)
Git        /path/to/your-project
Codex      codex-cli 0.20.0
```

Fix anything marked as failing before starting a real task. `resurge doctor` is safe to run as often as you like — it never starts an agent and never changes your repository.

---

## Your first task

**1. Start from inside your project.**

```bash
cd /path/to/your-project
resurge start "add pagination to the users endpoint and keep the tests passing"
```

Describe the goal the way you would to a teammate. Resurge passes it to Codex over stdin, never as a command-line argument, so your goal does not show up in `ps` for other users on the machine.

**2. Read what Resurge tells you before it launches.**

```text
Starting codex in the background for /path/to/your-project
Verification: npm test

Task rsg_01H8X... started in the background (supervisor pid 41022).
Status: resurge status rsg_01H8X...
Logs:   resurge logs rsg_01H8X...
Pause:  resurge pause rsg_01H8X...
```

Two things matter here:

- **`Verification: npm test`** — Resurge found your project's test command by itself. It will run that command to decide whether the task really finished. If it says `none detected`, completion will wait for you to confirm it manually.
- **`in the background`** — the task now outlives this terminal. You can close the window.

**3. Walk away.** Close the terminal, shut the lid for a bit, come back later.

**4. Check on it from any shell.**

```bash
resurge status
```

`latest` is the default for read-only commands, so plain `resurge status` shows your most recent task.

**5. See what the agent actually printed.**

```bash
resurge logs latest
```

**6. Stop it if you change your mind.**

```bash
resurge pause latest
```

Pause is confirmed, not hopeful: Resurge signals the agent's whole process group, waits for it to actually exit, escalates if it has to, and only then records the task as paused.

**7. Pick it back up later.**

```bash
resurge resume latest --detach
```

Drop `--detach` if you would rather watch the output in your current terminal.

---

## Everyday commands

The five you will actually use:

```bash
resurge start "<what you want done>"   # start a task in the background
resurge status                         # how is the latest task doing?
resurge logs latest                    # what did the agent print?
resurge pause latest                   # stop it, safely and confirmed
resurge resume latest --detach         # continue where it left off
```

Two conventions worth knowing:

- **Read-only commands default to the latest task.** `resurge status` and `resurge list` need no arguments.
- **Commands that change something want you to be explicit.** Write `resurge pause latest` or a full task ID, so you cannot stop the wrong task by reflex.

---

## Reading the status output

```text
Add pagination to the users endpoint

Agent         codex
State         RATE_LIMITED
Resume        3:14 AM   in 2 hours 41 minutes
Session       0199a3f2-...
Mode          detached
Log           /Users/you/.resurge/logs/rsg_01H8X....log
Branch        main
HEAD          67be358
Dirty files   4
Checkpoint    6 minutes ago
Supervisor    pid 41022
Task id       rsg_01H8X...

Failure
RATE_LIMITED: usage limit reached, try again at 3:14 AM
```

What the states mean:

| State | What it means | What you should do |
|---|---|---|
| `RUNNING` | The agent is working | Nothing |
| `RATE_LIMITED` | Usage limit hit; waiting for the reset | Nothing — `Resume` shows when it restarts |
| `NETWORK_DOWN` | The network went away | Nothing, unless it stays down |
| `AGENT_CRASHED` | The CLI died; a restart is queued | Nothing yet |
| `WAITING_TO_RESUME` | Waiting for its restart moment | Nothing |
| `PAUSED` | You stopped it, and the stop is confirmed | `resurge resume latest --detach` |
| `AGENT_EXITED_SUCCESSFULLY` | The agent finished cleanly, but nothing has proven the goal is done | Review the work, then `resurge complete latest` |
| `COMPLETED` | Verification passed, or you confirmed it | Nothing |
| `REQUIRES_REVIEW` | Resurge stopped on purpose and will not continue alone | Read the `Blocked` section |
| `UNKNOWN_FAILURE` | Something failed in a way Resurge will not guess about | Read the logs, then resume if it looks fine |

The last two are the point of the tool. Resurge would rather hand you a decision than make a bad one for you.

---

## Why "finished" needs proof

**Exit code zero means the agent stopped cleanly. It does not mean your feature works.**

So Resurge never marks a task `COMPLETED` just because Codex exited quietly. One of two things has to happen first.

**Option A — you confirm it.**

```bash
resurge status            # task sits in AGENT_EXITED_SUCCESSFULLY
# look at the diff, run whatever you want
resurge complete latest
```

**Option B — a command proves it.** This is what makes unattended runs worthwhile:

```bash
resurge start "fix the failing auth tests" -- npm test
```

Everything after `--` is the verification command. It runs directly, with no shell in between, so there is nothing to quote wrong and nothing to inject. If it passes, the task becomes `COMPLETED`. If it fails, the task becomes `REQUIRES_REVIEW` and keeps the output.

`resurge start` tries to find this command for you in npm, pnpm, Yarn, Bun, Cargo, Go, and pytest projects, and prints what it found before launching. To turn that off:

```bash
resurge start "explore some options" --no-verify
```

---

## Try it without using any Codex quota

Resurge ships a fake agent that goes through the same launcher, the same streams, and the same state machine as Codex — while burning none of your usage. It is the fastest way to see the recovery behavior for yourself.

Point Resurge at a scratch directory first so your real task history stays clean:

```bash
export RESURGE_HOME=/tmp/resurge-demo

resurge run fake "clean exit"        --scenario success
resurge run fake "simulated limit"   --scenario rate-limit --detach
resurge run fake "simulated crash"   --scenario crash
resurge run fake "misleading output" --scenario noisy-stdout
```

The last one is the interesting one. The fake agent prints a convincing `429 rate limit` message to stdout and then exits normally. Resurge does **not** treat it as rate-limited, because text an agent merely printed is never strong enough evidence to act on by itself.

To watch it crash twice and then recover on its own:

```bash
counter_file="$(mktemp)"
FAKE_COUNTER_FILE="$counter_file" \
  resurge run fake "recover after two crashes" --scenario crash-then-success
```

---

## What Resurge does when things break

### Usage limits

The task becomes `RATE_LIMITED`, the Codex session is preserved, and Resurge reads the reset time out of the error. It understands `try again at 1:30 AM`, `retry in 45 minutes`, `retry-after: 3600`, and ISO-8601 timestamps, and adds a one-minute margin.

If no reset time can be read, it backs off 5 minutes, 15 minutes, 45 minutes, then 2 hours. Before every restart it rechecks your repository, the Codex installation, and connectivity.

### Network outages

Failures like `ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`, unreachable networks, and TLS handshake errors become `NETWORK_DOWN`. Connectivity probing is advisory and capped at 15 minutes; after that Resurge just tries the real thing, because an actual attempt is better evidence than a probe.

### Crashes

Signals, panics, stack traces, and non-zero exits are classified separately from limits and outages. Resurge restarts a crash at most three times — after 2 seconds, 10 seconds, then 30 seconds — and then asks for review rather than looping forever.

### Expired sessions

Resurge gives up on a Codex session only when Codex explicitly says the session is gone. It then starts a fresh one with a continuation prompt containing the original goal, the repository state, the changed files, the previous failure, and the recent output — so the new session is not starting blind.

A rate limit that happens to occur during a resume is still a rate limit. The session is kept.

### Anything ambiguous

If the evidence does not clearly point at one cause, Resurge does nothing automatic. The task parks in `UNKNOWN_FAILURE` and waits for a human. You can look at it and retry if it seems fine.

---

## When Resurge refuses to resume

Before restarting an agent, Resurge compares your repository against how it looked **at the moment the agent stopped**. If anything changed while nobody was driving, the resume is blocked:

- the branch or HEAD moved
- files appeared in or disappeared from the dirty set
- a file's Git status changed
- a file's contents changed while keeping the same status
- there are merge conflicts

This exists because a resumed agent believes it is continuing its own work. If you rebased, switched branches, or edited files in the meantime, that belief is wrong and the agent can do real damage acting on it.

> **Single-writer assumption:** while a task is interrupted, Resurge assumes nothing else is editing that working tree. `resurge status` reminds you of this for any waiting task.

If you changed things on purpose, look at the diff and then accept a new baseline:

```bash
resurge resume latest --force
```

**`--force` is narrower than it sounds.** It lets you accept judgement calls — a changed repository, an exhausted retry budget. It does **not** skip the safety gate, and it cannot override:

- a live orphaned agent still running
- another supervisor actively holding the task
- state that could not be read or trusted

Those refusals stand, because forcing past them could put two agents on one repository or resume from state nobody can vouch for.

---

## Command reference

| Command | What it does |
|---|---|
| `resurge start "<goal>"` | Recommended way to start: Codex, this directory, background, auto-detected tests |
| `resurge doctor` | Check Node, platform, project, storage, Git, and Codex readiness |
| `resurge status [id\|latest]` | Show one task (defaults to the most recent) |
| `resurge list` | Every task, with start time, status, and log path |
| `resurge logs <id\|latest>` | The last 256 KiB of a background task's log |
| `resurge pause <id\|latest>` | Stop the agent and confirm it actually stopped |
| `resurge resume <id\|latest>` | Continue a task through the full safety gate |
| `resurge complete <id\|latest>` | Confirm by hand that a cleanly-exited task is done |
| `resurge run <agent> "<goal>"` | Advanced: start a task with every knob exposed |

**Flags for `start`**

| Flag | Meaning |
|---|---|
| `--cwd <dir>` | Supervise a different project |
| `--foreground` | Keep supervision attached to this terminal |
| `--no-verify` | Do not auto-detect a test command |
| `-- <command...>` | Use exactly this verification command |

**Flags for `run`** (advanced)

| Flag | Meaning |
|---|---|
| `--detach` | Supervise in the background with a private log |
| `--cwd <dir>` | Set the working directory |
| `--scenario <name>` | Fake-agent scenario, for testing without quota |
| `--max-crash-retries <n>` | Change the default of three automatic restarts |
| `--no-store-output` | Do not keep the output tail in task state |
| `-- <command...>` | Verification command, run without a shell |

**Flags for `resume`**: `--detach`, `--cwd`, `--force`.

---

## Configuration

| Variable | Purpose |
|---|---|
| `RESURGE_HOME` | Where state lives (default `~/.resurge`) |
| `RESURGE_LOG` | `debug`, `info`, `warn`, or `error` |
| `RESURGE_CODEX_BIN` | Path to the Codex binary |
| `RESURGE_CODEX_RESUME=0` | Never resume sessions; always start fresh |

---

## How the safety model works

You do not need this section to use Resurge. It is here because unattended tools deserve to explain themselves.

### One supervisor per task, provably

Every task holds an exclusive lease carrying a random fencing token, a generation counter, host identity, boot identity, the owner's PID, and that process's start time. Every write rechecks the token and the task revision under a short-lived guard, so a displaced supervisor cannot overwrite the one that replaced it.

Taking a lease from someone else requires **proof they are gone**: the process is dead, the PID was recycled, or the machine rebooted. A supervisor that is merely slow to check in is not proof — it might be suspended while its agent happily keeps writing files. That case escalates to you.

**No timeout in Resurge ever seizes a resource.**

### Orphans are left alone

If a supervisor dies but its agent is still running, the next Resurge process reports the orphan and **leaves it running**. It will not kill a process it no longer owns, and it will not start a second agent alongside it.

### Evidence is ranked

Different sources of evidence carry different weight, and the threshold to act automatically is 0.7:

| Source | Ceiling |
|---|---|
| Structured JSONL events | 0.95 |
| Exit codes and signals | 0.9 |
| stderr | 0.85 |
| **stdout** | **0.6** |

stdout tops out *below* the threshold on purpose. Text the agent merely printed can support a conclusion but can never cause one. That is why a task that reads a log file mentioning "429" is not mistaken for being rate-limited.

### Your data stays local and private

State lives under `${RESURGE_HOME:-~/.resurge}` with `0700` directories and `0600` files. Goals, session IDs, failure evidence, and output tails can be sensitive. Common credential shapes are redacted before anything is written to disk — best-effort, not a guarantee. Nothing is transmitted anywhere.

---

## Known limitations

Worth knowing before you rely on it:

- **A reboot ends background supervisors.** Tasks survive on disk, but you have to resume them yourself afterwards.
- **No stall detection.** If Codex hangs silently without exiting, Resurge waits. Recovery starts when the agent fails or exits.
- **Logs do not rotate yet.** A very long task can produce a very large log.
- **Pipes, not a PTY.** Output may look different from an interactive Codex terminal.
- **Single machine only.** Leases are not safe on a shared network filesystem.
- **Connectivity checks are advisory.** They cannot prove API health, valid authentication, or remaining quota.
- **Providers change.** The compatibility probe catches CLI argument drift, not every possible service-side error.

---

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The offline suite covers failure classification, reset-time parsing, state transitions, repository divergence, redaction, stale revisions, real process groups, pause ordering, orphan handling, competing lease takeover, easy-start defaults, detached supervision, and end-to-end CLI behavior. It runs on macOS and Linux against Node 20 and 22 in CI.

To check your installed Codex CLI without starting a paid task:

```bash
npm run test:codex
```

---

## License

[MIT](LICENSE)
