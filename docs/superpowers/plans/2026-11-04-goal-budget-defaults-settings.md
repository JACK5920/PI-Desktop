# Goal Budget Defaults in System Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users set unlimited-token Goal defaults and other per-cycle defaults in System Settings, applying them only to newly approved Goals.

**Architecture:** Persist optional `AppSettings.goalBudgetDefaults` through the existing Host-owned settings JSON. The Host snapshots normalized, validated settings when it creates a Goal lifecycle at approval. Renderer System Settings edits defaults; the Goal lifecycle bar remains the per-Goal override surface.

**Tech Stack:** React/TypeScript, shared `AppSettings` types, Electron settings UI, Rust host-core/SQLite, Vitest/Node tests, i18n catalogs.

**Spec:** `docs/superpowers/specs/2026-11-04-goal-budget-defaults-design.md`

## Global Constraints

- Unlimited means skip only the provider-reported-token cutoff; keep usage accounting, round/time cutoffs, and manual resume.
- Default values: 8 rounds, 250,000 retained finite tokens, 60 minutes, unlimited tokens on.
- Validation: rounds 1–32; finite token budget is a positive safe integer; duration 1–1,440 minutes.
- A changed preference applies only when a Goal is approved after the save; never rewrite an existing lifecycle.
- Host-core remains authoritative; no approval/RPC contract or SQLite schema-version change.
- Settings UI strings must use i18n; settings controls use shared UI primitives.
- Add the preference to portable application settings so existing Cloud Sync can transfer it.

## Review Focus

- Missing settings on upgraded profiles must resolve to unlimited-token defaults, not the old finite-only behavior.
- Invalid or partially malformed budget preferences must fail closed to the documented defaults on read and be rejected on write.
- An approval must snapshot the latest saved preference, without racing a separate renderer-side value.
- Saving defaults must not mutate an existing Goal, even when it is active.
- Unlimited mode must preserve the last finite token value and continue to enforce round/time ceilings.

---

### Task 1: Define and validate Goal budget defaults

**Files:**
- Modify: `packages/shared/src/types/settings.ts`
- Modify: `packages/shared/src/types/plans.ts`
- Create: `packages/shared/src/goal-budget.ts`
- Test: `packages/shared/src/goal-budget.test.ts`
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `crates/host-core/src/plans/goals.rs` (shared Host-side budget validation/defaulting for settings reads and approval snapshots)
- Modify: `crates/host-core/src/plans.rs`
- Modify: `crates/host-core/src/rpc/mod.rs`
- Test: `crates/host-core/src/rpc/mod.rs`
- Test: `apps/desktop/test/settings-roundtrip.test.mjs` or a focused settings test

**Interfaces:**
- Add optional `AppSettings.goalBudgetDefaults` using the existing Goal budget shape.
- Shared `isGoalBudget` / `normalizeGoalBudgetDefaults` keep renderer validation and fallback defaults in one place.
- `normalizeSettings` must produce an effective default object when the field is absent or invalid.
- Host `settings.set` must reject malformed nested values and Host `settings.get` must return normalized defaults.

- [x] **Step 1: Add failing shared tests** asserting default values (`8`, `250000`, `3600000`, unlimited `true`) and the finite token, round, and time boundaries.
- [x] **Step 2: Run the focused shared test and verify it fails** because no shared Goal budget validator/default normalizer exists.
- [x] **Step 3: Add `GoalBudget` default constants and `isGoalBudget` / `normalizeGoalBudgetDefaults`** while keeping `AppSettings.goalBudgetDefaults` optional for old clients and stored profiles.
- [x] **Step 4: Add failing Host settings tests** for absent/default values, accepted boundaries, and rejection of wrong types, out-of-range rounds/time, zero/negative/fractional/unsafe tokens, and non-boolean unlimited flags.
- [x] **Step 5: Run the focused Host settings tests and verify they fail** because Host settings do not yet normalize or validate the new field.
- [x] **Step 6: Add Host normalization/validation** with the same bounds and defaults; malformed values fall back on reads, while writes reject invalid values without replacing the current object.
- [x] **Step 7: Run focused shared, Host, and desktop settings tests** and verify all pass.

### Task 2: Snapshot defaults into each newly approved Goal

**Files:**
- Modify: `crates/host-core/src/plans/goals.rs`
- Modify: `crates/host-core/src/plans/tests.rs`
- Modify: `crates/host-core/src/config_sync/domains.rs`
- Modify: `crates/host-core/src/config_sync/engine.rs`
- Test: `crates/host-core/src/config_sync/domains.rs`
- Test: `crates/host-core/src/config_sync/engine.rs`

