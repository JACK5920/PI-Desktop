# Design: Settled selection actions and inline reference previews

**Status:** Approved for implementation planning
**Date:** 2026-11-06
**Scope:** PI-Desktop desktop renderer, local writable conversations

## Intent

Make transcript references easier to capture and revisit: selection actions
must not obstruct a drag gesture, annotations should be discoverable at their
source passage, and pending references should preview without opening a review
editor. Keep the existing annotation prompt contract, user control, and safe
text-only rendering.

## Current behavior

- `TranscriptSelectionToolbar` reacts directly to document `selectionchange`,
  so its floating toolbar can follow the pointer while a user is still dragging.
- Pending Composer annotations are represented by a count chip. Clicking it
  opens the editable review list; hover does not preview the selected text.
- Assistant citation markers open their excerpt/comment/source card on click.
- Sent user prompts show their own expandable reference summary, but the
  assistant source message has no marker at the referenced passage.
- `ResponseAnnotation` currently carries the source message id, excerpt, and
  optional comment. The JSON envelope is renderer-owned and has no database,
  IPC, or Host schema.

## Goals

1. Do not show or reposition the selection toolbar during pointer dragging.
   Capture on pointer release; keyboard selection appears only after its range
   remains stable briefly. Keep the captured source immutable while an editor
   is open.
2. Store optional source-text offsets with newly captured annotations, using
   UTF-16 offsets across eligible rendered text nodes in the source message.
   Keep existing version-1 annotation payloads valid. Never guess a location:
   use offsets only when the range still corresponds to the same excerpt; for
   legacy, missing, stale, or ambiguous anchors, show a source-message-level
   marker instead.
3. Show an accessible marker at a resolvable source passage. Hover, keyboard
   focus, or activation opens a safe text-only preview with excerpt, comment,
   and source context. Do not rewrite Markdown source or prompt text to insert
   highlights.
4. Give pending Composer annotations a compact excerpt-bearing summary. Hover
   or keyboard focus previews the pending references; click remains the explicit
   entry to the existing edit/remove/clear review workflow.
5. Make assistant citation cards open on hover/focus as well as click, with
   dismissal and keyboard behavior that remains usable for pointer and keyboard
   users.
6. Preserve all send, queue, retry, permissions, and session behavior. No
   reference or preview action submits a prompt.

## Non-goals and boundaries

- No changes to Host, SQLite, IPC/RPC, permissions, or remote sessions.
- No migration. Missing anchor offsets in existing prompt envelopes remain
  supported as legacy references.
- Do not alter or remove the sent user-message summary, ordinary fork flow, or
  annotation serialization rules. The reference preview is supplemental.
- Do not add text rewriting, arbitrary HTML, or untrusted links to previews.
- No general Composer redesign beyond the reference summary and preview.

## Interaction and data contract

### Selection menu

- Pointer down within the eligible transcript records a gesture-in-progress and
  hides the toolbar. On pointer up, wait for the browser selection to settle,
  capture the excerpt, source identity, anchor offsets, and geometry, then show
  one toolbar. A collapsed/invalid selection shows none.
- Keyboard-driven selection uses a short stability debounce. Scroll/resize may
  reposition only a still-valid captured range; the toolbar never tracks the
  pointer during a drag.
- Outside press, Escape, selection collapse/change, or session change keeps the
  existing dismissal behavior. Comment editing retains its original captured
  source.

### Source annotation marker

- Add optional `anchorStart` and `anchorEnd` integer fields to the existing
  response-annotation payload. They are half-open UTF-16 offsets in the
  eligible rendered text stream of `sourceMessageId`; they do not replace the
  exact excerpt. They are optional metadata in the existing JSON envelope; the
  user request, quoted excerpt/comment, and citation numbering remain the
  model-visible content contract.
- Reconstruct an anchor only when offsets are valid and the corresponding text
  still agrees with the captured excerpt (including the existing formula-aware
  selection normalization rules). If unavailable or ambiguous, show a marker
  in the source message's annotation rail instead of attaching it to guessed
  text.
- Markers identify the annotation number, are keyboard accessible, and expose
  excerpt/comment/source in a text-only popover on hover, focus, or activation.
  Multiple annotations at the same message/range are grouped without losing
  their individual previews.

### Composer and citation previews

- The Composer reference control shows the annotation count and a bounded
  excerpt preview. Hover/focus opens a dismissible preview list; click opens
  the current full editor/review list. All excerpts/comments remain ordinary
  text. Previewing never changes or consumes attachment state.
- Assistant citation references open the same preview on hover and keyboard
  focus while retaining click-to-toggle and Escape/outside dismissal.
- Preview cards must remain within the viewport; pointer entry into the card
  must keep it open long enough to interact, and focus may move from trigger to
  card without dismissing it.

## Acceptance criteria

- During pointer drag, no selection toolbar overlays the transcript. On pointer
  release, the correct stable selection is captured and the toolbar appears.
- Keyboard selection, cross-line selection, ranges across formatted text,
  and formula selection do not lose or misplace the source. Ineligible,
  cross-message, stale, or unresolvable ranges fall back safely or show no
  action; they never attach to similar but unrelated text.
- Newly sent annotations render at their source excerpt when offsets resolve;
  old annotations and stale offsets display at message level.
- Composer reference previews appear on hover/focus, while click still opens
  management. Citation previews appear on hover/focus/click and remain safe
  text-only.
- Existing annotation JSON display reduction, provider-visible content,
  queue/retry behavior, and no-auto-send behavior remain unchanged.
- Unit and isolated Chromium user-path tests cover all new behavior, including
  fallback and dismissal cases.
