# CLAUDE.md

Guidance for working in this repository.

## What Resurge is

A supervisor for long-running coding-agent tasks. It launches an agent (Codex in v0.1), watches it, persists task and repository state, classifies interruptions, and resumes safely — or refuses to and says why. The product bias is **safe recovery over aggressive recovery**: when Resurge cannot prove the world is as the agent left it, it stops and asks a human.

TypeScript, Node 20+, ESM, strict mode. One runtime dependency (zod). POSIX only.

## Commands

```bash
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest; builds dist/ first via tests/globalSetup.ts
npm run test:codex  # opt-in suite against a real installed Codex CLI
```

Tests spawn real child processes. `RESURGE_HOME` isolates every test to a temp dir — never let a test touch the real `~/.resurge`.

## Module map

```
src/
  cli/          argument parsing, seven commands, detached handoff, formatting
  types/        shared vocabulary; no logic
  supervisor/   the run loop, orphan reconciliation, pause, tunable policy
  agents/       AgentAdapter implementations, process launcher, capability probe
  failure/      classification only - rules, evidence tiers, reset-time parsing
  recovery/     what to do about a failure - planner, gate, prompts, completion
  persistence/  lease, control requests, atomic store, zod schema, migrations
  repo/         git wrappers, porcelain parsing, snapshot comparison
  network/      advisory connectivity probing
  util/         clock, sleep, jsonl framing, redaction, platform, logging
scripts/fake-agent.js   simulates every failure mode; needs no Codex or quota
tests/integration/detached.test.ts proves background lifetime and control
```

`supervisor/supervisor.ts` is the only module permitted to coordinate across the others. Aim for ~200 lines per file.

## Invariants worth understanding before editing

**1. Detection never triggers recovery.** Nothing under `failure/` may import from `recovery/`, `supervisor/` or `agents/`. Rules take evidence and return a `FailureEvent`; they never act. `tests/unit/import-boundary.test.ts` enforces this — it is a build failure, not a style note.

**2. The lease is the primary serialization mechanism.** Every mutation runs as `acquire guard -> verify fencing token -> compare task revision -> mutate -> release guard`, all inside `LeaseHandle.withGuard`. Verifying the token or revision outside the guard reintroduces a TOCTOU race.

**3. Takeover requires proof, never a timeout.** A lease may be seized only when the owner is provably gone: process dead, PID recycled (start-time mismatch), or `boot_id` changed. A live owner with a stale heartbeat is `OWNER_UNRESPONSIVE` and escalates to a human — a SIGSTOPped or swapped supervisor looks exactly like that while its agent keeps writing files. The same rule governs the guard: a stale guard is never stolen. **No timeout in this system seizes a resource.**

**4. Only the lease owner writes task state.** A non-owner files a control request under `<id>.control/pending/` and the owner applies it. The lifecycle is `pending -> processing -> delete`, deliberately at-least-once over idempotent transitions: deleting on claim would lose a pause if the supervisor died mid-apply.

**5. There are three repository snapshots and only one of them is a gate input.**
   - `repo_at_start` — provenance and display only. **Never** compared against.
   - `repo_at_interruption` — captured the instant the child exits, before any waiting. The recovery baseline.
   - current — captured inside the pre-resume gate.

   The gate compares current against `repo_at_interruption`, so commits the agent made *while supervised* are invisible to it and commits made *while nobody was driving* block the resume. A missing interruption snapshot means review; never fall back to `repo_at_start`.

**6. The repository gate is conservative.** After the interruption snapshot, new, removed, status-changed, or content-changed dirty entries all block automatic resume. The **single-writer assumption** remains documented in the README and printed by `resurge status` for any waiting task.

**7. A clean exit is not success.** `code === 0 && signal === null` yields `AGENT_EXITED_SUCCESSFULLY`. Only `resurge complete` or a passing `--verify` command may write `COMPLETED`. Note the `signal === null` half: a SIGSEGV'd child reports `{code: null, signal}`, and an "exit code 0" check alone would let every signal death pass as success. Failure detection triggers on `code !== 0 || signal !== null`.

