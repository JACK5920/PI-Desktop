# ADR 0344: Configure per-cycle Goal budgets

- Status: Accepted for implementation
- Date: 2026-11-04
- Deciders: PI-Desktop maintainers
- Related: ADR 0338 (persisted Goal lifecycle), ADR 0053 (no-replay recovery),
  D679 (Goal lifecycle)
- Amends: ADR 0338 budget limits only; its approval, explicit-resume, and
  no-replay decisions remain unchanged

## Context

The persisted Goal lifecycle currently uses fixed limits of eight execution
rounds, 250,000 reported tokens, and 60 minutes per cycle. A fixed token ceiling
can stop a long task even when the user wants it to continue, while removing
all limits would also remove useful safeguards. Users need to tune the limits
for the Goal without changing its immutable contract or disrupting a running
round.

## Decision

1. Keep defaults at eight rounds, 250,000 reported tokens, and 60 minutes.
   Allow 1–32 rounds, 1–1,440 minutes, and any positive safe-integer finite
   token cap through `Number.MAX_SAFE_INTEGER`.
2. Add an explicit unlimited-token mode per Goal cycle. Continue tracking
   reported token usage, but skip only the token cutoff while unlimited is
   selected. Round and elapsed-time limits still apply. Keep the last finite
   `max_tokens` value while unlimited is enabled; users may edit that retained
   value and recover it by switching back to finite mode.
3. Permit edits while the Goal is active, paused, blocked, or interrupted.
   Completed and cleared Goals are not editable. A successful edit updates the
   persisted limits only: it does not reset usage, start a cycle, change the
   execution identity, cancel a run, or replay work. Host checks new limits
   after the current round settles, so an in-flight round is allowed to finish.
4. Resume remains explicit and creates a new execution identity and cycle.
   It resets cycle counters but retains the currently configured budgets.
5. Keep host-core authoritative. Add `goals.budget.update` without changing
   protocol v11, and add schema v30's `token_budget_unlimited` flag with a
   default of `0`. The v29 migration preserves every finite saved token value
   and starts all existing Goals in finite mode.

## Consequences

- Users can tailor a Goal's bounded execution without changing the approved
  contract or needing to restart the current round.
- Unlimited mode is explicit, persisted, and limited to removing the token
  cutoff; usage display, round limits, time limits, and manual restart rules
  remain in force.
- Editing a limit below usage already accumulated does not interrupt current
  work; the next continuation decision observes the updated limits after the
  round settles.
- Existing data is upgraded additively with a v29 backup. Renderer validation
  improves feedback, but Host validation remains authoritative.
