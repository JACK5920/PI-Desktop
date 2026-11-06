# Selection Reference Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transcript text selection and response annotations reliable across selection changes, streaming, narrow layouts, and after-send transcript review.

**Architecture:** Keep selection capture and annotation ownership in the renderer. Preserve the generated prompt envelope as the model-facing data contract, but render a separate expandable summary from the stored user message. Keep docked side-chat fork and promotion lifecycle unchanged in this task.

**Tech Stack:** React, TypeScript, CSS, i18n, Node test runner, existing Chromium E2E fixture.

**Spec:** ADR 0346; `docs/spec/04-ux/08-component-spec.md`; `docs/spec/04-ux/09-interaction-patterns.md`; `docs/spec/06-delivery/04-e2e-test-plan.md`.

## Global Constraints

- Preserve message/session ownership and `canEditMessages` permission checks.
- Never submit from selection, annotation, or disclosure actions.
- Keep the JSON annotation envelope unchanged and hide its raw machine format.
- Keep side-chat fork, promotion, close, and persistence behavior unchanged.
- Preserve existing untracked `.artifacts/` and `.isolated-launch-test-NryG1a/` data.

## Review Focus

- A changed selection must not be suppressed by stale toolbar dismissal state.
- A streaming selection may only capture text currently rendered under that same message owner.
- Narrow viewport and long localized labels must not clip editor actions or Composer references.
- Stored user prompts with valid annotation envelopes must show request text plus a separate disclosure, never raw envelope text.
- Malformed envelopes and ordinary prompts must retain their current visible text.

### Task 1: Selection lifecycle and streaming eligibility

**Files:** `TranscriptSelectionToolbar.tsx`, `AssistantTurnParts.tsx`, selection tests, E2E selection fixture.

- [x] Add regression coverage for changing an active selection and selecting a streaming answer's rendered text.
- [x] Run tests and confirm the selection-change regression fails for the current suppression rule.
- [x] Remove stale-selection suppression without losing captured-source behavior on toolbar interaction.
- [x] Permit selection on rendered streaming assistant prose while preserving session permission checks.
- [x] Run focused tests and Chromium selection workflow.

### Task 2: Annotation surface layout

**Files:** `messages.css`, `composer.css`, focused style/component tests and E2E workflow.

- [x] Add viewport geometry assertions in the Chromium fixture and narrow-layout CSS contract checks.
- [x] Add narrow-layout style contract tests for wrapping, spacing, and viewport-safe widths.
- [x] Make action rows wrap or reflow, constrain the annotation editor to the viewport, and provide consistent inset spacing.
- [x] Run focused UI/E2E checks.

### Task 3: Sent annotation summary

**Files:** `response-annotations.ts`, new transcript component, `MessageRow.tsx`, i18n locales, specs, tests.

- [x] Add tests for an expandable user-message reference summary derived from a valid stored envelope; verify invalid envelopes remain ordinary text.
- [x] Implement localized collapsed count and expanded excerpt/comment cards, keeping the request body free of envelope serialization.
- [x] Update ADR 0346 / component and interaction specs / E2E scenario.
- [x] Run focused unit, typecheck, and Chromium workflow validation.

### Task 4: Final review and validation

- [x] Review diff and verify side-chat lifecycle files remain untouched.
- [x] Run applicable UI unit tests, i18n checks, desktop typecheck, and the selection-reference Chromium E2E.
- [x] Record exact commands/results and environment limitations; do not commit or push unless separately requested.
