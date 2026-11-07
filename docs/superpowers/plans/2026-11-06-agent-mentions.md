# Agent Mention Implementation Plan

> This plan is the first isolated batch in the approved selective-upstream adoption roadmap.

**Goal:** Let users explicitly mention an existing subagent as `@name` in the composer and preserve the typed request while prompting the current runtime to call `Task` for that named agent.

**Architecture:** Reuse the existing composer autocomplete, inline reference-chip serialization, `Task` tool, transcript metadata and Host record-meta persistence. Resolve mentions at send time against the launch's subagent catalog; do not add a second execution path, new RPC, database migration or plugin API.

**Tech Stack:** TypeScript, React, Electron main IPC, shared prompt helpers, Rust host-core record metadata, Vitest and Node/Electron user-path tests.

**Spec:** ADR 0348, docs/spec/04-ux/08-component-spec.md, docs/spec/06-delivery/04-e2e-test-plan.md.

## Global Constraints

- Only Agent mode offers and resolves subagent mentions; Plan and Goal leave text literal.
- Resolve only names in the current launch catalog; a local workspace file/folder with the same name wins.
- Preserve existing file-reference serialization byte-for-byte.
- Keep the user's typed form in the transcript; only model-facing prompt content is augmented.
- No database migration, new RPC, Plugin SDK change or automatic Task execution.

## Review Focus

- Unknown, malformed, e-mail-like, path-like and Unicode-adjacent `@` tokens remain literal.
- A local root file/folder shadows a subagent with the same name.
- Agent + Skill composition and leading slash/template command behavior remain stable.
- Stop/retry restores the visible typed command rather than augmented model prompt.
- Invalid persisted offsets render as plain text; historical rows without mentions remain unchanged.

### Task 1: Parser, serialization and send-time resolver

- Add failing tests for catalog-only token matching, word boundaries, chip serialization, file shadowing, mode gating and Skill/template interaction.
- Implement shared parser/prompt composition and Electron send-time resolution.
- Verify shared unit tests and real prompt-channel tests.

### Task 2: Composer UI, persistence and transcript presentation

- Add failing renderer journey for Agent-only catalog loading, grouped autocomplete, root shadowing, atomic chip and send serialization.
- Implement agent completion, chip metadata, transcript rendering and Host record-meta round-trip.
- Verify smart Stop restores typed text and legacy rows remain unchanged.

### Task 3: Specs, ADR and gates

- Add ADR 0348 and synchronize English/Chinese component and E2E documentation.
- Run targeted shared, Host, Electron user-path tests, desktop typecheck and relevant lint/build checks.
- Review diff, refresh against latest origin/main, then commit/push/open PR under repository gates.
