# Pi 1.5.2 adoption

## Scope

Align all direct Pi dependencies and exact release-age exclusions at 1.5.2. Rebase the existing patches onto the 1.5.2 package tarballs. Keep the `pi-agent-core` patch: although the adapter emits `hosted_search_update`, the 1.5.2 event loop still drops it unless the desktop forwards it; the same patch preserves typed local request error details. This is a targeted package adoption, not a merge of the upstream repository.

## Adopted fixes

- Preserve the project's provider-billed cost provenance, served-model reporting, hosted-search round-trip and compaction handling, DeepSeek compatibility, and model-specific context estimates while rebasing the package patches.
- Preserve the desktop's hosted-search streaming updates and structured local request failures in `pi-agent-core`.
- Include upstream 1.5.2-era fixes for retrying transient `Connection closed.` provider failures, preserving root `additionalProperties` in non-strict Anthropic tool schemas, and falling back from strict tool schemas containing untyped nodes.
- Fix long single-line output tail truncation in the bundled Pi output accumulator.
- Correct the project's own extension process runner so a child terminated by an external signal cannot resolve as a successful exit; POSIX signal exits map to `128 + signal number`.
- Keep Anthropic message threads endpoint-gated. Do not enable them for arbitrary gateways; gateways must explicitly declare support for the `thread` field.

## Explicitly not transplanted

- Pi `AgentSession` MCP `tool_search` restore behavior is not copied into the desktop's custom Agent Runtime. The app does not use Pi's `AgentSession` as its runtime; its tool activation and resume path is independently implemented and needs its own regressions.
- Pi CLI read/grep/find behavior and missing-working-directory session forking are not assumed to describe the desktop's Host tools or SQLite sessions.

## Validation

- `corepack pnpm install --offline`: passed; exact pnpm lockfile regenerated and patched packages installed.
- `node scripts/check-pi-dependencies.mjs`: passed; package manifests and installed direct Pi instances are 1.5.2.
- `node scripts/check-pi-patches.mjs`: passed; all three Pi patches are mapped, installed, and represented in the lockfile.
- `node --test scripts/pi-patch-hash.test.mjs`: 7 passed.
- Focused Pi and dependent runtime regressions (`pi-152-upstream-regressions`, hosted-search contract/estimation, client identity, managed extension process): 60 passed, 1 skipped (POSIX-only signal case on Windows).
- Agent Runtime typecheck and build: passed.
- Desktop typecheck: currently blocked by unrelated pre-existing worktree file `apps/desktop/src/components/workpanel/ArtifactsTab.tsx`, which calls missing `window.pi.listArtifacts` and has an implicit-any callback. No desktop build/rebuild was claimed.
- A broad Vitest invocation was stopped after it picked up the whole monorepo and surfaced unrelated failures in other in-progress worktree changes; those are not counted as upgrade validation. The focused upgrade suites above are the acceptance evidence for this dependency change.

The 1.5.0 adoption results in `pi-150-adoption.md` are historical and are not evidence for this upgrade.

## Rollback

Revert the Pi manifests, lockfile, release-age exclusions, versioned patches, managed-exec signal handling/test, compatibility docs, and synchronized tech-stack specs together. Do not mix 1.5.0 packages with the 1.5.2 patches.
