# Selection References, Response Annotations, and Docked Side Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a selection-centered workflow that can copy or append selected text, attach comments to assistant excerpts with answer citations, and run follow-ups in a docked child conversation without switching away from the parent.

**Architecture:** Keep selection, unsent annotation attachments, and side-chat tab registration renderer-owned and transient. Serialize annotations in a JSON prompt envelope so the existing transcript can recover citation context after send; use ordinary `session.fork`, `sendPrompt`, WorkPanel contexts, and session-scoped events for side chats. Do not add a Host entity, database migration, IPC/RPC, protocol change, or permission.

**Tech Stack:** TypeScript, React, Zustand store slices, existing Markdown renderer, i18next locale catalogs, Node `node:test`, Electron/Chromium renderer fixture.

**Spec:** `docs/superpowers/specs/2026-11-04-selection-references-annotations-side-chats-design.md`

## Global Constraints

- Local writable conversations only; do not expose side-chat actions in remote/read-only sessions.
- Selecting, annotating, copying, or opening a side-chat draft never submits a prompt.
- Cap excerpts created through the new selection toolbar at 2,000 characters; do not change the existing context-menu “Ask about selection” behavior.
- Preserve the existing message Copy, context-menu Copy, Select message text, Fork, and ordinary activated-fork semantics.
- Unsent annotations and side-chat drafts are transient; successfully forked children remain ordinary durable sessions.
- Reuse existing permission gates and Host-owned approval/ask handling; do not add privileges or bypass checks.
- Annotation prompt contents are JSON-serialized, hidden from transcript/edit/queue/title display, and consumed only after Host admission of the exact unchanged attachment snapshot.
- Add new E2E identifiers; do not reuse identifiers retired by ADR 0268.
- Localize every user-visible string in all shipped catalogs: `de`, `en`, `es`, `fr`, `ko`, `pt-BR`, `tr`, `zh-CN`, and `zh-TW`.

## Review Focus

1. **Selection changes or collapses while the toolbar is open:** actions use the captured excerpt/message, never a later empty or unrelated browser selection. Pin with the real Chromium selection fixture and selection-helper tests.
2. **Existing parent draft or file chips:** Add to chat and Add to main chat append without replacing text, attachments, caret-owned content, or a newer draft. Pin with Composer draft tests and the user-path fixture.
3. **Send rejection or concurrent annotation edits:** rejected sends retain attachments; accepted sends consume only the exact snapshot submitted, not annotations added/edited while awaiting acceptance. Pin with composer-submit/store tests.
4. **Citation parsing and source association:** only a valid in-range directive resolves against the annotation envelope for that assistant turn; malformed, unknown, hostile-looking, or stale indices remain inert text. Pin with parser and Markdown fixture tests.
5. **Side-chat fork/send racing close or session switch:** first send creates at most one child; explicit work may finish, but stale completion cannot reopen a closed tab, change the active parent, or overwrite a newer draft. Pin with store lifecycle tests and the user-path fixture.
6. **Selection actions inside a docked child:** selected user text targets the compact child draft, child annotations remain reviewable, and nested Ask in side chat is not exposed because its session-keyed WorkPanel context would be hidden. Pin with the Chromium user-path fixture.

---

### Task 1: Add selection capture and append-to-draft behavior

**Files:**
- Create: `apps/desktop/src/lib/transcript-selection.ts`
- Test: `apps/desktop/test/transcript-selection.test.mjs`
- Create: `apps/desktop/src/features/chat/transcript/TranscriptSelectionToolbar.tsx`
- Modify: `apps/desktop/src/features/chat/transcript/ChatTranscript.tsx` (mount the focused controller only)
- Modify: `apps/desktop/src/features/chat/transcript/MessageRow.tsx` and `AssistantTurn.tsx` (selection ownership metadata/action callbacks)
- Modify: `apps/desktop/src/styles/messages.css` and `apps/desktop/src/styles/composer.css`
- Test: `apps/desktop/test/selected-text-followup.test.mjs`, `apps/desktop/test/session-fork-running.test.mjs`, and new `apps/desktop/test/selection-draft-append.test.mjs`
- Modify: `scripts/e2e/message-edit-copy.tsx` or create `scripts/e2e/selection-reference-workflow.tsx`; create `scripts/e2e-selection-reference-workflow.mjs`

