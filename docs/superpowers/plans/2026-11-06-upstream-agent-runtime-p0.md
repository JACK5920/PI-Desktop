# Upstream Agent Runtime P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selectively adopt upstream provider-error and shell-patch classification fixes without merging unrelated upstream product changes.

**Architecture:** Keep the fork's existing error-code contract and mutation-recovery policy. Port only the missing classification/lexer behavior, with regression tests proving terminal versus retryable errors and real patch-command detection. Preserve Goal, annotations/side chats, and Review behavior.

**Tech Stack:** TypeScript, Vitest, pnpm workspace.

**Spec:** `docs/spec/03-runtime/08-error-codes.md`; patch recognition is an internal recovery guard and must not alter Host shell permission or execution behavior.

## Global Constraints

- Do not merge `vastsa/main` wholesale or overwrite fork-specific features.
- Do not broaden provider authentication matching: generic `unauthorized` and `permission denied` in HTTP 400/422 bodies remain ordinary provider errors.
- Preserve existing provider retry budgets; quota exhaustion and context overflow remain terminal.
- Patch detection is classification only; it never executes commands or changes Host authorization.

## Review Focus

- A malformed 400/422 containing a generic auth-like word must not be mislabeled as a bad API key.
- Context overflow wrapped in 5xx must not enter transient retry; ordinary 5xx and rate limits must remain retryable.
- Provider quota codes on 429 must not consume retries.
- `patch` text in quoted arguments, comments, or heredoc data must not trigger the mutation-recovery stop guard.
- A real `git apply`/`apply_patch` command after a shell separator must still be detected.

---

### Task 1: Provider error classification

**Files:**
- Modify: `packages/agent-runtime/src/agent-errors.test.ts`
- Modify: `packages/agent-runtime/src/provider-retry.test.ts`
- Modify: `packages/agent-runtime/src/agent-errors.ts`
- Modify: `docs/spec/03-runtime/08-error-codes.md` and its Chinese counterpart, if present

- [x] Add failing cases for explicit API-key rejection at HTTP 400/422, generic auth-like text at those statuses, 5xx-wrapped context overflow versus ordinary 5xx/rate-limit wording, and OpenCode Zen `FreeUsageLimitError` on 429.
- [x] Run the focused Vitest files and confirm the new assertions fail for the intended classifications/retry decisions.
- [x] Implement the narrow classifiers, keeping quota/context checks ahead of generic retry branches and preserving current error details.
- [x] Update runtime error documentation to describe the exact status/body distinctions.
- [x] Re-run the focused tests and agent-runtime typecheck.

### Task 2: Shell patch-command recognition

**Files:**
- Modify: `packages/agent-runtime/src/mutation-recovery.test.ts`
- Modify: `packages/agent-runtime/src/runtime.test.ts` only where the public recovery behavior needs an assertion
- Modify: `packages/agent-runtime/src/mutation-recovery.ts`

- [x] Add failing tests for quoted `patch` text, comments, heredoc bodies/delimiters, multiple heredocs, and genuine commands after separators.
- [x] Run the focused mutation-recovery test and confirm failures distinguish false positives from real patch commands.
- [x] Replace the simple regex-only classification with bounded quote/comment/heredoc-aware command segmentation; do not turn this into a shell executor or permission parser.
- [x] Re-run focused tests and agent-runtime typecheck. The full suite was also run; see the environment note below.

### Task 3: Share one pending first-session creation

**Files:**
- Create: `apps/desktop/test/session-draft-materialization.test.mjs`
- Modify: `apps/desktop/src/stores/runtime/session-coordination.ts`
- Modify: `apps/desktop/src/stores/runtime/session-runtime.ts`
- Modify: `apps/desktop/src/stores/slices/session-slice.ts`
- Modify: the queue/remote-session call sites only where the shared promise's return type requires it
- Modify: `docs/spec/04-ux/09-interaction-patterns.md` and E2E plan

