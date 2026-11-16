# ADR 0355: Editable Goal objective and unified task control

- Status: Accepted
- Date: 2026-11-11
- Deciders: PI-Desktop maintainers
- Related: ADR 0338 (persisted Goal lifecycle), ADR 0354 (safe task pause)

## Context

The Goal lifecycle card had its own Pause and Resume buttons while ordinary
Agent chat used the Composer's bottom-right task control. This split made the
same task action appear in different locations and use different visual
language. Goal details also remained fixed to the original approval snapshot,
so users could not correct the objective during a long-running lifecycle.

## Decision

1. Ordinary local Agent tasks and Goal tasks use one bottom-right Composer
   Pause/Resume affordance. The renderer dispatches ordinary task pause/resume
   through its existing safe-turn mechanism and Goal pause/resume through the
   Host-owned Goal lifecycle API. Goal clear remains a separate explicit
   lifecycle action.
2. The immutable approved Goal proposal and artifact remain the audit snapshot.
   Schema v32 adds mutable `objective_title`, `objective_markdown`, and an
   optimistic `objective_revision` to the Host-owned Goal lifecycle. Updates
   are available while a Goal is active, paused, blocked, or interrupted.
3. Goal editing is presented as a right-side editor launched from the lifecycle
   card. The Host validates and persists each correction, rejects stale
   revisions, and does not stop or rewrite an execution already dispatched.
   The next automatic continuation or explicit resume captures the latest
   revision and supplies it to the Agent alongside the original contract.
4. A current execution's prompt stays immutable. The latest correction is
   identified as user intent and may refine or supersede the original task
   objective, but it cannot change tool permissions or system boundaries.

## Consequences

- Users can correct a Goal without losing its original approved snapshot or
  interrupting the current round.
- Every new Goal round can use the latest durable correction, including after
  application restart, because it is read from Host-owned lifecycle state at
  dispatch time.
- A stale editor cannot silently overwrite a newer correction.
- Ordinary chat and Goal share a visual task-control entry point while keeping
  their distinct interruption/recovery semantics.