**Interfaces:**
- `normalizeTranscriptExcerpt(raw: string, maxLength?: number): string | null` normalizes line endings/outer whitespace, returns `null` for empty selections, and enforces the 2,000-character toolbar cap without splitting a Unicode code point.
- `TranscriptSelection` captures `{ sessionId, messageId, role, excerpt, rect }` before toolbar focus changes; the UI must verify that both range endpoints belong to the same eligible transcript message.
- Append selected user text and side-chat results through the existing `composerDraftBridge.appendTextForSession(sessionId, text)` path. It must preserve the parent's current draft and file references; do not alter the existing replacement-style prefill contract.

- [ ] **Step 1: Write failing helper and selection-ownership tests** for line-ending normalization, empty/whitespace selections, 2,000-character truncation, selection spanning rows, remote/ineligible rows, and captured source identity.
- [ ] **Step 2: Run the focused tests and confirm they fail** against the missing helper/toolbar behavior.
- [ ] **Step 3: Implement the pure selection helper and focused toolbar/controller.** Reuse `lib/selection-tex.ts` for formula-aware excerpt/copy text. Show Copy for non-empty selections, Add to chat for eligible rows (append selected user text or attach the selected assistant excerpt), and Ask in side chat only for a completed assistant message that can be forked and prompted. Dismiss on Escape/outside/collapse/session change; reposition on scroll/resize only while the captured range remains valid; support keyboard activation and return focus to the selection owner.
- [ ] **Step 4: Route Add to chat through `composerDraftBridge.appendTextForSession`.** Append a localized blockquote plus source attribution for selected user text, preserve existing attachment chips/draft selection, and surface a localized error if the active parent Composer is unavailable; do not change the existing replacement-style prefill contract.
- [ ] **Step 5: Run helper, selected-text-followup, session-fork-running, and draft-append tests.** Add a deterministic Chromium scenario that selects text, verifies toolbar actions and exact formula-aware Copy payload, changes/collapses the selection, and confirms the captured action does not consume a different selection. Keep message-row Copy, context-menu Copy, and Select message text outcomes distinct.

### Task 2: Implement annotation attachment state and safe prompt envelope

**Files:**
- Create: `apps/desktop/src/lib/response-annotations.ts`
- Test: `apps/desktop/test/response-annotations.test.mjs`
- Create: `apps/desktop/src/stores/slices/annotation-slice.ts`
- Modify: `apps/desktop/src/stores/app-state.ts`, `apps/desktop/src/stores/app-store.ts`, `apps/desktop/src/stores/slices/initial-state.ts`, and `apps/desktop/src/stores/slices/types.ts`
- Modify: `apps/desktop/src/features/chat/composer/hooks/useComposerSubmit.ts` and `apps/desktop/src/stores/slices/queue-slice.ts` only where acceptance callback/display projection requires it
- Modify: user request/optimistic-row projection in `apps/desktop/src/features/chat/transcript/MessageRow.tsx` and `apps/desktop/src/stores/slices/queue-slice.ts`, queue preview in `apps/desktop/src/features/chat/composer/ComposerStatus.tsx`, and prompt-derived title fallback in `apps/desktop/src/stores/slices/queue-slice.ts`
- Test: `apps/desktop/test/composer-submit-race.test.mjs`, `apps/desktop/test/session-title-prompt-fallback.test.mjs`, create `apps/desktop/test/response-annotation-slice.test.mjs`, and extend `apps/desktop/test/queue-pending-actions.test.mjs`