**8. `--force` cannot create a second agent.** `ReviewReason` is a typed union with a `forceable` flag (`recovery/review-reason.ts`). Forceable reasons are judgement calls the user can accept. Unforceable ones — `LIVE_ORPHAN`, `ACTIVE_OWNER`, `STALE_GUARD`, `CORRUPT_STATE`, and friends — are cases where proceeding could put two agents on one repository or resume from untrustworthy state. Note that an unexplained agent failure is `UNCLASSIFIED_FAILURE` (forceable, and parked in the `UNKNOWN_FAILURE` state), *not* `CORRUPT_STATE`: the user can reasonably look at it and decide to retry. `--force` never skips the gate; it reruns orphan reconciliation and every check, and aborts on any unforceable finding.

**9. Evidence is ranked, and stdout can never decide.** Confidence ceilings: JSONL 0.95, exit 0.9, stderr 0.85, **stdout 0.6**. Acceptance threshold is **0.7**. Since stdout tops out below the threshold, text the agent merely printed can corroborate a classification but can never by itself trigger an automatic recovery. This is what stops a task that reads a log file mentioning "429" from being treated as rate-limited.

**10. Prompts travel over stdin.** Codex runs with explicit `workspace-write` sandboxing and automatic approval review; the prompt is `-`/stdin, never argv, so goals and continuation prompts never appear in `ps` output.

**11. Session ids come only from `thread.started`.** A bare or loosely-labelled UUID is rejected: resuming the wrong session is worse than starting fresh with a full continuation prompt. Abandoning a session likewise requires an explicit `SESSION_INVALID` classification — a rate limit during resume is a rate limit, and the session is kept.

**12. Redaction is a storage-layer chokepoint.** `persistence/schema.ts::redactTask` covers every free-text field on write. Do not redact at call sites; an earlier design did, and failure evidence bypassed it. `load()` is pure and never mutates storage — quarantine of a corrupt record happens only under a held lease.

**13. Detached launch data never enters argv.** `--detach` writes a 0600 handoff under `RESURGE_HOME`; the child receives only an opaque task id and deletes the handoff after validation. Goals and verification commands must not be copied into the detached supervisor's process arguments. Detached stdout/stderr share a private per-task log.

## Extending it

**A new failure rule**: add `failure/rules/<name>.ts` exporting a factory that returns `{type, detect(input)}`, and register it in the array in `failure/detector.ts`. Mind the ordering — the crash rule is last because a rate-limited agent also exits non-zero. Respect the source ceilings in `types/failure.ts`.

**A new agent**: implement `AgentAdapter` (`types/agent.ts`) in `agents/`, and add a case to `agents/registry.ts`. Nothing in `supervisor/`, `failure/` or `recovery/` should need to change. Two contracts to honour: `AgentProcess.wait()` must return the *same* promise on every call (both the supervisor and the stop routine await it), and the launcher must set `detached: true` so signals reach the agent's own subprocesses.

**A schema change**: bump `SCHEMA_VERSION` in `persistence/schema.ts` and add a migration to `persistence/migrations.ts`. Records from a *newer* schema are refused, not migrated backwards.

## Environment

- `RESURGE_HOME` — state directory (default `~/.resurge`). Always set this in tests.
- `RESURGE_LOG` — `debug` | `info` | `warn` | `error`.
- `RESURGE_CODEX_BIN` — path to the Codex binary.
- `RESURGE_CODEX_RESUME=0` — disable session resume, always start fresh.
- `FAKE_SCENARIO`, `FAKE_COUNTER_FILE`, `FAKE_DELAY_MS`, `FAKE_PROMPT_LOG` — fake-agent controls.

## Scope

v0.1 is Codex only. Explicitly out of scope: web dashboard, Claude/Gemini adapters, cross-agent handoff, analytics, team features, milestone inference. `AgentAdapter` exists so those stay cheap to add later — not as an invitation to add them now.
