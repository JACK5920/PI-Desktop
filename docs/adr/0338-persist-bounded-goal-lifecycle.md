# ADR 0338: Persist a bounded, manually resumable Goal lifecycle

- Status: Accepted for implementation
- Date: 2026-11-02
- Deciders: PI-Desktop maintainers
- Related: ADR 0053 (Plan recovery and no replay), ADR 0211 (Plan/Goal
  contract modes), D189 (host-owned contract artifacts),
  `docs/spec/03-runtime/02-agent-runtime.md`
- Amends: D189 / ADR 0053 for approved Goal execution only; Plan behavior is
  unchanged

## Context

Goal already stores an immutable Markdown contract, asks for approval, and
executes once through the shared Plan/Goal dispatcher. That gives the Agent a
goal-shaped task but no durable progress view across execution turns. Restart
recovery is intentionally fail-closed: queued and running work is interrupted
and never replayed. A long Goal therefore needs a progress lifecycle without
turning that startup fence into automatic replay or mutating the approved
contract.

## Decision

1. **Keep the approval contract immutable.** Schema v28 adds Host-owned
   `goal_lifecycles` and `goal_runs` tables. Lifecycle status, per-run report,
   counters, and stop reason live there, not in the immutable proposal Markdown
   or approval identity. The newest non-cleared Goal is the one active tracking
   surface per session.
2. **Use one scoped report per execution round.** The approved Goal runtime
   exposes `GoalReport` only during that round. Its report includes an outcome,
   summary, and each reported criterion's status plus non-empty evidence
   references. Host validates shape, bounds, current execution, and running
   turn identity. Criterion/evidence truth is Agent-reported; Host does not
   claim it independently ran the cited checks.
3. **Bound automatic work.** A completed turn with a saved `continue` report
   may queue a fresh execution, up to eight execution rounds total per cycle,
   including the initial approved round. Each cycle also has persisted caps of
   250,000 reported tokens and 60 minutes of wall-clock time. The Host checks
   these counters when a round settles; it does not terminate an in-flight
   round at the cap, but it will not queue another automatic round after a cap
   is reached. Manual resume starts a fresh cycle and resets both counters. A
   missing report, blocked report, completed report, pause, or any cycle cap
   stops automatic dispatch. `complete` requires every reported criterion to
   be marked `met` with evidence.
4. **Resume is always explicit and fresh.** Pause, resume, and clear are
   Host-owned lifecycle actions. Resume from paused, blocked, or interrupted
   creates a new execution ID and cycle; it never reclaims an old run. Clear
   removes the lifecycle from active tracking but retains report/run history,
   the immutable contract, artifact, and audit entries.
5. **Preserve no-replay startup recovery.** On Host restart an active Goal and
   its queued/running run become `interrupted` with `host_restart`. The UI
   rehydrates that state and offers manual Resume; boot does not dispatch it.
   Existing approved v27 Goals migrate to interrupted review state because
   they have no criterion-level report. Protocol v11 remains additive; schema
   advances to v28.

## Consequences

- Users can inspect progress, pause a running Goal, resume after restart, or
  clear active tracking without losing the original approved contract.
- The dispatcher continues only after the previous turn settles, and each
  automatic continuation has a distinct execution identity.
- The displayed evidence is a structured Agent claim, not a cryptographically
  verified test result. The UI and specs must keep that distinction explicit.
- Plan approval and execution behavior, the Pi engine, permissions, and ADR
  0053's no-replay rule remain unchanged.