**Interfaces:**
- `ResponseAnnotation` is `{ id: string; sourceMessageId: string; excerpt: string; comment?: string }`; order in the current attachment list determines its 1-based citation index.
- `buildAnnotatedPrompt(requestText: string, annotations: readonly ResponseAnnotation[]): string` inserts one generated `# Response annotations:` section with a fixed instruction and JSON payload, then `## My request:` and the unchanged user request.
- `parseAnnotatedPrompt(content: string): { annotations: ParsedResponseAnnotation[]; requestText: string } | null` validates the generated shape and exposes no executable HTML/links.
- `requestTextWithoutAnnotations(content: string): string` returns the user's request for transcript display, edit seeds, queue previews, and title derivation; malformed envelopes remain ordinary text rather than being partially stripped.
- Store operations are session-keyed add/edit/remove/clear and `consumeAcceptedAnnotations(sessionId, snapshot)`; consumption compares the submitted annotation ids and values so a newer edit/add survives.

- [ ] **Step 1: Write failing tests** for exact JSON round-trip (quotes, CJK, newlines, directive-like text), 1-based order, empty comment, invalid/malformed envelope, display reduction, session isolation, and accepted-snapshot consumption after asynchronous edit/add.
- [ ] **Step 2: Run the focused tests and confirm they fail** before adding implementation.
- [ ] **Step 3: Implement the pure parser/serializer and transient annotation slice.** State is not persisted. Ignore annotation-only submits; require non-empty user request text. Add a deterministic store test in `apps/desktop/test/response-annotation-slice.test.mjs`.
- [ ] **Step 4: Integrate serialization only into ordinary prompt submission.** Preserve steering, retry, and local command semantics. After direct or queue admission succeeds, consume only unchanged submitted attachments; on rejection restore the draft and keep annotations.
- [ ] **Step 5: Apply request-only display projection** to sent user bubbles, optimistic rows, edit seeds, queued-prompt previews, and fallback titles without changing the raw prompt used by the model or retry. The parser recognizes only the generated envelope at the beginning of the message; marker-like text inside the user's request cannot truncate or rewrite it.
- [ ] **Step 6: Run annotation, Composer submit-race, queue, and title-fallback tests.** Prove rejected sends preserve the annotation list and an accepted old snapshot does not erase a newer edit.

### Task 3: Add annotation review UI and model-authored citation references

