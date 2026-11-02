# ADR 0339: Add an independent local Branch Review surface

- Status: Accepted
- Date: 2026-11-02
- Decision owners: PI-Desktop core
- Related: [ADR 0043](0043-message-owned-review-snapshots-and-rollback.md) ·
  [ADR 0308](0308-remove-pull-requests-destination.md) ·
  [IPC protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [WorkPanel component spec](../spec/04-ux/08-component-spec.md) ·
  [E2E-268](../spec/06-delivery/04-e2e-test-plan.md)

## Context

The existing Review surface is a chronological view of immutable, message-owned
Write/Edit evidence. It must not be repurposed to scan mutable Git state.
PI-Desktop also has no GitHub Pull Requests destination, and this change does
not restore one.

Users still need an in-product way to compare a local branch with a selected
base and leave review feedback in the conversation that owns the work.

## Decision

1. Add a separate host-owned **Branch Review** work-panel tool. It compares
   the selected local or remote-tracking ref's merge base with the current
   branch's working tree, including staged, unstaged, committed branch changes,
   and untracked files. The tool does not fetch refs; users refresh them through
   their existing Git workflow.
2. Extend `workspace/diff` with optional `baseRef` and `includeBases` request
   fields. The Host returns available base refs, the current branch, merge-base
   identity, hunk line numbers, and a per-file anchor revision. Existing calls
   without these fields keep their current `HEAD`-to-working-tree behavior.
3. A line-feedback action re-reads the selected base and file diff. It appends
   feedback only when the selected base and file anchor still match; stale
   anchors require the user to choose again.
4. Feedback is appended to the matching session's Composer draft without
   replacing its selection. The user may edit or remove it. Branch Review
   never sends a turn, posts an external comment, or modifies Git state.
5. The existing Review history remains unchanged and continues to derive only
   from persisted message-owned `details.review` records.

## Consequences

- Branch-level and message-level review have distinct sources of truth and UI.
- A commit does not erase the Branch Review diff, while a changed file or
  branch identity invalidates feedback anchors.
- Branch Review works offline with locally available refs and does not need
  GitHub authentication or a network connection.
- A stale ref remains stale until the user refreshes it; the UI never performs
  an implicit fetch.

## Alternatives rejected

- **Make the existing Review tab scan Git:** rejected by ADR 0043 because it
  would replace durable message evidence with a mutable repository snapshot.
- **Restore the Pull Requests destination:** out of scope under ADR 0308 and
  would require separate GitHub permissions, authentication, and write gates.
- **Send feedback automatically:** rejected because feedback must remain
  editable and explicit user input must be the only way to submit a turn.
