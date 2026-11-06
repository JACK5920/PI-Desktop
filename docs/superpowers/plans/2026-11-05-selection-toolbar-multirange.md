# Selection Toolbar Multi-Range Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make selectable assistant text available during an active reply and show the selection toolbar for same-session, same-role ranges spanning multiple transcript messages, while preserving every source message id.

**Architecture:** Keep selection and annotation ownership renderer-side. Extend the captured selection with ordered source message ids while retaining the first source id as the existing primary fork/citation anchor. Carry the optional source-id list through annotations and side-chat projection metadata, preserve legacy one-source payloads, and reject cross-session, mixed-role, or ineligible source ranges. Remove the active-turn-only exclusion for visible assistant message text; existing session permission checks remain authoritative.

**Tech Stack:** TypeScript, React, Node test runner, isolated Chromium selection-reference E2E.

**Spec:** `docs/adr/0346-selection-references-annotations-and-docked-side-chats.md`; `docs/spec/06-delivery/04-e2e-test-plan.md` selection-reference workflow.

## Global Constraints

- Do not change Host, IPC/RPC, database, or permission contracts.
- Preserve the existing `sourceMessageId` primary field and accept legacy annotation envelopes without a source-id list.
- A multi-message range is accepted only when all participating selectable owners belong to the same session and role and pass current eligibility checks.
- Selection actions never send; side-chat fork continues to use the first source message as its stable fork anchor.

## Review Focus

- Active assistant text in a running turn remains selectable even when its individual message status is no longer exactly `streaming`.
- Same-role cross-message selections show the toolbar and retain ordered source ids.
- Cross-session, mixed-role, and ineligible ranges stay rejected.
- Multi-source annotation metadata survives prompt serialization, parse/edit/retry, queue snapshots, and citation display.
- Single-source annotations and existing side-chat behavior remain byte-compatible where optional source ids are absent.

## Task 1: Selection capture and eligibility

**Files:**
- Modify: `apps/desktop/src/lib/transcript-selection.ts`
- Modify: `apps/desktop/src/features/chat/transcript/AssistantTurnParts.tsx`
- Test: `apps/desktop/test/transcript-selection.test.mjs`
- Test: new assistant-selection eligibility unit test
- Update: `scripts/e2e/selection-reference-workflow.tsx`

- [x] Add failing tests for active non-streaming assistant fragments and same-session multi-message capture.
- [x] Resolve every owner intersecting the DOM range in document order; require same session/role and eligibility; retain the first as `messageId` and expose the complete ordered `messageIds` list.
- [x] Make visible assistant fragments selectable in writable sessions regardless of active-turn/message-status mismatch, without changing `sessionAllows` checks.
- [x] Add E2E coverage for cross-message selection and derive the fixture eligibility from the production predicate instead of hardcoding `true`.

## Task 2: Carry complete source metadata

**Files:**
- Modify: `apps/desktop/src/lib/response-annotations.ts`
- Modify: `apps/desktop/src/stores/app-state.ts`
- Modify: `apps/desktop/src/stores/slices/annotation-slice.ts`
- Modify: `apps/desktop/src/stores/slices/queue-slice.ts`
- Modify: `apps/desktop/src/features/chat/transcript/TranscriptSelectionToolbar.tsx`
- Modify: `apps/desktop/src/features/chat/transcript/AnnotationCitation.tsx`
- Modify: `apps/desktop/src/stores/slices/side-chat-slice.ts`
- Test: annotation serialization/store/queue/citation tests

- [x] Add failing tests proving optional ordered source ids round-trip through annotation normalization, serialization, queue merge, and citation display while legacy payloads remain valid.
- [x] Store the captured source ids on annotations; validate every id resolves to an eligible assistant message in the same session.
- [x] Render all retained source ids in the annotation citation details; keep the existing primary source excerpt lookup.
- [x] Carry all source ids in the transient side-chat state while keeping the first source id as the fork anchor.

## Task 3: Specs and gates

**Files:**
- Modify: `docs/adr/0346-selection-references-annotations-and-docked-side-chats.md`
- Modify: `docs/spec/06-delivery/04-e2e-test-plan.md`

- [x] Amend the accepted selection contract to include eligible same-session same-role multi-message ranges and ordered source attribution.
- [x] Update the E2E acceptance to distinguish real component eligibility from a synthetic pre-eligible toolbar fixture.
- [x] Run focused Node tests, selection-reference E2E, affected typechecks, docs check, PR-base check, and `git diff --check`.
- [x] Review the full diff before commit/push/PR integration.
