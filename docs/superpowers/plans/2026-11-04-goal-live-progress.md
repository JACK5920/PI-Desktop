# Goal Live Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh active Goal token/time progress, clarify cycle and historical-stop wording, and preserve Host budget semantics.

**Architecture:** Expose the persisted cycle start timestamp additively. Main reuses its deduplicated active-turn usage and the Host lifecycle token baseline to emit an execution-scoped transient progress event; the Renderer validates identity and only displays it. No storage schema or budget decision changes.

**Tech Stack:** Rust host-core, TypeScript/Electron IPC, React/Zustand, Node tests, i18n.

**Spec:** `docs/superpowers/specs/2026-11-04-goal-live-progress-design.md`; behavior specs `docs/spec/04-ux/08-component-spec.md`, `docs/spec/04-ux/09-interaction-patterns.md`, `docs/spec/06-delivery/04-e2e-test-plan.md`.

## Global Constraints

- Host-core owns durable Goal state and token budget decisions.
- Provider-reported usage is the only token source; no estimated progress.
- Existing pause/resume, no-replay, cycle-budget, and current-round completion behavior stays unchanged.
- User-visible strings are localized; code and repository documentation remain English.
- Do not commit unless requested.

## Review Focus

1. A late usage event from a prior execution must not update a resumed Goal — test session/proposal/execution identity fencing.
2. Usage repeated as cumulative operation snapshots must not be counted twice — test against Main's existing `addUsage` aggregate.
3. A Host snapshot arriving after live progress must not make displayed tokens go backwards — test monotonic overlay behavior.
4. Paused or interrupted Goals must not keep accruing visible time — test active-only elapsed projection.
5. A Goal lifecycle event that changes execution identity must discard prior live progress — test state reconciliation.

---

### Task 1: Expose the authoritative Goal cycle start

**Files:** `crates/host-core/src/plans/goals.rs`, `crates/host-core/src/plans/tests.rs`, `packages/shared/src/types/plans.ts`

**Interfaces:** Add `cycle_started_at` to the Host response struct and `cycleStartedAt: number` to the shared lifecycle type. The persisted column already exists; do not migrate storage.

- [x] Add a Host test asserting that a newly approved Goal returns a positive `cycle_started_at` and that resume returns the new cycle start.
- [x] Run `cargo test -p host-core goal` and verify the test fails because the field is absent.
- [x] Select `cycle_started_at` in `GOAL_COLUMNS`, map it into `GoalLifecycle`, and add the shared field.
- [x] Run `cargo test -p host-core goal` and the shared type tests; expect green.

### Task 2: Deliver execution-scoped provider usage progress

**Files:** `packages/shared/src/types/plans.ts`, `packages/shared/src/protocol.ts`, `apps/desktop/electron/main/index.ts`, `apps/desktop/electron/main/runtime/plans.ts`, `apps/desktop/electron/main/runtime/event-persistence.ts`, `apps/desktop/src/lib/api.ts`, `apps/desktop/src/stores/app-state.ts`, `apps/desktop/src/stores/slices/events-slice.ts`, `apps/desktop/src/features/app/useAppShellRuntime.tsx`, and focused tests under `apps/desktop/test/`.

**Interfaces:** Add `GoalProgressEvent { sessionId, proposalId, executionId, turnId, tokensUsed }` and an allowlisted `IPC.event.goalProgress` listener. Capture the base `GoalLifecycle.tokensUsed` before `session.beginTurn`; emit `base + activeTurnUsages.totalTokens` only for the matching Goal execution. Keep transient progress separate from persisted lifecycle state.

- [x] Add regression tests for Main attribution and Renderer rejection of stale/mismatched events, plus monotonic progress.
- [x] Run those targeted tests and verify they fail for missing event/handler behavior.
- [x] Implement the additive IPC event, baseline capture, progress emission, store action, and event subscription. Clear overlays when the Goal becomes inactive or changes execution identity.
- [x] Run the targeted tests and protocol whitelist tests; expect green.

### Task 3: Make active display live and clarify status text

**Files:** `apps/desktop/src/components/GoalLifecycleBar.tsx`, `apps/desktop/src/features/chat/transcript/TurnProcess.tsx`, `apps/desktop/src/lib/goal-lifecycle-state.ts`, `crates/host-core/src/plans/goals.rs`, `crates/host-core/src/plans/tests.rs`, `packages/i18n/src/locales/*/index.ts`, and focused Goal/transcript tests.

- [x] Add tests for “第 N 个周期” copy, live token projection, active-only elapsed-time calculation, and “this run stopped” wording.
- [x] Persist the frozen elapsed snapshot when an active run is interrupted; verify the regression test fails before the Host fix and passes afterward.
- [x] Run the targeted tests and verify the existing copy/display fails the expected assertions.
- [x] Add a one-second timer only while active; use `cycleStartedAt` and the transient execution-matched token value; format elapsed down to seconds. Persist the frozen elapsed snapshot on manual pause and normal interruption without changing budget enforcement. Change all locale strings without changing the stopped turn classifier.
- [x] Run targeted Goal and turn-process tests plus locale validation; expect green.

### Task 4: Synchronize behavior specs and run required gates

**Files:** `docs/spec/04-ux/08-component-spec.md`, `docs/spec/04-ux/09-interaction-patterns.md`, `docs/spec/06-delivery/04-e2e-test-plan.md`.

- [x] Document the live provider-reported token overlay, active-only elapsed timer, execution identity fence, cycle copy, and unchanged Host enforcement.
- [x] Update Goal lifecycle and transcript stopped-row E2E acceptance text, including elapsed freeze on pause/interruption.
- [x] Run Goal lifecycle/render and turn-process tests, protocol/shared/i18n checks, Desktop typecheck/build, docs checks, `cargo fmt --check`, Host Core tests and Clippy.
- [x] Run the isolated Electron Plan UI path: 6 passed, 0 failed; it observed the elapsed tick and pause freeze. The optional live-provider case was skipped because test credentials were not configured.
- [x] Review the complete diff; keep the task-candidate branch based on `origin/main` and report any environment-only limitations.

## Candidate Validation (2026-11-04)

- Task candidate: `4c58538d6ecb` plus the Goal live-progress changes in this worktree.
- Base: `origin/main` at `3883265c2171`; direct `node scripts/check-pr-base-main.mjs` passed.
- Host Core: 1,148 passed, 0 failed, 1 ignored; targeted interruption regression passed after the fix.
- `cargo fmt --all -- --check` and `cargo clippy -p host-core --all-targets --locked` passed. Clippy retains one pre-existing `filter_next` warning in `transcripts.rs`.
- Shared: build and 1,348 tests passed. i18n: build and 31 tests passed. Desktop typecheck and Electron build passed.
- Docs: 87 English/Chinese pairs and 612 pages verified.
- Electron E2E: `scripts/e2e-plan-ui.mjs` passed 6/6 with 0 console diagnostics; optional live-provider acceptance was skipped.
- The `pnpm` wrapper cannot resolve its linked workspace executable in this worktree; equivalent changed-package TypeScript builds, typecheck, Electron build, tests, and the PR-base script were run directly.
