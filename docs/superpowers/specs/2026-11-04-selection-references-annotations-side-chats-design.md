# Design: Selection references, annotations, and docked side chats

**Status:** Approved for implementation planning

**Date:** 2026-11-04

**Scope:** PI-Desktop desktop renderer, local writable conversations

## Intent

Give users a direct, reviewable way to reuse a selected passage from a
conversation, attach a comment to an assistant passage for the next prompt,
and ask a follow-up without replacing the conversation they are reading. The
flow should feel like one selection-centered capability rather than a set of
unrelated context-menu commands. The user's text and assistant-authored text
must remain distinguishable, and nothing sends merely because a passage was
selected, annotated, or placed in a side-chat draft.

## Current behavior and constraints

- `AssistantTurn` exposes **Ask about selection** only from the assistant
  context menu. It calls the existing `forkAssistantMessage` action, which
  forks at the assistant response, activates the child only while its
  navigation intent is current, and places a localized quote in the child's
  editable Composer without sending.
- There is no floating selection toolbar, annotation editor/attachment, model
  citation marker, or side-chat transcript tab. The current WorkPanel tab
  union has no side-chat resource.
- The WorkPanel context is already retained per session. `session.fork` can
  produce a durable child without activating it, `sendPrompt` can target an
  explicit session id, and the event/store path can retain a background
  transcript and route permission/ask requests by session id. These are the
  preferred seams; renderer code must not add SQLite or move agent execution.
- ADR 0268 removed quotes, annotations, and side chats. ADR 0342 later added
  the narrow `Ask about selection` fork flow and explicitly rejected restoring
  the larger surfaces. This proposal reverses those renderer-only decisions
  only where required by the requested feature. It does not revive retired
  decision or E2E identifiers.
- Existing copy affordances have distinct effects: the message-row Copy button
  writes a complete message to the clipboard; context-menu Copy uses an owned
  text selection if present and otherwise copies the full message; Select
  message text creates a native text selection but does not write the
  clipboard. The new selection toolbar's Copy action will copy only its
  captured excerpt. Keep these distinctions explicit rather than making any
  selection or annotation action auto-send.
- The remote WorkPanel is a different remote workspace surface, and remote
  sessions do not grant `canEditMessages` through the current capability gate.
  This proposal therefore does not add selection forking or side chats to
  remote sessions.

## Goals

1. Selecting text in a completed, writable local transcript row opens a small
   toolbar anchored to the selection. It offers only actions valid for that
   row and state.
2. Copy copies the exact selected excerpt. Adding selected user text to chat
   appends a localized, editable blockquote to the active session draft.
3. Adding selected assistant text opens a compact optional-comment editor.
   Save attaches an ordered, numbered annotation to the next ordinary prompt;
   edit/remove/clear remain available from the composer attachment review.
4. Annotation content reaches the model as structured, safely serialized
   prompt text. An assistant can cite an annotation by emitting
   `:codex-annotation{index="N"}`; the renderer shows a safe numbered marker
   that opens the cited excerpt/comment/source card.
5. **Ask in side chat** opens a docked WorkPanel tab while leaving the parent
   session, transcript, scroll position, and Composer in place. The selected
   excerpt is a draft-only quoted context. The side chat reuses the existing
   session fork, prompt, stop, event, approval, and ask handling.
6. A side-chat result can be quoted into the parent's editable Composer,
   opened as an ordinary conversation, or closed. No action sends to the
   parent automatically.
7. Preserve existing Fork and ordinary Ask-about-selection behavior unless a
   separate decision explicitly replaces it. Keep Host permission checks and
   ensure a stale async fork cannot reopen a closed panel or retarget a draft.

## Non-goals

- No Host protocol, IPC/RPC, database schema, plugin contract, or permission
  expansion; no new Host-side side-chat entity.
- No persistence of unsent annotations, annotation editor state, side-chat
  registrations, or side-chat drafts across application restart. A child
  session created by a successful first send is an ordinary durable session.
- No remote-session side chats in this iteration.
- A docked side-chat transcript supports selection copy, quote-to-its-compact
  draft, and annotation review for its ordinary child session. Starting another
  docked side chat from inside an already docked child is not supported; promote
  that child to a normal conversation first so the new WorkPanel context is
  visible and unambiguous.
