# Goal live progress design

## Intent

Make an approved Goal's visible token count and elapsed time track its current
cycle while it is active, label cycles unambiguously, and clarify that a stopped
transcript row describes one historical run rather than the durable Goal.

## Goals and non-goals

- Use provider-reported usage only; do not estimate tokens.
- Refresh cycle elapsed time while active, then retain the Host snapshot when the
  Goal pauses, completes, blocks, or is interrupted.
- Attribute live usage only to the current Goal execution and reject stale
  execution events after a resume or continuation.
- Keep Host budget enforcement, persistence ownership, restart behavior, and the
  no-replay rule unchanged.
- No database migration, pricing display, token estimation, or behavior change to
  historical run status.

## Approaches

1. Poll Host for a full Goal snapshot on a timer. Rejected: adds repeated RPC and
   database work without improving the Host's usage persistence cadence.
2. Derive live usage from transcript rows in the Renderer. Rejected: duplicates
   usage aggregation and cannot reliably distinguish Goal executions from
   ordinary chat turns.
3. Reuse Main's existing active-turn usage aggregate, tag progress with the
   current Goal execution identity, and expose the already-persisted cycle start
   timestamp. Selected: keeps token accounting in Main/Host, makes the UI a
   display-only projection, and needs no storage change.

## Design

Host adds its existing `cycle_started_at` value to the additive Goal lifecycle
response. Main captures the lifecycle's persisted `tokensUsed` before each Goal
execution begins. On provider usage events, Main combines that baseline with
the existing deduplicated active-turn aggregate and emits an additive,
identity-scoped Goal progress event. The Renderer keeps this transient progress
separate from the authoritative lifecycle and accepts it only when session,
proposal, execution, and active state match. A lifecycle event for a different
execution clears the stale overlay.

The Goal bar refreshes its elapsed display once per second while status is
active, deriving it from the Host cycle start time; non-active states use the
Host's frozen elapsed snapshot. Cycle copy explicitly says “第 N 个周期” in
Chinese. Transcript process wording changes from a generic “已停止” to a phrase
meaning “this run stopped”; the underlying stopped classification is unchanged.

## Constraints and acceptance

- Protocol v11 and the database schema remain unchanged; the new event and
  lifecycle field are additive.
- Token updates use reported usage and the existing idempotent `addUsage`
  aggregation. No new budget checks or auto-resume paths are introduced.
- Tests cover Host cycle-start serialization, Goal progress identity fencing,
  live display projection, cycle wording, and the existing stopped-turn
  precedence. Goal lifecycle and transcript E2E documentation is updated.
