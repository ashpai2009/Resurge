# Resurge v0.1 — implementation plan

Status: **complete**. Every item below is implemented and covered by tests
(166 passing, 3 skipped — the skipped ones are the opt-in real-Codex suite,
which needs an installed Codex CLI).

This plan went through three rounds of safety review before implementation
started. Where a review changed the design, the reasoning is recorded next to
the item, because the *reason* is the part that is easy to lose.

---

## 1. Scaffold — ✅ complete

- [x] `package.json`, `tsconfig.json` (strict, NodeNext, ES2022), `vitest.config.ts`
- [x] Removed the placeholder `main.py`
- [x] POSIX-only guard at startup, with the non-portable primitives isolated in
      `src/util/platform.ts` (`boot_id`, `ps -o lstart=`, negative-PGID
      signalling, `O_NOFOLLOW`, directory `fsync`)
- [x] One runtime dependency: zod

## 2. Types and utilities — ✅ complete

- [x] `types/{task,failure,agent,repo,lease,control}.ts`
- [x] `util/clock.ts` — injectable time, so reset-time parsing and backoff are
      testable at all
- [x] `util/jsonl.ts` — buffered line framer. Stream chunks do not align with
      lines, so anything that regexes raw chunks misses events and matches
      across boundaries
- [x] `util/redact.ts` — credential-shape masking
- [x] `util/sleep.ts` — abortable sleep (rate-limit waits run for hours)

## 3. Persistence and the concurrency core — ✅ complete

Built first, because everything else writes through it.

- [x] `paths.ts` — layout under `RESURGE_HOME`, 0700 dirs / 0600 files
- [x] `fsx.ts` — temp → `fsync(file)` → `rename` → `fsync(dir)`; symlink refusal;
      `O_EXCL` creation
- [x] `schema.ts` — zod validation, plus the **redaction chokepoint**: every
      free-text field is masked at the storage layer, so no call site can
      bypass it (an earlier design redacted the output tail but wrote failure
      evidence verbatim)
- [x] `migrations.ts` — ordered registry; a *future* schema version is refused
      rather than mangled
- [x] `json-store.ts` — `load()` is **pure**, so two `status` invocations can
      never fight over a damaged file; quarantine requires the lease
- [x] **`lease.ts`** — the hard part:
  - [x] Fencing token (128-bit random) + monotonic generation
  - [x] **Takeover requires proof, never a timeout.** Process dead, PID
        recycled, or machine rebooted. A live owner with a stale heartbeat is
        `OWNER_UNRESPONSIVE` and escalates — a SIGSTOPped supervisor looks
        exactly like that while its agent keeps writing files
  - [x] **The guard**: one mutex covering takeover *and* every mutation, as
        `acquire guard → verify token → mutate → release`. Verifying the token
        outside a mutex leaves the exact TOCTOU the token exists to close
  - [x] A stale guard is escalated, never stolen — that is what stops the
        recursion
- [x] `control.ts` — `pending → processing → delete`, at-least-once over
      idempotent transitions. Deleting on claim would silently lose a pause if
      the supervisor died mid-apply

## 4. Repository awareness — ✅ complete

- [x] `git.ts` — the four commands, via `execFile` with argv arrays (no shell)
- [x] `porcelain.ts` — parses `--porcelain=v1 -z` into full entries, keeping
      status characters and rename origins. ` M` → `MM` is a real change and
      `UU` is an unresolved conflict; filenames alone cannot express either
- [x] `snapshot.ts` — **three time boundaries**. `repo_at_start` is provenance
      only; `repo_at_interruption` is captured the instant the child exits and
      is the sole gate baseline. Comparing against the *start* snapshot would
      reject every commit the agent legitimately made while supervised
- [x] `verifier.ts` — pure function over two snapshots

## 5. Failure detection — ✅ complete

- [x] `reset-time.ts` — `at 1:30 AM` (next occurrence, rolling past midnight),
      `in 45 minutes`, `retry-after: 3600`, ISO-8601; rejects past times and
      anything more than 24h out
- [x] `rules/{session-invalid,rate-limit,network,crash}.ts`, in that order —
      the crash rule must be last, since a rate-limited agent also exits non-zero
- [x] **Evidence tiers**: JSONL 0.95 / exit 0.9 / stderr 0.85 / **stdout 0.6**,
      against an acceptance threshold of **0.7**. Because stdout tops out below
      the threshold, text the agent merely printed can corroborate a
      classification but can never by itself trigger a recovery
- [x] **Trigger is `code !== 0 || signal !== null`.** A SIGSEGV'd child reports
      `{code: null, signal}`, so an "exit code" check alone would let every
      signal death pass as a clean finish

## 6. Agents — ✅ complete

- [x] `launcher.ts` — `detached: true` for process-group signalling; prompts
      over **stdin**, so goals never appear in `ps` output
- [x] `codex-adapter.ts` — explicit `workspace-write` sandboxing with automatic
      approval review; start and resume prompts travel over stdin