- [x] Add failing tests for New Task racing the first prompt, overlapping initial inputs, superseded navigation, and shared creation failure/retry.
- [x] Run the new Node test against the base implementation: 3 intended failures (duplicate creation, unshared waiter result, and stale navigation target); then apply the shared request result.
- [x] Change the pending request to share `Promise<string | null>` and make navigation-intent checks return the created session ID only when still current.
- [x] Run the new test plus related session and composer tests (34 passed); desktop package typecheck passed. The test fixture now includes the normal annotation-consumption state required by `sendPrompt`.

### Task 4: Concurrent writes to disjoint Host files

**Files:**
- Modify: `crates/host-core/src/tool_budget.rs`
- Modify: `crates/host-core/src/tool_budget/file_tests.rs`
- Modify: `crates/host-core/src/tools/mod.rs` and `crates/host-core/src/tools/file_lease_tests.rs`
- Modify: related Host permission specification and E2E plan

- [x] Add failing Host tests proving two ticketed, independently identified writes may overlap while same-file writes, older conservative mutations, and source-order dependencies remain serialized.
- [x] Run the focused independent-write test against the base implementation; it failed at the expected per-session capacity gate.
- [x] Allow a bounded second coordinated write only when the Host has validated disjoint file resources; keep resource leases alive through blocking filesystem work.
- [x] Focused budget tests (12 passed), blocking lease tests (2 passed), and `cargo fmt --all -- --check` passed. Complete Host Core Rust suite remains part of the final gate.

### Task 5: Drain delegate work before acknowledging parent abort

**Files:**
- Modify: `packages/agent-runtime/src/runtime.ts`
- Create: `packages/agent-runtime/src/parent-stop-retirement.test.ts`
- Modify: `packages/agent-runtime/src/runtime.test.ts`
- Modify: `docs/spec/03-runtime/02-agent-runtime.md` and E2E plan

- [x] Add failing tests for concurrent abort calls, pending child cleanup, and preventing a successor prompt from racing the old delegate; preserve the fork's existing Stop semantics.
- [x] Run the focused runtime test against the base implementation; concurrent abort did not share the same cleanup promise.
- [x] Join captured delegate completion promises with the active turn settlement while keeping the runtime busy until cleanup finishes.
- [x] Focused delegate/runtime tests passed (3 passed, 404 skipped by filter); the full agent-runtime suite and typecheck remain part of the final gate.

### Task 6: Long-transcript paging and reading-position navigation

**Files:**
- Selectively modify `apps/desktop/src/features/chat/transcript/ChatTranscript.tsx`, its scroll/paging hooks, and focused transcript utilities.
- Add focused regression tests under `apps/desktop/test/` and `scripts/e2e/` as needed.
- Update transcript navigation and history-loading E2E documentation.

- [x] Audit the selected upstream transcript-reader-scroll work against the current fork. The fork already contains the scroll-input ownership, browser smooth-scroll interruption, state-only completion release, bounded history paging, anchor restoration, and older-page/window tests; no redundant patch was introduced.
- [x] Confirm the existing implementation preserves the fork's annotation toolbar, citations, side-chat entry points, and review controls (no transcript component rewrite).
- [x] Run focused transcript/history unit tests: 120 passed. Browser E2E is included in the final gate where its runtime is available.

### Explicitly deferred upstream features

- Computer Use, plugin `.all` session access, local-app launching/plugin launcher redesign, broad settings IA rewrite, user-supplied startup video, external-root file opening, and folder-as-directory paste are not routine fixes. They change product scope, permission reach, local-data exposure, or primary UI behavior and require separate security/product design before adoption.

### Acceptance

- [x] Full relevant workspace gates pass, including Agent Runtime, Desktop/session/transcript tests, Host Core, and targeted E2E.
- [x] `packages/agent-runtime` typecheck passes.
- [x] `git diff --check` passes; only the files listed above and this plan are changed.

## Validation note (2026-11-06)

