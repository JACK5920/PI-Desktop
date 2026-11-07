# Computer Use implementation evidence

This note records the current fork implementation and the evidence available
for it. It contains no captured screen contents, window titles, or credentials.

## Implemented surfaces

| Surface | Current state |
|---|---|
| Shared contracts and settings | Implemented in `packages/shared/src/computer-use.ts`; disabled by default and gated by the user's Computer Use setting. |
| Windows backend | UI Automation backend in `crates/host-core/src/computer/`; bounded reads/actions are limited to the host's validated current target. |
| Host grants and refusal policy | Host-owned grant lifecycle, target validation, cooldown after Stop, audit metadata, and refusal paths are covered by Host Core tests. |
| Agent tool and bounded loop | `packages/computer-use/` and `packages/agent-runtime/src/computer-use/`; runs through Host RPC and the configured Computer Use model. |
| Settings and live status | Settings allow explicit enablement/model selection, accessibility-only or granted-window pixels, and bounded parameters; the live widget exposes current grant state, capture mode, and Stop. |
| Granted-window pixel capture | Chromium captures only the native window id in the Host grant; unmatched sources fail closed, and captured bytes are sent only to the separately bound Computer Use model. |
| Cursor overlay | A click-through, non-authoritative overlay follows Host-validated action coordinates and is destroyed when the grant ends. |
| macOS/Linux backends | Not implemented/accepted in this fork. |
| Pixel capture and cursor overlay | Windows path implemented; no packaged-app or multi-display/DPI acceptance yet. |
| Packaged desktop acceptance | Not complete. |

## Automated evidence

The following checks were run in the current worktree during this task:

| Check | Result |
|---|---|
| `node packages/shared/node_modules/vitest/vitest.mjs run packages/shared/src/computer-use.test.ts` | Passed (shared contract tests). |
| Agent Runtime targeted Vitest run of background jobs, text tool calls, malformed calls, output cap, and runtime | Passed (481 tests). |
| `node node_modules/vitest/vitest.mjs run src --config vitest.config.ts` in `packages/computer-use` | Passed (31 loop/schema tests). |
| `node --test apps/desktop/test/computer-use-settings-user-path.test.mjs` | Passed (settings, live Stop, and owner-scoped cancellation path). |
| Electron Computer Use tool tests | Passed (pixel-mode forwarding, exact window-source matching, cursor event forwarding, and grant revoke). |
| `cargo test -p host-core --locked` | Previously passed in this worktree: 1,220 passed, 0 failed, 2 ignored. |
| `cargo clippy -p host-core --all-targets` | Previously passed; one pre-existing `filter_next` warning in `transcripts.rs`. |
| Windows UIA fixture probe | Previously passed on this interactive Windows host, targeting only its own temporary harmless fixture window. |

The recursive `build:js` gate passed after the documentation links were
corrected. VitePress still reports the repository's existing large-chunk and
unsupported `gitignore` syntax-highlighting warnings; these do not fail the
build.

The Windows fixture probe is not evidence that arbitrary applications have
been accepted. It exercises only a temporary fixture window. The source-level
and automated checks do not establish packaged-app behavior, pixel capture,
macOS behavior, or a live model/provider run.

## Remaining acceptance

- Rerun `corepack pnpm docs:build` after the broken links are fixed.
- Complete isolated packaged Electron acceptance for settings, grant lifecycle,
  pixel capture, cursor overlay, Stop, and cancellation.
- Keep the native Windows fixture opt-in because it opens a visible window.
- Add or run platform acceptance before claiming macOS or Linux support.