- [x] `capability-probe.ts` — invokes the **exact constructed argv** with
      `--help` appended. Grepping help text for individual tokens proves nothing
      about whether the combination parses. Cached per version and argv contract
- [x] Session ids accepted **only** from `thread.started`; bare and
      loosely-labelled UUIDs rejected
- [x] `scripts/fake-agent.js` — 13 scenarios including `noisy-stdout`,
      `bare-uuid`, `split-jsonl`, `segfault` and `orphan`
- [x] `fake-adapter.ts`, `registry.ts`

## 7. Network — ✅ complete

- [x] Advisory and bounded (~15 min). When the budget expires Resurge attempts
      the resume anyway: a real failed invocation is better evidence than a DNS
      probe, and nothing may block forever
- [x] `healthCheck()` renamed **`installationCheck()`** — it proves the binary
      runs, not that the service is up or credentials are valid

## 8. Recovery — ✅ complete

- [x] `planner.ts` — pure `(Task, FailureEvent, Policy) → RecoveryAction`
- [x] `executor.ts` — the single pre-resume gate every path funnels through
- [x] `continuation-prompt.ts` — all seven required sections; never `continue`
- [x] `completion-policy.ts` — manual by default; `--verify -- <argv>` runs
      without a shell
- [x] `review-reason.ts` — typed reasons with a `forceable` flag. The
      unforceable set is exactly the set where proceeding could put two agents
      on one repository

## 9. Supervisor — ✅ complete

- [x] Run loop: reconcile orphan → run → observe exit → snapshot → persist →
      classify → plan → gate → resume
- [x] **Persist before every risky action**, so a crash of Resurge leaves a
      truthful record
- [x] `orphan.ts` — a provably-live orphan blocks the task and is **left
      running**; Resurge never kills a process it no longer supervises
- [x] `pause.ts` — `PAUSE_REQUESTED → STOPPING → (confirmed exit) → PAUSED`.
      Writing PAUSED before the child is confirmed dead persists a lie
- [x] Crash counter resets after 60s of clean running, so an hour-3 crash is
      not poisoned by two hour-1 crashes
- [x] Heartbeat + control-request consumption on one 5s tick

## 10. CLI — ✅ complete

- [x] `run`, `status`, `list`, `resume`, `pause`, `complete`, `logs`
- [x] `--detach` for both run and resume, with a private handoff that keeps the
      goal out of the background supervisor's argv and a 0600 per-task log
- [x] Ctrl-C takes the confirmed-pause path and is not counted as a crash
- [x] Status output matches the spec's target layout, and surfaces the
      single-writer assumption whenever a task is parked

## 11. Documentation — ✅ complete

- [x] `README.md` — tagline, usage, how it decides things, limitations, v0.2
- [x] `CLAUDE.md` — module map, the twelve invariants, extension points
- [x] `plan.md` — this file

---

## Deliberate deviations from the original spec

| Addition | Why it had to exist |
|---|---|
| `AGENT_EXITED_SUCCESSFULLY` | Exit 0 proves the process ended cleanly, not that the goal is done |
| `PAUSE_REQUESTED` / `STOPPING` | Writing `PAUSED` before the child is confirmed dead persists a lie |
| `resurge complete` | With manual completion policy, something has to write `COMPLETED` |

A late correction found during implementation: an unclassifiable agent failure
was initially escalated as `CORRUPT_STATE`, which is both semantically wrong and
*unforceable* — meaning a user could never `--force` past one. It now uses a
`UNCLASSIFIED_FAILURE` reason (forceable) and reaches the spec's
`UNKNOWN_FAILURE` task state, which was otherwise unreachable.

## Test coverage

166 passing, 3 skipped.

| Area | File |
|---|---|
| rate-limit patterns, reset times, network, crash, evidence tiers | `tests/unit/{detector,reset-time}.test.ts` |
| porcelain parsing, snapshot boundaries, branch/HEAD/dirty verdicts | `tests/unit/repo.test.ts` |
| save/load, permissions, symlink refusal, redaction, corruption | `tests/unit/persistence.test.ts` |
| argv contract, stdin prompts, session-id allowlist | `tests/unit/agents.test.ts` |
| JSONL framing across chunk boundaries | `tests/unit/jsonl.test.ts` |
| detection/recovery import boundary | `tests/unit/import-boundary.test.ts` |
| lease races, suspended-owner fencing, proof-based takeover | `tests/integration/lease.test.ts` |
| state machine, rate-limit waits, retry limits, repo gate, sessions | `tests/integration/supervisor.test.ts` |
| orphans, pause ordering, control requests, `--force` matrix | `tests/integration/safety.test.ts` |
| end-to-end CLI against real processes | `tests/integration/fake-agent.test.ts` |
| detached lifetime, recovery, logs, pause, and resume | `tests/integration/detached.test.ts` |
| installed-CLI drift detection (opt-in) | `tests/compat/codex-cli.test.ts` |
