# Windows Computer Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the upstream host-owned Computer Use capability and add a Windows UI Automation backend without bypassing host policy or exposing native handles to the renderer.

**Architecture:** Keep the upstream process boundary: Electron main owns the model loop and cropped capture; Rust host-core owns target enumeration, UI Automation, input synthesis, grants, refusals, freshness checks, and audit. Windows support is compiled behind `cfg(windows)` and any unsupported operation returns a typed refusal. Do not operate the user's live desktop during implementation or validation.

**Tech Stack:** Rust host-core, Windows UI Automation COM APIs, existing `windows-sys` dependency where sufficient, TypeScript/Electron main, shared IPC/RPC contracts, Vitest/Node tests.

**Spec:** `docs/spec/03-runtime/computer-use.md`; upstream reference `vastsa/main:docs/adr/0342-os-computer-use-capability.md` and `docs/adr/0344-computer-use-whole-desktop-grant.md`.

## Global Constraints

- Host-core is the only authority for target validation, grants, refusals, and native input.
- The renderer never receives HWNDs, UIA element references, or input primitives.
- Refuse PI-Desktop's own windows, secure input, password controls, higher-integrity windows, stale revisions, and out-of-bounds coordinates.
- No live provider calls or `verify:ui:*` during implementation. An isolated
  local fixture-app interaction is permitted only when the user explicitly
  requests it; never target unrelated windows or real application data.
- Preserve the approved upstream desktop-grant semantics; every grant is revocable, bounded, and audited.
- Do not change unrelated in-progress work in this task worktree.

## Review Focus

1. A stale or recycled HWND must never target a different window — host policy and backend tests cover identity revalidation.
2. An elevated target must be rejected before inspection or input — Windows integrity tests cover it.
3. Password and secure-input states must fail closed — policy and backend tests cover unknown state as refusal.
4. Renderer/sidecar callers must not gain direct native APIs — IPC/RPC allowlist and architecture tests cover the boundary.
5. COM/UIA hangs or element invalidation must become bounded errors, not a stuck Host — timeout and cancellation paths are tested.

---

### Task 1: Port the platform-independent Computer Use contract

**Files:** upstream Computer Use contract, policy, tests, shared types, error codes, and specs; integration points identified by upstream commits `49fad3fca` and `91b3ccfd9`.

**Interfaces:** Preserve upstream `Desktop` trait, `TargetRef`, `RawTarget`, `Measured`, `RawInspection`, and typed refusal codes. The current fork has no Computer Use module, so port the contract and policy as one cohesive unit rather than a Windows-only stub.

- [x] Add contract tests for self-target denial, secure-input denial, stale revision, grant expiry, and bounded labels; verify the tests fail before implementation.
- [x] Port the platform-neutral host-core grant/policy/RPC domain and shared contracts from the upstream reference, adapting only integration names required by this fork.
- [x] Keep non-Windows platforms explicitly unsupported until their backends are implemented; never report no-op as success.
- [x] Run focused host-core Computer Use and shared contract tests.

### Task 2: Port bounded agent loop and Electron integration

**Files:** `packages/computer-use/**`, `packages/agent-runtime/**`, `apps/desktop/electron/main/computer-use/**`, settings/i18n/IPC wiring, tests, and the Computer Use spec/E2E records.

**Interfaces:** Agent sidecar uses only the existing Host `tools.execute` allowlist; Electron main handles model calls and scope-cropped capture; settings bind a dedicated provider/model. No plugin API is added.

- [x] Port the bounded loop package and prove action limits, schema rejection, refusal propagation, and deterministic cursor cleanup. Cancellation wiring remains part of service integration.
- [x] Register the dedicated Computer tool only when host settings enable it; keep it out of Plan/Goal and approved Plan/Goal execution.
- [x] Route local execution through the Host `tools.execute` authorization gate; preserve `tools.abort` cancellation and a bounded 10-minute local-tool deadline.
- [x] Add an Electron-main handler that resolves only the separately bound Computer model, calls the bounded loop, uses `computer.*` Host RPC, and revokes its grant on completion/cancellation.
- [x] Cover tool registration, disabled settings, host authorization, mode denial, the loop handler, and cancellation with automated fixtures.
- [x] Add Settings controls for accessibility-only vs. granted-window pixel capture, a click-through cursor overlay, and the live Stop surface. Keep screenshots disabled by default and bind each capture to the exact Host-granted native window.
- [x] Cover secure-input refusal, exact source matching, image forwarding to the dedicated model, cursor stale-event handling, and the settings/Stop user path with automated fixtures.
- [x] Verify Plan/Goal hard-deny and no silent fallback to the chat model.
- [x] Run Computer Use (31), Agent Runtime (1691 passed / 1 skipped), Host Runtime (178 passed / 3 skipped), Electron-main Computer Use fixtures (3), desktop typecheck, and agent-policy checks.

