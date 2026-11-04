# ADR 0346: Restore selection references, annotations, and docked side chats

- Status: Accepted for implementation
- Date: 2026-11-04
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Amends: [ADR 0268](0268-remove-quotes-annotations-and-side-chats.md), [ADR 0342](0342-selected-text-follow-up-forks.md)
- Related: [04-ux/08-component-spec.md](../spec/04-ux/08-component-spec.md) ·
  [04-ux/09-interaction-patterns.md](../spec/04-ux/09-interaction-patterns.md) ·
  [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md)

## Context

ADR 0268 removed the transcript selection toolbar, response annotations, and
docked side chats. ADR 0342 restored only a narrow context-menu action that
creates an ordinary activated child session. The current capability is not
enough for a selection-centered review workflow: users cannot copy only a
captured excerpt through a selection action, attach a comment to an assistant
passage for the next request, follow an assistant citation back to that
passage, or ask beside the parent conversation without navigating away.

The renderer already has the required boundaries: `session.fork` creates a
normal durable child, `sendPrompt` accepts an explicit target session, the
WorkPanel retains per-session tabs, and permission/ask state is keyed by
session id. A new Host-owned side-chat entity or second execution path would
duplicate those contracts and would require persistent-state and protocol
migrations for drafts that have not been sent.

## Decision

1. Restore a small transcript-selection toolbar for eligible local writable
   conversations. Capture the source session, message, excerpt, and range
   before moving focus. Copy writes only that captured excerpt; selected user
   text can be appended as an editable quote to the current draft; selected
   assistant text can be attached as a numbered response annotation or used to
   open a docked side-chat draft. Keep the existing message Copy, context-menu
   Copy, Select message text, Fork, and **Ask about selection** behavior
   distinct.
2. Keep annotations renderer-owned and transient until an ordinary prompt is
   admitted. Serialize the pending excerpts, optional comments, and source
    message ids as JSON in a generated prompt section. Transcript, edit-seed,
    queue-preview, and title projections show only the user's request text; a
    sent user-message row separately offers a collapsed, expandable summary of
    the safe excerpt and optional comment, never the raw JSON envelope. An
    assistant may cite a pending annotation with the exact
   `:codex-annotation{index="N"}` directive; the citation opens a safe text-only
   excerpt/comment/source card. Unknown directives stay ordinary text.
3. Restore **Ask in side chat** as a docked WorkPanel tab. Opening it creates
   only renderer draft state. The first explicit non-empty Send forks the
   parent at the selected assistant message without activating the child, then
   uses the existing `sendPrompt` path for that child. The compact view uses
   the existing transcript, streaming, Stop, permission, and AskTool behavior
   for the child session.
   Selection quote and annotation actions inside the child transcript target
   that child's compact draft and review list. A nested docked side chat is not
   offered there; promote the child to an ordinary conversation first so its
   WorkPanel context is visible.
4. **Add to main chat** appends the latest side-chat answer to the parent's
   editable draft. **Open as a conversation** selects the ordinary child and
   releases only the side-chat projection. Closing an unsubmitted draft
   discards renderer state; closing a sent side chat releases its projection
   but does not stop or delete its ordinary durable child.
5. Preserve race and permission boundaries. Every asynchronous fork/send
   rechecks the parent identity, current tab registration, prompt/fork
   capability, and request generation. A completion cannot reopen a closed
   tab, switch the active parent, or overwrite a newer draft. Approvals remain
   Host-owned and resolve against the child session id; this feature adds no
   permission or automatic approval.
6. Excerpts created by the new toolbar are capped at 2,000 characters and are
   normalized without splitting a Unicode code point. Selection, copy,
   annotation, or opening a side-chat draft never sends. An annotation-only
   ordinary submission is not a valid prompt.
7. This decision supersedes ADR 0268 only for the renderer-owned selection,
   annotation, and side-chat removals above, and supersedes ADR 0342 only where
   it rejected the docked side chat. All retired decision and E2E identifiers
   remain retired. The ordinary **Ask about selection** activated-fork path
   remains available and independent.
8. No Host protocol, IPC/RPC contract, database schema, permission set, plugin
   contract, or data ownership boundary changes. Unsent annotation/editor/tab
   state is not restored after app restart; a successfully forked child remains
   an ordinary durable session.

## Consequences

- Users can keep the parent transcript and Composer in place while inspecting
  a cited excerpt or asking a follow-up in a child session.
- A child transcript can continue the selection/reference workflow within its
  compact draft. Nested docked side chats are intentionally deferred; promotion
  to a normal conversation is the supported transition before another docked
  follow-up.
- The renderer owns more short-lived state and must test selection capture,
  annotation acknowledgement, stale async completion, and child event routing.
- Closing a side-chat tab is not a destructive session action. A child created
  by an explicit send remains in the regular session list and retains existing
  notification and approval behavior.
- JSON prompt-envelope display reduction is required on every user-visible
  request projection; malformed envelopes remain visible as ordinary text.
- Protocol and storage compatibility remain unchanged. Existing retired E2E
  cases are not revived; the restored paths use new versioned identifiers.

## Alternatives considered

### Restore only the ordinary activated fork

Rejected: it preserves the existing narrow behavior but does not provide
captured selection actions, comment citations, or an in-place follow-up.

### Add persistent Host-owned annotation and side-chat records

Rejected: child sessions are already durable, while the requested unsent state
is transient. A parallel record model would add migrations and recovery rules
without a user requirement to persist drafts across restart.

### Restore the removed renderer flow over existing sessions

Accepted: this keeps session durability and permissions with their existing
owners, makes no external submission automatic, and supplies the requested UX
with the smallest compatible boundary change.