**Files:**
- Create: `apps/desktop/src/features/chat/composer/ComposerAnnotationAttachments.tsx`
- Create: `apps/desktop/src/features/chat/transcript/AnnotationCitation.tsx`
- Modify: `apps/desktop/src/components/Markdown.tsx` (recognize the exact citation directive through a safe Markdown plugin/component)
- Modify: `apps/desktop/src/features/chat/transcript/AssistantTurn.tsx` and `AssistantTurnParts.tsx` (supply that turn's annotation envelope)
- Modify: `apps/desktop/src/components/Composer.tsx` and `apps/desktop/src/features/chat/composer/ComposerInput.tsx` (attachment chip/list and add/edit/remove/clear actions)
- Modify: `apps/desktop/src/styles/composer.css`, `apps/desktop/src/styles/messages.css`, and existing component tests
- Test: `apps/desktop/test/response-annotation-citations.test.mjs` and renderer fixture coverage

**Interfaces:**
- The pending attachment chip opens a review list with per-item edit/remove and Clear all; annotation numbers are recomputed from the visible pending order.
- Citation syntax is exactly `:codex-annotation{index="N"}` for a positive decimal integer. A citation resolves only against the structured annotation list parsed from the user prompt belonging to that assistant turn; it renders as a keyboard-operable safe button and opens a localized excerpt/comment/source-message popover.
- The fixed prompt instruction explicitly treats the JSON payload as quoted reference data, not instructions; JSON-serialized excerpt/comment values cannot inject Markdown or HTML into the citation card.

- [ ] **Step 1: Add failing tests** for attach/save with empty comment, cancel, duplicate source/excerpt reopening, edit/remove/clear, citation association to the correct preceding prompt, unknown/out-of-range directive fallback, and hostile Markdown/HTML-looking content remaining inert.
- [ ] **Step 2: Run the focused tests and confirm the new review/citation behavior fails.**
- [ ] **Step 3: Implement the Composer attachment list and annotation editor.** Selection text/comment are rendered as text, never interpolated as markup; closing or changing sessions cannot attach an annotation to another conversation.
- [ ] **Step 4: Implement exact-directive recognition in the Markdown pipeline** and the citation popover. Do not create application-generated highlights or modify the source answer; unknown markers remain ordinary Markdown text.
- [ ] **Step 5: Run focused component/Markdown tests and the Chromium rendering fixture.** Verify keyboard activation, focus restoration, unknown citations, and untrusted excerpt/comment content.

### Task 4: Implement docked side-chat fork/send lifecycle and live transcript

**Files:**
- Create: `apps/desktop/src/lib/side-chat-lifecycle.ts`
- Test: `apps/desktop/test/side-chat-lifecycle.test.mjs` and `apps/desktop/test/side-chat-store.test.mjs`
- Modify: `apps/desktop/src/lib/work-panel-tabs.ts` and `apps/desktop/src/stores/slices/work-panel-slice.ts`
- Create: `apps/desktop/src/stores/slices/side-chat-slice.ts`
- Modify: `apps/desktop/src/stores/app-state.ts`, `apps/desktop/src/stores/app-store.ts`, and `apps/desktop/src/stores/slices/initial-state.ts`
- Modify: `apps/desktop/src/stores/slices/session-slice.ts` (explicit-parent, non-activating assistant-message fork action; leave existing fork action unchanged)
- Create: `apps/desktop/src/components/workpanel/SideChatTab.tsx`
- Modify: `apps/desktop/src/components/workpanel/WorkPanel.tsx`, `apps/desktop/src/stores/slices/events-slice.ts`, and `apps/desktop/src/stores/runtime/session-runtime.ts` only if needed to publish reactive transcript snapshots for open side-chat child ids
- Test: `apps/desktop/test/work-panel-tabs.test.mjs`, `apps/desktop/test/session-fork-running.test.mjs`, plus focused side-chat store/event tests

**Interfaces:**
- Add a `side-chat` WorkPanel tab kind with a stable transient tab id; side-chat registrations are keyed by the tab id and record `{ parentSessionId, sourceMessageId, excerpt, childSessionId?, generation }`.
- `forkAssistantMessageInSession(parentSessionId, messageId)` creates/records a normal child with `activate: false` and returns the child id; it rechecks `canEditMessages` against the explicit parent session.
- `sendPrompt(content, draft, childSessionId)` remains the sole prompt path and preserves the existing `canPrompt` check, queue/stop behavior, and per-session approvals/asks.
- Side-chat transcript rendering consumes reactive store snapshots (`retainedTranscripts` or a narrowly scoped observable projection), never a renderer subscription to `sessionTranscriptCache` Map alone.
- Selection lookup for a visible child uses its reactive side-chat snapshot when present; selected user text appends to the compact child draft, annotations are reviewable in that input, and nested Ask in side chat waits until promotion to a normal conversation.

- [ ] **Step 1: Write failing lifecycle/store tests** for draft-only open, no fork/send before explicit non-empty Send, de-duplicated concurrent first sends, non-activating fork, provider rejection with child retained for retry, subsequent sends to the same child, and explicit parent identity.
- [ ] **Step 2: Add race tests** for close/switch during fork and send, and confirm completion cannot recreate the tab, change active session, or replace a newer Composer draft.
- [ ] **Step 3: Run the tests and verify the lifecycle regressions fail** before implementation.
- [ ] **Step 4: Implement focused side-chat lifecycle state and a non-activating fork action.** Keep `session-slice.ts`, `work-panel-slice.ts`, and `ChatTranscript.tsx` as wiring surfaces; put lifecycle decisions in the focused module/slice.
- [ ] **Step 5: Add the WorkPanel tab UI** with the selected excerpt as editable quoted draft context, transcript, compact text input, Send/Stop, existing permission/ask cards, Add to main chat (append the latest assistant result plus source attribution through the Composer draft bridge), Open as a conversation, and close semantics. Existing parent transcript, scroll position, active session, and Composer remain selected. Promoting to a conversation releases only the side-chat projection; closing a created tab releases its projection but does not stop or delete its ordinary child session. Existing session notifications/approvals remain available while its parent panel is hidden.
- [ ] Docked child history mutations remain hidden until promotion because the existing edit/delete/revision/regenerate/fork actions are scoped to the active session; error-card Continue sends explicitly to the child session.
- [ ] **Step 6: Prove session-scoped events update the mounted side-chat transcript reactively.** If the cache Map is the only changed object, add only the minimal observable projection needed for the registered child and test start/update/end/tool/permission/ask events plus cleanup on close/switch/dispose.
- [ ] **Step 7: Run focused side-chat, WorkPanel tab, fork, session-event, permission/ask tests and desktop typecheck.** No event or projection may duplicate a Host tool execution or approval.

### Task 5: Synchronize product records, locales, E2E traceability, and final validation

**Files:**
- Create: `docs/adr/0346-selection-references-annotations-and-docked-side-chats.md` (recheck the next unused ADR number after refreshing the task branch)
- Modify: `docs/spec/08-meta/decisions-log.md`
- Modify: `docs/spec/04-ux/08-component-spec.md` and `docs/spec/04-ux/09-interaction-patterns.md`
- Modify: `docs/spec/06-delivery/04-e2e-test-plan.md` with fresh identifiers, e.g. `E2E-CHAT-selection-capture-v2`, `E2E-CHAT-annotation-citation-flow-v2`, and `E2E-CHAT-docked-follow-up-tab-v2`; never restore the retired ADR 0268 identifiers
- Modify: `packages/i18n/src/locales/{de,en,es,fr,ko,pt-BR,tr,zh-CN,zh-TW}/index.ts`
- Create/modify: `scripts/e2e/selection-reference-workflow.tsx` and `scripts/e2e-selection-reference-workflow.mjs`; add a root `test:e2e:selection-references` script if consistent with the current command catalog
- Modify: `package.json` only if registering the E2E command

**Interfaces:**
- The ADR amends ADR 0268 and ADR 0342 without reviving the old decision/E2E ids or changing Host/protocol/storage boundaries.
- E2E coverage maps each new ID to an executable unit/store/Chromium scenario and reports UI/manual acceptance separately from automated results.

- [ ] **Step 1: Add locale keys and run catalog checks** to catch missing, extra, or malformed translation keys.
- [ ] **Step 2: Add ADR 0346 and decision-log D686, then sync UX/E2E specifications** to the behavior proven by Tasks 1–4; preserve the previous removal records as historical decisions and mark the new decision as the current amendment.
- [ ] **Step 3: Add the end-to-end Chromium user path**: select assistant text → add/edit a comment → send a request → receive/render a citation; separately open side chat → send first prompt → stream while parent stays selected → add result to parent draft/open as a conversation/close; cover rejection, permission/ask, and stale close/switch paths with deterministic fixtures.
- [ ] **Step 4: Run focused tests before integration**: all new helper/store tests, `pnpm --filter @pi-desktop/desktop typecheck`, the selected desktop Node tests, `pnpm lint`, `pnpm docs:check`, and `pnpm check:agent-policy`. Record exact results and do not claim the Chromium scenario passed yet.
- [ ] **Step 5: Review the task diff** for source/projection separation, stale async ownership, permission parity, locale completeness, no retired E2E IDs, no persistence/protocol growth, and no unrelated files.
- [ ] **Step 6: Refresh the private task branch against current `origin/main`** (`git fetch origin main`, `git rebase origin/main`, then `pnpm check:pr-base`); resolve conflicts only in this worktree and repeat applicable focused checks.
- [ ] **Step 7: Run the task-candidate Chromium E2E and required validation gates** against that same refreshed candidate: `pnpm --filter @pi-desktop/desktop test`, `pnpm --filter @pi-desktop/desktop typecheck`, `pnpm lint`, `pnpm docs:check`, `pnpm check:agent-policy`, and the focused selection/side-chat E2E command. Use no real provider, account, external service, or running user instance. Run `pnpm build:js` if touched renderer/runtime modules require its generated/bundled contracts. Record unavailable environment gates honestly; do not claim GUI acceptance unless it ran.
- [ ] **Step 8: Follow the repository's fixed commit/PR delivery sequence** after candidate validation; stage only explicit paths and preserve the one-branch/one-worktree rule.