- No automatic prompt submission, automatic approval, or permission-mode
  changes.
- No whole-answer rewriting, source-text mutation, or application-generated
  highlight inserted into Markdown. Source citations are model-authored
  numbered references whose popover shows the saved excerpt and comment.
- No requirement to reproduce every normal Composer feature in the compact
  side-chat input (for example, file attachments, slash commands, or voice).
  The core side-chat path is text, Send/Stop, transcript, and existing
  permission/ask interactions.

## Approaches considered

### A. Selection-centered renderer flow over existing sessions (recommended)

Add a selection toolbar and transient annotation/comment state in the renderer;
use the existing WorkPanel with a side-chat tab; create a normal child session
only when the user first sends a non-empty side-chat prompt. Reuse
`session.fork`, `sendPrompt(childId)`, the background transcript cache, and
existing per-session permission/ask records. Keep the Host and persisted
contracts unchanged.

**Trade-off:** The renderer must own and rigorously test a bounded lifecycle
for draft tabs, fork-in-flight state, annotation attachments, and background
event projection. Closing a created side-chat tab does not delete its durable
child.

### B. Keep the ordinary activated fork and add quote-to-draft only

This is the smallest change and preserves the existing `Ask about selection`
path, but still switches away from the parent and cannot provide comments,
numbered citations, or a docked independent conversation. It does not meet the
requested full side-chat behavior.

### C. Add Host-persisted side-chat and annotation objects

Store side-chat relationships, comments, anchors, and draft state as Host-owned
records and add RPC/storage contracts.

**Trade-off:** This would create a second durable conversation model for a
child session that is already durable, add migrations and protocol ownership,
and persist drafts the user has not sent. No current requirement justifies
that compatibility and recovery cost.

**Recommendation:** Choose A. It meets the user's requested behavior while
keeping durable conversation state in the existing session contract and
permissions in the existing Host path.

## Proposed interaction and state contract

### Selection toolbar and copy behavior

- Capture the excerpt and source session/message before focusing an action;
  do not read a potentially collapsed browser selection later. Cap excerpts
  submitted through the new toolbar at 2,000 characters and keep the captured
  excerpt consistent across the toolbar, prompt attachment, and side-chat
  draft. The existing activated-fork action keeps its current excerpt behavior.
- Show **Copy** for a non-empty selection. Show **Add to chat** for promptable
  source rows. For user rows it appends a blockquote and source attribution to
  the active session draft. For a completed assistant turn it opens the
  annotation comment editor. Show **Ask in side chat** only for a completed
  assistant turn that the current session is allowed to fork and prompt.
- Dismiss on Escape, outside press, selection collapse/change, or loss of the
  owning session. Reposition on scroll/resize while the exact selection is
  still valid. Keyboard activation and focus return must be supported.
- Keep message-row Copy, context-menu Copy, and Select message text semantics
  as stated above. Preserve the existing context-menu Ask about selection as
  an ordinary activated fork; it is intentionally distinct from Ask in side
  chat. If review finds the duplicated entry points confusing, make the labels
  and help text distinguish destination (new conversation versus docked side
  chat), rather than silently changing existing fork behavior.

### Annotations

- An annotation is renderer-owned, session-scoped state with a stable id,
  source assistant message id, excerpt, optional comment, and creation order.
  Its number is its order in the current pending attachment list. Reopening an
  identical source-message/excerpt reopens its comment editor rather than
  creating a duplicate. It is not added to the assistant's displayed source
  text.
- The compact comment editor snapshots the selection before focus changes.
  Save attaches the excerpt even with an empty comment; Cancel/Escape discards
  it without sending. Edits affect only the matching still-pending annotation;
  session changes close the editor. The composer attachment opens a list with
  edit/remove controls and clear-all.
- On ordinary Send or queue acceptance, serialize pending annotations as one
  `# Response annotations:` section with an explicit instruction and a JSON
  `<response-annotations>` payload containing excerpt, optional comment, and
  source message id, followed by `## My request:` and the user's draft. Use
  JSON serialization, not string interpolation, for excerpt/comment content.
  Strip the generated section from transcript display, edit seeds, queue
  previews, and titles. Consume only the exact unchanged attachments after
  Host admission/queue acknowledgement; rejected submissions keep them.
