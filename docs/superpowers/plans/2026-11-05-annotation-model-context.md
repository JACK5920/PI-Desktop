# Annotation Model Context Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with the repository's test and verification workflow.

**Goal:** Ensure a selected excerpt attached to a user message is explicit and usable in the final model-facing prompt, including when the request text is short.

**Architecture:** Preserve the current renderer-owned JSON annotation envelope and transcript disclosure. Clarify its model-facing instructions and prove that the exact envelope passes through AgentRuntime to the provider message context; do not add a new IPC/RPC field or persistence model.

**Tech Stack:** TypeScript, Node test runner, Vitest, existing selection-reference workflow.

**Spec:** `docs/adr/0346-selection-references-annotations-and-docked-side-chats.md`; `docs/spec/06-delivery/04-e2e-test-plan.md` E2E-CHAT-annotation-citation-flow-v2.

## Global Constraints

- Keep excerpts/comments as untrusted quoted data; never treat their contents as instructions.
- Preserve the submitted request text and current annotation envelope/display behavior.
- Do not modify database, IPC/RPC, permissions, provider credentials, or user data.
- Keep source changes on this dedicated worktree and test with the existing dependency environment.

## Review Focus

- A request containing only punctuation still carries the attached excerpt to the model-facing user message.
- Quotes/comments containing newlines, JSON syntax, or prompt-like text remain bounded quoted data.
- Requests without annotations remain byte-for-byte unchanged.
- Transcript/edit/queue display projections continue to hide the generated envelope and show the separate quote summary.

## Task 1: Model-visible annotation context

**Files:**
- Modify: `apps/desktop/src/lib/response-annotations.ts`
- Test: `apps/desktop/test/response-annotations.test.mjs`
- Test: `packages/agent-runtime/src/runtime.test.ts`
- Update: `scripts/e2e/selection-reference-workflow.tsx`
- Update: `docs/spec/06-delivery/04-e2e-test-plan.md`

- [ ] Add a failing serializer assertion that the prompt explicitly tells the model the selected excerpt is included with the current request and must not be called missing when present.
- [ ] Add a provider-message boundary test that submits the annotated envelope with a punctuation-only request and captures the last user message passed to the mocked provider stream.
- [ ] Clarify the generated envelope instructions without changing JSON shape, parser behavior, UI projections, or source attribution.
- [ ] Update the Chromium fixture and E2E acceptance wording to map the envelope assertion to the provider-boundary regression test.
- [ ] Run the focused Node tests, AgentRuntime test, and `node scripts/e2e-selection-reference-workflow.mjs`.
- [ ] Review the diff and run applicable typecheck/lint gates before delivery.
