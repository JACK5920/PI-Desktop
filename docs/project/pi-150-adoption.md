# Pi 1.5.0 adoption

## Scope

Pin Agent Runtime's `pi-agent-core`, `pi-ai`, and `pi-coding-agent`, plus Desktop's `pi-ai` and `pi-mcp`, to exactly 1.5.0. Keep the Pi release group aligned through the lockfile, exact release-age exclusions (including `pi-schema`), and package patches. No database schema or Host RPC migration is introduced by this runtime upgrade.

## Compatibility and adopted behavior

- Rebased the three pnpm patches onto Pi 1.5.0. Agent Runtime imports TypeBox builders from its existing direct `typebox` dependency because `pi-ai` no longer re-exports them.
- Keep provider-billed cost marked `reported`, distinct from catalog-rate estimates, and preserve that provenance through transcript reconstruction.
- Persist the provider-reported concrete served model only when it is bounded, printable, and differs from the requested model; expose both values accessibly in the transcript model chip.
- Extension `pi.exec()` uses streaming UTF-8 decoders and a combined stdout/stderr byte cap; truncation is explicit and non-successful, spawn failures resolve as failed commands.
- Zhipu/Z.ai plan usage-limit code 1308 is terminal rather than retried as a transient 429.
- The four transcript/composer reliability regressions are specified with their isolated tests in the product E2E plan.

## Validation status

Local dependency installation, Pi dependency/patch gates, and all seven patch-hash fixture tests pass. Agent Runtime typecheck and its full suite pass (122 files, 1,773 tests passed, one skipped); Desktop typecheck, Electron Vite build, lint, locale validation, and docs validation pass. Focused Desktop regressions pass (21 tests), shared compaction tests pass (15), and the targeted Host tail-window test passes. The full Desktop and Host suites were not run; `cargo fmt --check` still reports formatting differences in pre-existing dirty Computer Use files, so do not treat this record as a full-repository release sign-off.

The separate user-defined staged Mode workflow has not been implemented here. It adds a new Host-persisted workflow subsystem and overlaps this fork's existing Goal lifecycle, budgets, and runtime integration; it requires a compatibility design and its own complete acceptance, rather than copying the upstream commit over local behavior.

The upstream 1.5.0 adoption validation record is not reused as evidence for this checkout. This checkout has additional local changes and must be validated independently.

## Rollback

Roll back manifests, lockfile, release-age exclusions, three versioned package patches, compatibility code, tests, and synchronized specs together. Do not mix a patched 1.4.0 Pi package with the 1.5.0 release group.