**Interfaces:**
- Keep the current Goal approval and execution RPC contracts unchanged.
- `create_goal_tx` reads the latest stored app defaults in the same Host-owned transaction and inserts them into the newly-created lifecycle.
- Missing defaults use the documented new defaults; existing lifecycle rows are never updated by settings writes.
- Add `goalBudgetDefaults` to portable application preference capture/apply allowlists.

- [x] **Step 1: Add failing Host lifecycle tests** for a custom default snapshot, unlimited-by-default snapshot when the setting is absent, and a settings change that leaves an already-created Goal unchanged.
- [x] **Step 2: Run the focused Goal lifecycle tests and verify they fail** because Goal creation still uses constants.
- [x] **Step 3: Read/normalize the app settings in the Host approval transaction** and insert its budget snapshot into the new lifecycle, explicitly including `token_budget_unlimited`.
- [x] **Step 4: Add portable-settings allowlist assertions and verify application config capture/apply preserves the new field.**
- [x] **Step 5: Run focused Host lifecycle and config-sync tests** and verify all pass without a schema bump.

### Task 3: Expose Goal defaults in AI System Settings

**Files:**
- Create: `apps/desktop/src/features/settings/GoalBudgetDefaultsCard.tsx`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/lib/settings-search.ts`
- Modify: `packages/i18n/src/locales/*/index.ts`
- Test: `apps/desktop/test/goal-budget-defaults-settings.test.mjs`
- Test: `apps/desktop/test/settings-general.test.mjs`

**Interfaces:**
- Card accepts `settings: AppSettings` and `saveSettings(patch: Partial<AppSettings>)`.
- System Settings owns defaults for future Goals only; the existing Goal bar remains the editor for a specific Goal.
- Use shared `SettingsCard`, `SettingsRow`, `Field`, `Input`, and `SettingsToggle` primitives.

- [x] **Step 1: Extract the existing Goal-budget form parser into a pure Renderer helper using the shared validator, then add a failing settings-surface test** proving the AI destination contains the Goal defaults card, all three limits, unlimited toggle, default values, retained finite value, save action, and searchable localized labels.
- [x] **Step 2: Run the focused renderer settings test and verify it fails** because there is no Goal defaults card.
- [x] **Step 3: Implement an isolated draft/save card** with localized validation, an enabled finite token field while unlimited is on, and a clear explanation that settings affect new approved Goals only.
- [x] **Step 4: Wire the card into the existing AI Settings page and settings search; add aligned strings to every shipped locale.**
- [x] **Step 5: Run the focused settings component/source tests, i18n consistency checks, and desktop typecheck.**

### Task 4: Update product decisions, specs, and E2E acceptance

**Files:**
- Modify: `docs/adr/0344-configurable-goal-cycle-budgets.md`
- Create: `docs/adr/0345-goal-budget-defaults-in-system-settings.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/spec/00-baseline.md`
- Modify: `docs/spec/03-runtime/02-agent-runtime.md`
- Modify: `docs/spec/03-runtime/04-data-storage.md`
- Modify: `docs/spec/03-runtime/06-host-rpc-protocol.md`
- Modify: `docs/spec/04-ux/06-settings-ia.md`
- Modify: `docs/spec/04-ux/08-component-spec.md`
- Modify: `docs/spec/04-ux/09-interaction-patterns.md`
- Modify: `docs/spec/06-delivery/04-e2e-test-plan.md`
- Modify: `docs/spec/08-meta/decisions-log.md`
- Test: `scripts/e2e-plan-ui.mjs` / `apps/desktop/test/plan-ui-probe-contract.test.mjs` as needed

- [x] **Step 1: Update the existing Goal lifecycle E2E assertions** from finite-token defaults to unlimited-token defaults.
- [x] **Step 2: Extend `E2E-goal-budget-editor`** to use the rendered AI Settings controls to save defaults, approve a fresh Goal and assert its Host snapshot, change the defaults and assert an existing Goal remains unchanged, then continue the per-Goal edit/rehydrate flow.
- [x] **Step 3: Run the focused E2E against an isolated profile** with no real provider credentials.
- [x] **Step 4: Record the default change in a new ADR/decision-log entry** that amends D684/ADR 0344, and update settings/storage/runtime/UX specs and Goal E2E scenarios.
- [x] **Step 5: Run required focused tests and E2E, then review the full diff and `pnpm check:pr-base`.**
- [ ] **Step 6: Commit only if requested; push/open a PR only under the user's existing remote-delivery instruction and after all required gates pass.**
