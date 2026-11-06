# Selection Reference Hover UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep selection actions out of the way during dragging and make annotation references discoverable through source-position, Composer, and citation previews.

**Architecture:** Keep state and rendering in the desktop renderer. Add optional, backward-compatible anchor offsets to existing annotation JSON; resolve them against eligible rendered transcript text and fall back to a message-level marker when resolution is not exact. Reuse existing text-only annotation data and management actions.

**Tech Stack:** React, TypeScript, CSS, Node test runner, existing isolated Chromium E2E fixture.

**Spec:** `docs/superpowers/specs/2026-11-06-selection-reference-hover-and-anchors-design.md`

## Global Constraints

- No Host, database, IPC/RPC, permission, or remote-session changes.
- Existing version-1 annotation payloads and prompt projections remain compatible.
- Preview actions never send, approve, or consume reference state.
- All user-visible previews render untrusted excerpt/comment text as plain text.
- Keep the current Composer review/edit/remove/clear flow and sent-message summary.

## Review Focus

- Pointer drag must not show a moving toolbar; capture only the final selected range.
- Keyboard selection and rapid selection changes must not flicker or retain stale source data.
- UTF-16 offsets must map correctly through formatted text, Unicode, and formula-aware selection; stale/ambiguous offsets must fall back rather than mis-anchor.
- Hover and focus movement into a popover must not immediately dismiss it; Escape/outside click must dismiss and restore usable focus.
- Legacy annotation payloads and hostile excerpt/comment text must remain backward-compatible and inert.

---

### Task 1: Define compatible annotation anchors and source-text mapping

**Files:**
- Modify: `apps/desktop/src/lib/transcript-selection.ts`
- Modify: `apps/desktop/src/lib/response-annotations.ts`
- Test: `apps/desktop/test/transcript-selection.test.mjs`
- Test: `apps/desktop/test/response-annotations.test.mjs`

**Interfaces:**
- Add optional `anchorStart?: number` and `anchorEnd?: number` to the annotation types.
- Add a pure helper that resolves a half-open UTF-16 interval in eligible rendered message text and validates it against the excerpt; return `null` for invalid or stale anchors.
- Parse and serialize optional offsets while continuing to accept existing payloads without them.

- [x] Write tests for round-trip offsets, legacy no-offset payloads, Unicode UTF-16 positions, invalid ranges, and excerpt mismatch.
- [x] Run the targeted Node tests; baseline covered existing compatibility, and a new source-lookup test was observed failing before its helper was implemented.
- [x] Implement the minimal helper and optional envelope fields without changing the user request or quoted excerpt/comment contract.
- [x] Run targeted tests and confirm both new and existing annotation tests pass.

### Task 2: Show the toolbar only after a stable selection

**Files:**
- Modify: `apps/desktop/src/features/chat/transcript/TranscriptSelectionToolbar.tsx`
- Modify: `apps/desktop/src/lib/transcript-selection.ts`
- Modify: `apps/desktop/src/stores/app-state.ts`
- Modify: `apps/desktop/src/stores/slices/annotation-slice.ts`
- Test: `apps/desktop/test/transcript-selection.test.mjs`
- Test: `apps/desktop/test/response-annotation-slice.test.mjs`
- Test: `scripts/e2e-selection-reference-workflow.mjs`

**Interfaces:**
- Extend captured `TranscriptSelection` with optional anchor offsets, computed from the owning rendered message's eligible text nodes.
- Extend `addResponseAnnotation(sessionId, sourceMessageId, excerpt, anchor?)` with an optional `{ anchorStart: number; anchorEnd: number }`; existing callers may omit it.
- Keep one stable captured source while the comment editor is open.

- [x] Add deterministic coverage for pointer-down suppression, pointer-up capture, collapsed selection, inline-format anchors, and stored optional offsets; keyboard changes use a stable debounce.
- [x] Run the isolated Chromium workflow and verify no toolbar is rendered during a pointer gesture, then capture on release. A pre-change visual repro was unavailable in this continuation because the task branch already contained the earlier gesture implementation.
- [x] Implement gesture tracking: hide during pointer drag; capture on pointer release after selection settles; debounce keyboard-only updates; do not reposition from live pointer selection changes.
- [x] Save computed anchors into annotations and verify comment actions retain the original captured excerpt after selection changes.
- [x] Run targeted selection tests and the Chromium selection workflow.

