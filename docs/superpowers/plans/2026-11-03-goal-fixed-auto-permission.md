# Goal Fixed Auto Permission Implementation Plan

> **For agentic workers:** This plan is being executed directly in the dedicated request worktree.

**Goal:** Make Goal's fixed Auto Composer state effective in Host authorization before approval without changing the persisted session permission or weakening contract-mode denials.

**Architecture:** Host-core will resolve the effective permission mode from the durable session mode, stored session setting, global default, and any explicit delegated permission scope. Durable Goal mode selects Auto for its contract phase; approval still transitions to Agent with the mode selected on the Goal approval card. Renderer and sidecar values remain non-authoritative.

**Tech Stack:** Rust host-core, TypeScript/React renderer, Node tests, Markdown specifications.

**Spec:** ADR 0343; docs/spec/03-runtime/03-tools-and-permissions.md; docs/spec/04-ux/03-permission-ux.md; E2E-019c and E2E-121.

## Global Constraints

- Goal's Host-owned tool allowlist and hard-deny order remain unchanged.
- Goal's fixed Auto posture does not persistently change the session permission override.
- Plan and Agent continue to use session override, then global default, then Ask.
- Goal approval continues to select the post-approval Agent permission mode.
- No IPC/RPC schema, database schema, or transcript format changes.
- Every permission decision is resolved in host-core.

## Review Focus

- An inherited Goal session under global Ask auto-allows eligible Goal calls while its stored permission remains inherit.
- A Goal session override of Ask or Accept edits does not override Goal's fixed Auto posture.
- An explicit delegated permission scope retains its existing precedence.
- Goal hard-denied tools remain denied under fixed Auto.
- Switching back to Agent restores the unchanged session/global permission behavior.
- Goal approval applies the selected mode to the post-approval Agent execution.

---

### Task 1: Host-owned fixed Auto resolution

**Files:**
- Modify: crates/host-core/src/permissions.rs
- Modify: crates/host-core/src/rpc/mod.rs
- Test: crates/host-core/src/permissions.rs
- Test: crates/host-core/src/rpc/mod.rs

- [x] Add an RPC regression test for an inherited Goal session with global Ask.
- [x] Run the test before the fix and confirm the Host reports a permission request.
- [x] Resolve Goal's fixed Auto posture centrally and use it from both permission evaluation and tool execution.
- [x] Make the RPC regression drain queued notifications safely when execution and channel closure complete together under parallel test load.
- [x] Run focused Goal and Plan authorization tests.
- [x] Run host-core test suite, formatting, and clippy.

### Task 2: Keep the permission contract synchronized

**Files:**
- Create: docs/adr/0343-goal-fixed-auto-permission-before-approval.md
- Modify: docs/adr/README.md
- Modify: docs/spec/00-baseline.md
- Modify: docs/spec/03-runtime/03-tools-and-permissions.md
- Modify: docs/spec/03-runtime/05-host-core-rust.md
- Modify: docs/spec/03-runtime/06-host-rpc-protocol.md
- Modify: docs/spec/04-ux/03-permission-ux.md
- Modify: docs/spec/04-ux/06-settings-ia.md
- Modify: docs/spec/04-ux/08-component-spec.md
- Modify: docs/spec/04-ux/09-interaction-patterns.md
- Modify: docs/spec/06-delivery/02-acceptance-criteria.md
- Modify: docs/spec/06-delivery/04-e2e-test-plan.md
- Modify: docs/spec/08-meta/decisions-log.md

- [x] Distinguish Goal's pre-approval fixed Auto posture from the approval-selected Agent permission.
- [x] Record that stored session permissions are not changed by entering or leaving Goal.
- [x] Update E2E-019c and E2E-121 to cover the visible Goal → Host behavior.
- [x] Verify cross-references and the ADR index.