### Task 3: Implement the Windows UI Automation backend

**Files:** `crates/host-core/src/computer/backend/windows.rs`, backend selection, Windows dependency declarations/lockfile, and Windows backend tests.

**Interfaces:** Implement the existing `Desktop` trait. Enumerate visible top-level windows; inspect bounded UIA trees; map supported UIA patterns to actions; use only target-window/process-scoped input; report elevated targets; never warp the global cursor. Unsupported UIA patterns fail explicitly.

- [ ] Add deterministic backend tests around an injectable Windows API seam for window identity, elevation, secure/password state, bounds, stale elements, and action targeting.
- [ ] Add a deterministic injectable Windows API seam for OS-bound behavior; current tests cover pure identity, integrity, desktop-state, and key parsing rules only.
- [x] Implement COM apartment/lifetime handling and bounded UIA calls; avoid leaking COM references across requests.
- [x] Implement targeted key delivery and UIA pattern actions; reject any fallback that would globally move the cursor or inject into whichever window is focused.
- [x] Run Windows-host `cargo test -p host-core computer:: --locked` and Clippy. Do not claim real-app/device acceptance from these tests.

### Task 4: Integrate, review, and validate

**Files:** relevant English/Chinese specs, ADR/index, E2E plan, architecture tests, and only integration fixes required by Tasks 1–3.

- [ ] Review the full diff for permission widening, unsupported-path success, and unrelated changes.
- [ ] Run focused Computer Use suites, host-core tests, desktop typecheck/build, `cargo fmt --check`, `cargo clippy -p host-core --all-targets`, `pnpm check:agent-policy`, and applicable E2E fixtures.
- [x] Run the native UIA backend against its harmless local fixture after
  explicit user approval; packaged-app and arbitrary application acceptance
  remain outstanding.
- [ ] Do not commit, push, open a PR, or merge unless separately requested.

### Task 5: Add the Settings and live grant control surface

**Scope:** User-approved continuation after the Agent Runtime integration. Ship
the Settings controls and a visible live grant/Stop surface; pixel capture,
cursor overlay, and real Windows application acceptance remain separate.

**Files:** `apps/desktop/src/features/settings/ComputerUseSettings.tsx`,
`apps/desktop/src/features/settings/SettingsPage.tsx`, shared IPC/preload/API
contracts, Electron main computer-use lifecycle, renderer grant indicator,
localized strings, component/IPC tests, and the Computer Use spec.

**Acceptance:** The feature is off by default; the user can bind a dedicated
enabled provider/model, select only implemented accessibility capture, set
bounded action/idle limits, and view platform capability diagnostics. No
grant is minted by the Settings page. When a grant is live, a visible indicator
names the currently bound window and shows budget/capture mode; Stop revokes
that grant and aborts only the owning session's turn. Closing the view, a
renderer reload, a duplicate click, or a stale event must not orphan a grant or
stop another session.

- [x] Add focused settings-form interaction tests for defaults, binding validation,
  capability diagnostics, and saving without minting a grant.
- [x] Add renderer-visible lifecycle events and an owner-checked Stop path from
  Main to host-core plus the owning Agent Runtime cancellation.
- [x] Cover enable/configure and the live Stop surface in the isolated Electron
  renderer, then exercise the production Main Computer tool + Stop IPC path with
  a Host RPC grant fixture. Assert Host revoke precedes abort, only the owning
  session is cancelled, and the active grant is cleared.
- [x] Update English/Chinese behavior specs and synchronize shipped
  locale keys.
- [x] Run the combined targeted Computer Use tests, affected typechecks,
  `git diff --check`, and policy checks. Native UIA fixture acceptance passed;
  full packaged-app acceptance remains outstanding.