### Task 3: Render annotations at their source messages

**Files:**
- Create: `apps/desktop/src/features/chat/transcript/SourceAnnotationMarkers.tsx`
- Modify: `apps/desktop/src/features/chat/transcript/MessageRow.tsx`
- Modify: `apps/desktop/src/features/chat/transcript/AnnotationCitation.tsx` (share safe preview pattern where appropriate)
- Modify: `apps/desktop/src/styles/messages.css`
- Modify: `packages/i18n/src/locales/*/index.ts` only if new localized copy is needed
- Test: `apps/desktop/test/response-annotation-citations.test.mjs`
- Test: `scripts/e2e-selection-reference-workflow.mjs`

**Interfaces:**
- Add a pure lookup over user prompt envelopes to collect annotations in the current transcript whose `sourceMessageId` equals this assistant message.
- Render anchored markers only when the source range resolves exactly; group unresolved/legacy annotations in a message-level rail.
- Reuse the existing accessible, text-only preview data contract; no change to `AnnotationCitation.tsx` until Task 4.

- [x] Add coverage for exact source anchoring, multiple references, missing/legacy and stale offset fallback, and safe text rendering.
- [x] Add isolated Chromium checks for anchored and stale source markers; the baseline source row has no marker before an annotation is attached.
- [x] Implement marker rendering and minimal styling without altering Markdown text or user message summaries.
- [x] Run citation tests, style-token checks, and the isolated Chromium scenario.

### Task 4: Add Composer and citation hover/focus previews

**Files:**
- Modify: `apps/desktop/src/features/chat/composer/ComposerAnnotationAttachments.tsx`
- Modify: `apps/desktop/src/features/chat/transcript/AnnotationCitation.tsx`
- Modify: `apps/desktop/src/styles/composer.css`
- Modify: `apps/desktop/src/styles/messages.css`
- Modify: `packages/i18n/src/locales/*/index.ts` only if new localized copy is needed
- Test: `apps/desktop/test/response-annotation-citations.test.mjs`
- Test: `scripts/e2e-selection-reference-workflow.mjs`

**Interfaces:**
- Composer control shows count plus a bounded excerpt; hover/focus exposes a preview list and click retains the existing management panel.
- Assistant citation opens its safe preview on hover/focus/click and retains outside/Escape dismissal.

- [x] Add tests for hover, keyboard focus, pointer movement into preview, click-to-manage, Escape, and visible bounds for existing review/editor cards.
- [x] Extend the Chromium fixture to verify reference previews open without a click.
- [x] Implement preview behavior and styling while keeping existing edit/remove/clear actions unchanged.
- [x] Run targeted renderer/E2E tests and keyboard focus/dismissal checks.

### Task 5: Update product specifications and validate the complete path

**Files:**
- Modify: `docs/adr/0346-selection-references-annotations-and-docked-side-chats.md`
- Modify: `docs/spec/04-ux/08-component-spec.md`
- Modify: `docs/spec/04-ux/09-interaction-patterns.md`
- Modify: `docs/spec/06-delivery/04-e2e-test-plan.md`
- Modify: `scripts/e2e-selection-reference-workflow.mjs` and its fixture as needed

- [x] Document stable selection timing, optional anchor-offset compatibility, exact-location and fallback semantics, and hover/focus preview behavior.
- [x] Extend the E2E scenario for final selection capture, source-message preview, Composer preview, citation preview, and stale/legacy fallback.
- [x] Run targeted Node tests, the isolated Chromium scenario, desktop typecheck, style-token gate, and diff checks. Desktop packaging build was attempted but is blocked by a pre-existing shared dependency/config issue described in delivery; it is not reported as passing.
- [x] Review the diff for prompt-envelope compatibility, no-auto-send, accessibility, safe text rendering, and no Markdown/source mutation.
