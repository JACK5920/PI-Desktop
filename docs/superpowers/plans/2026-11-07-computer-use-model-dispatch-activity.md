# Computer Use Model Dispatch and Activity Implementation Plan

> **For agentic workers:** Implement task-by-task with test-first changes.

**Goal:** Make the built-in `Computer` callable in a fresh Agent conversation across provider routes and show live, truthful desktop-operation activity.

**Architecture:** When Computer Use is enabled, declare `Computer` as an Agent core tool from the first model request, avoiding ToolSearch-dependent schema mutation. Keep the Host grant and dedicated Computer model unchanged. Stream sanitized loop phase/action updates through the existing Main-owned status surface; style it as a top-center blue activity pill, add a blue glow frame around the monitor containing the currently bound window, and retain the animated click-through cursor. The overlay surface must stay transparent so desktop content remains visible and actionable; use edge glow only, never a dark full-display wash. Never send typed text, captured pixels, or model prose through the status event.

**Tech Stack:** TypeScript, Vitest, Electron IPC, React, i18n.

**Spec:** `docs/spec/03-runtime/computer-use.md`; `docs/spec/06-delivery/04-e2e-test-plan.md`.

## Global Constraints

- Host remains the sole authority for Computer grants and every desktop action.
- Plan and Goal modes remain unable to call `Computer`.
- Computer Use continues to use its explicit dedicated model; no fallback to the chat model.
- No extra screenshots are added to activity IPC or persisted by the new UI.
- Cursor, whole-monitor frame, and status-pill overlays remain visual-only and click-through; Host retains sole action authority.
- UI strings use i18n; stop/cancellation behavior and existing grant visibility remain intact.

## Review Focus

- Fresh Agent session with a model route that does not support stable mid-turn tool-schema changes: `Computer` is present before ToolSearch and dispatches to its local handler.
- Disabled Computer Use and Plan/Goal mode: no callable Computer declaration.
- Activity update during observation, model decision, action, completion, refusal, and cancellation is truthful and grant-scoped; stale grant events cannot leave a frame or pill behind.
- The blue border frames only the display containing the active target; it never changes target enumeration or authorization.
- Activity payload excludes typed values, screenshot bytes, and model-generated prose.
- Widget opens/closes with the active grant and its Stop control still revokes only that grant.

---

### Task 1: Declare enabled Computer Use as an Agent core tool

**Files:** `packages/agent-runtime/src/runtime.ts`, `packages/agent-runtime/src/runtime.test.ts`.

- [ ] Add a failing runtime test asserting enabled Computer is present in the initial Agent tool set and not in the deferred set, while disabled/Plan/Goal remain unavailable.
- [ ] Run the focused test and confirm it fails because Computer is currently deferred.
- [ ] Make the smallest tool-classification change so the existing Computer registration is core only when it exists in Agent mode.
- [ ] Run the focused Computer registration tests and ToolSearch/runtime tests affected by the declaration change.

### Task 2: Publish bounded, sanitized live operation activity

**Files:** `packages/shared/src/computer-use.ts`, `packages/shared/src/protocol.ts`, `packages/computer-use/src/loop.ts`, `packages/computer-use/src/loop.test.ts`, `apps/desktop/electron/main/computer-use/active-run.ts`, `apps/desktop/electron/main/computer-use/agent-tool.ts`, `apps/desktop/electron/main/computer-use/widget-window.ts`, `apps/desktop/electron/main/computer-use/agent-tool.test.ts`, `apps/desktop/electron/preload/index.ts`, `apps/desktop/src/lib/api.ts`.

- [ ] Test the loop emits ordered phase/action activity and sanitized step completion/refusal events.
- [ ] Add a typed activity contract with grant id, phase, optional action/target/error code, and bounded recent step summaries; exclude screenshots and entered text by construction.
- [ ] Emit the contract from the existing bounded loop and publish it through Main-owned run state and a dedicated allowlisted IPC event.
- [ ] Test active grant ownership, terminal cleanup, and activity stream updates at the Main tool boundary.

### Task 3: Show live activity and Codex-inspired visual effects

**Files:** `apps/desktop/src/features/computer-use/ComputerUseWidget.tsx`, related computer-use widget CSS, locale files, widget renderer tests/E2E, and `docs/spec/03-runtime/computer-use.md`, `docs/spec/06-delivery/04-e2e-test-plan.md`.

- [ ] Add interaction coverage for phase/action changes, completion/failure states, grant-scoped display-frame/indicator cleanup, and the existing Stop control.
- [ ] Move the existing activity widget to a top-center blue status pill with current phase/target/action and the existing Stop control.
- [ ] Add a blue glow frame around the whole display containing the currently controlled window in the existing click-through overlay; preserve the virtual cursor's blue halo and click pulse.
- [ ] Keep a bounded recent-step trail in the status surface without exposing typed values, model prose, or screenshots.
- [ ] Localize all new strings and ensure accessibility labels describe state, not inferred success.
- [ ] Update the behavior contract and deterministic Computer Use E2E scenario.

### Task 4: Verify and review

- [ ] Run targeted runtime, computer-use loop, Electron Main, renderer/widget, and type checks.
- [ ] Run relevant Computer Use E2E against deterministic fixtures; do not operate the user's desktop.
- [ ] Review `git diff --check`, full task diff, and report any packaged-app acceptance that remains outstanding.