- Focused classification/retry/recovery/runtime tests: 552 passed, 1 skipped; Agent Runtime typecheck passed.
- Task 3 desktop typecheck passed. Session creation, remote project creation, session-switch and composer submit tests: 34 passed.
- Task 4 focused Host budget tests: 12 passed; blocking file-lease tests: 2 passed; `cargo fmt --all -- --check` passed. `scripts/e2e-parallel-read-batches.mjs` passed (file-symlink subcase skipped because this Windows host does not grant symlink creation; hard-link cases ran).
- Complete Host Core: 1,166 passed, 0 failed, 1 ignored.
- Task 5 focused delegate/abort tests: 3 passed, 404 skipped by filter. Agent Runtime typecheck passed.
- Initial full Agent Runtime run: 25 failures (24 in unchanged `native-pi-session.test.ts` because this Windows profile's global `.agents/skills` was discovered through the `ADMINI~1` short path as a project resource; 1 in unchanged `attachment-history.test.ts` because `realpath` returned the short path while the fixture expected the long spelling), 1,665 passed, 1 skipped. The tests were corrected to isolate the native trust fixture from user-global resources and compare the attachment fallback against `realpath` without weakening either assertion. Fresh package-scoped Agent Runtime suite: **1,690 passed, 1 skipped, 0 failed**.
- Task 6 transcript/history tests: 120 passed. `e2e-transcript-turn-completion.mjs` passed. `e2e-transcript-disclosure-anchor.mjs` passed the geometry probe; its smooth-animation-only assertions were explicitly skipped because the host reports `prefers-reduced-motion: reduce` (the browser resolves smooth scrolling immediately in this environment).
- Desktop package typecheck passed. Initial full-suite run reported 4,657 passed and 102 failed; the failures were individually classified and fixed only where they reflected test portability or product defects. The fresh bounded-concurrency rerun (`node --test --test-concurrency=4 --test-timeout=60000 test/*.test.mjs`) completed with **4,687 passed, 0 failed, 86 skipped (4,773 total)**. Skips are reported separately and are not counted as passes; they include capability/platform-limited cases such as symlink creation and reduced-motion-only assertions. The formerly stalled `remote-unified-chat.test.mjs` was isolated and passed **5/5**.
- A broad Vitest invocation from the repository root is not the Agent Runtime package gate: it discovered unrelated workspace test files and failed many symlink-dependent fixtures because Windows symlink creation is denied. The correct package-scoped command was run from `packages/agent-runtime` and passed as recorded above.
- `git diff --check` passed. The full Desktop TAP log is `%TEMP%\\pi-desktop-full-tests-2026-11-06-final.tap`; it records 4,773 tests, 4,687 passed, 0 failed, and 86 skipped.
- Final acceptance is met for the selected upstream batch. The run was on Windows; platform-specific tests skipped for unavailable capabilities remain unverified on their native platforms. No claim is made that skipped cases passed or that a Linux/macOS host was tested.

### Final rerun (2026-11-06)

- Desktop Node suite: `node --test --test-concurrency=4 --test-timeout=60000 test/*.test.mjs` → **4,687 passed, 0 failed, 86 skipped (4,773 total; 291.35 s)**. Log: `%TEMP%\\pi-desktop-full-tests-2026-11-06-verified.tap`.
- Host Core: `cargo test -p host-core` → **1,166 passed, 0 failed, 1 ignored** (387.88 s).
- Agent Runtime: `node node_modules/vitest/vitest.mjs run --config vitest.config.ts` → **1,690 passed, 0 failed, 1 skipped** (118 files).
- Targeted E2Es: parallel file batches passed (file symlink case skipped because this host denies symlink creation; hard-link cases ran); transcript turn-completion passed; transcript disclosure geometry passed with smooth-animation/input-ownership probes explicitly skipped under `prefers-reduced-motion: reduce`.
- Desktop and Agent Runtime TypeScript checks, `cargo fmt --all -- --check`, and `git diff --check` passed.