- Steering, retry, and a response that contains no pending annotations retain
  their current semantics. An annotation-only Send is not allowed; the user
  must provide request text. An annotation does not count as a prompt by
  itself.
- Render only the explicit model-authored annotation citation directive as a
  safe inline numbered reference. Clicking/activating it opens a localized
  popover containing the excerpt, optional comment, and source message context.
  Unknown/out-of-range numbers remain ordinary text. Sanitization must not
  allow the directive to create arbitrary links or HTML.

### Docked side chat

- Opening Ask in side chat creates a transient draft tab in the parent's
  retained WorkPanel context, prefilled with the selected excerpt as editable
  quoted context. It does not create a child session or send a prompt.
- On the first explicit Send with non-empty text, fork the parent at the
  selected assistant message without activating the child; then submit through
  `sendPrompt` with the child's session id. De-duplicate concurrent first
  sends. Once the fork succeeds, retain the child if the provider rejects the
  prompt so the user can retry without making another child. Later turns target
  the same child. Re-check session identity, prompt/fork permissions, current
  tab registration, and request generation after each await.
- Render the child transcript from its retained/cached messages and live
  session-scoped events. Render the existing permission and ask cards for that
  child session id. The compact input has text, Send, and Stop; no data is
  submitted without user activation. Approval resolution must still go
  through existing Host-owned controls.
- Within the child transcript, selected user text appends to the compact child
  draft and assistant annotations remain reviewable before the next send.
  Nested Ask in side chat is omitted; promote the child first to create a new
  visible WorkPanel context. While docked, hide history edit/delete/revision
  and assistant regenerate/fork actions because those host operations target
  the active session. A child error's Continue action must pass the child
  session id explicitly; never route it to the still-active parent.
- **Add to main chat** appends the latest child assistant response as a
  blockquote in the parent's Composer. **Open as a conversation** uses the
  regular session-selection path and releases only the side-chat projection.
  Closing an unsubmitted draft discards only renderer state. Closing a created
  side chat releases the tab/projection but keeps its ordinary child session;
  it does not silently delete or stop an already-sent task.
- A fork/send already explicitly requested is not undone if the user closes
  the tab or switches sessions while it is pending. Its completion must not
  reactivate the tab or overwrite any newer parent/child draft. A created child
  remains visible in the session list. Existing background notifications and
  approvals remain responsible for attention when its parent panel is hidden.

## Constraints and acceptance

- Preserve Host ownership, `session.fork`, the current permission capability
  checks, per-session WorkPanel contexts, and normal session title/list/delete
  behavior.
- No database migration, protocol bump, new IPC/RPC, new permission, or
  permission-mode mutation.
- Update a new ADR that amends ADR 0268 and ADR 0342; update the component and
  interaction specs, the E2E test plan and traceability table, and all shipped
  locale strings.
- Use new E2E identifiers; all identifiers retired in ADR 0268 stay retired.
- Required user-path coverage includes selection toolbar behavior, exact
  excerpt capture/copy, comment attach/edit/remove, prompt serialization and
  display reduction, answer citation references, first-send side-chat fork and
  streaming while the parent stays selected, existing permission/ask
  interaction, Add to main chat, promote to ordinary session, close semantics,
  cancellation/error, stale navigation/tab races, and draft preservation.
- The task candidate must pass focused desktop tests, desktop typecheck,
  relevant renderer E2E, policy/spec consistency, and the repository's
  applicable full validation gates before integration.

## Left to the builder

- Place selection-toolbar/comment/annotation state behind focused feature
  modules and keep `app-store.ts`, `session-slice.ts`, `ChatTranscript.tsx`,
  and `Composer.tsx` from growing into new ownership hotspots.
- Decide the smallest stable way to retain an excerpt's source message context
  for the citation popover without adding a persisted anchor format.
- Reuse the repo's existing selection math/clipboard serialization, shared UI
  primitives, context-menu/portal patterns, and all locale conventions.
- Choose the narrowest component/store/E2E test seams that exercise the real
  user path. Do not claim an Electron/manual GUI run unless it actually ran.
