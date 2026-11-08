# Computer Use implementation evidence

This note records the current fork implementation and the evidence available
for it. It contains no captured screen contents, window titles, or credentials.

## Reliability follow-up — 2026-11-08

The Windows UIA mapper now recovers a small allowlist of semantic roles when a
provider reports a generic Pane: Win32 Button, Edit, Static, ComboBox, and
ListBox classes. A Button with TogglePattern is classified as a CheckBox. Other
unknown Pane classes remain Panes; role inference does not use labels or parent
classes. The isolated WinForms fixture now selects ten values in each of its
ComboBox and ListBox controls and checks the native value after every selection
and that the other controls were not modified.

| Check | Result |
|---|---|
| Windows Pane class-role unit test | Passed: known classes map to documented UIA role IDs; unknown classes and already-specific UIA roles remain unchanged. |
| Opt-in Windows UIA fixture | Passed: 50 exact target resolutions plus ten ComboBox selections and ten ListBox selections, with per-operation native-state readback and cross-control non-mutation checks. |
| Agent Runtime → Sidecar → Main tool → Host → Windows fixture | Initially passed for one turn with a loopback model; see the 2026-11-09 repeatability acceptance below for the expanded three-cycle run. |
| `cargo fmt --check` | Passed. |

This does not establish full Computer Use reliability. Target resolution was
repeated 50 times in the fixture's initial live state, not across varied window
or process states. The runtime path used a deterministic loopback model, not a
third-party model/provider. General action-specific postcondition guarantees
remain a separate implementation and acceptance item.

## Repeatability acceptance — 2026-11-09

Expanded the same Agent Runtime → Sidecar → Main tool → Host → Windows fixture
E2E to run three fresh Computer tool turns in one session. Each turn creates a
new Host grant, declares Computer in the conversation model's first request,
dispatches one UIA click, performs a second Host inspection, and revokes that
grant before the next cycle. The fixture changes a native accessible label and writes
the resulting state to a file; the harness checks the exact expected state
after every turn, so an earlier turn's state cannot satisfy a later turn.

| Check | Result |
|---|---|
| `pnpm test:e2e:computer-use-runtime` | Passed on the local Windows host: 3 Computer calls, 3 fresh grants, 3 UIA actions, 6 post/initial inspections, 3 revocations, and per-cycle native fixture state verified through `CU-RUNTIME-FIXTURE-CLICKED-3`. Both conversation and Computer model requests used the local loopback fixture. |
| Windows UIA fixture | Passed on the local Windows host: exact target resolution and control-value tests passed in 3.30 seconds. |
| `node --check scripts/e2e-computer-use-agent-runtime.mjs` and `git diff --check` | Passed before the repeated runtime E2E. |

This verifies repeated grant lifecycle and post-action state observation on one
stable target. It does not yet cover cold application restart, the target itself
becoming unavailable/reappearing, real provider/model routes, or action-specific
verified/dispatched/failed semantics in the product UI.

## Final-step observation — 2026-11-09

The bounded loop now re-inspects after every dispatched action even when that
action consumes the final step allowed for a tool call. Previously the loop
could return `step-limit` immediately after dispatch without ever obtaining the
resulting state. The step remains accurately labeled as dispatched; this change
ensures the final state is captured, but does not claim that arbitrary UI
actions are deterministically verified.

| Check | Result |
|---|---|
| `@pi-desktop/computer-use` tests | Passed: 42 tests, including a regression where the final action changes the fixture observation before `step-limit` is returned. |
| `@pi-desktop/computer-use` typecheck | Passed. |
| Repeated runtime E2E | Passed again after the loop change: three fresh turns still each dispatch, re-observe, verify the fixture state, and revoke. |
| Documentation checks | Passed: 89 English/Chinese pairs and 640 documentation pages. |
| Windows UIA target resolution and recovery | Passed: an unrelated isolated process/window was added then removed without invalidating the original exact ID; after closing that target and reopening a same-title fixture, the old ID stayed invalid and the replacement required a new ID. The fixture passed in 5.46 seconds. |

Generic action-specific result statuses and recovery under changing window/process
availability remain unfinished.

## Distinct model-route acceptance — 2026-11-09

The Agent Runtime E2E now binds the ordinary conversation to `deepseek-flash`
and the Computer Use setting to a separate provider/model binding,
`deepseek-v4-pro`. Both point only to the local loopback fixture; no external
account, credential, or live third-party request is used. The fixture asserts
the model ID on every request across all three consecutive Computer-use turns,
so this verifies application routing and tool-loop dispatch independently of
provider availability.

| Check | Result |
|---|---|
| `corepack pnpm test:e2e:computer-use-runtime` | Passed: six conversation requests used `deepseek-flash`; six Computer decision requests used `deepseek-v4-pro`; all three native UIA fixture actions, state readbacks, and grant revocations passed. |
| `git diff --check` | Passed. |

Live behavior across real provider routes and packaged desktop acceptance remain
separate acceptance gaps.

## Granted-window visual input acceptance — 2026-11-09

Extended the same three-cycle Windows UIA runtime scenario to select
`a11y-and-pixels`. The ordinary conversation remains on the text-only
`deepseek-v4-pro` fixture model while the separately configured Computer model
is image-capable `deepseek-flash`. The loopback endpoint asserts that all six
Computer decision requests contain an image block; the conversation requests
remain separately counted. The capture path resolves the Host-issued native
window ID and transmits only the bounded fixture-window thumbnail. No screenshot
is written to disk or sent outside the local fixture.

| Check | Result |
|---|---|
| `corepack pnpm test:e2e:computer-use-runtime` | Passed on Windows: 6/6 Computer decision requests included an image block; 6/6 conversation requests remained on the separate text-only model; all 3 UIA actions, post-action readbacks, and grant revocations passed. |

This proves the configured capture-and-transport path into an image-capable
Computer model, not that a live third-party model correctly interprets pixels.

## Text-only model with pixel capture — 2026-11-09

The same E2E investigation confirmed that `deepseek-v4-pro` publishes only text
input, while the pixel-enabled `deepseek-flash` route accepts the fixture image.
The local Computer tool now checks the resolved model's effective input
modalities before creating a Host grant. If pixel capture is selected for a
text-only model, it returns `COMPUTER_MODEL_VISION_REQUIRED` with a direction to
choose an image-capable Computer model or use accessibility-only capture. The
check does not block text-only models when accessibility-only mode is selected.

| Check | Result |
|---|---|
| Electron Main `agent-tool.test.ts` | Passed: 9 tests. The new regression confirms a text-only model is refused before grant creation/capture, while the supported image-input path continues to pass. |

The model capability comes from the resolved provider/model metadata. A
user-configured proxy should set its image-input override accurately; an
incorrect capability declaration cannot prove the upstream endpoint accepts
images.

The Computer Use Settings page now checks the selected model when pixel capture
is active and shows a localized warning for a known text-only model, or a
localized checking status while metadata is being looked up. The warning keeps
the existing capture choice intact so the user can switch the model or choose
accessibility-only capture. A pure selection test covers per-model override
precedence, provider-default fallback, and catalog fallback.

| Check | Result |
|---|---|
| Computer Use model vision capability tests | Passed: 3 tests covering explicit per-model image overrides, provider default-model capability, catalog fallback, and unknown model metadata. |
| Desktop TypeScript typecheck | Passed. |
| i18n TypeScript typecheck | Passed. |

## Follow-up acceptance — 2026-11-08

The current target-selection regression is covered at both the model-loop and
native Host boundaries. The loop accepts only a host-issued window ID or the
exact legacy display string for an item in the current observation, then always
sends the canonical ID to Host. The Windows backend accepts the exact live ID
and rejects the same ID with an app/title suffix.

| Check | Result |
|---|---|
| `@pi-desktop/computer-use` tests and typecheck | Passed: 41 tests. |
| Electron Main `agent-tool.test.ts` | Passed: 8 tests, including a scripted model/Host-RPC loop that confirms a second Host observation exposes the changed fixture state before the model returns `done`. |
| Agent Runtime Computer tool registration | Passed: 1 targeted test; 407 unrelated tests skipped by the filter. Computer is present in the enabled Agent tool set and absent in disabled/Plan/Goal cases. |
| Host Core `computer::` tests | Passed: 49; 1 interactive Windows fixture test ignored by the normal suite. |
| `cargo fmt --check` | Passed. |
| Opt-in Windows native UIA fixture: `windows_backend_drives_only_the_isolated_fixture_window` | Passed on this Windows host. It verifies exact target ID resolution and refusal of an ID polluted with the display label, then checks click, Unicode text, ComboBox selection, and ListBox selection against fixture state. |

These checks establish a repeatable scripted-model and isolated-Windows-fixture
baseline, not a live third-party model/provider or packaged-app acceptance. The
next acceptance gap is running the same scenarios through the rebuilt desktop
app with a recorded provider route and Host runtime logs, then retaining the
run as an automated regression where the harness permits it.

## Native Windows input coverage — 2026-11-09

The opt-in isolated WinForms fixture now exercises each Windows pointer action
through the native UIA backend and checks an effect reported by the fixture,
not merely a successful dispatch: double-click and right-click event handlers,
hover entry, drag movement plus release, and a nonzero UIA ScrollPattern value.
The existing click, Unicode text, key chord, ComboBox, and ListBox checks remain
in the same fixture. The test is still ignored by ordinary CI because it opens
a visible window and requires an interactive Windows desktop.

| Check | Result |
|---|---|
| Opt-in Windows native UIA fixture | Passed locally on 2026-11-09; verifies double-click, right-click, hover, drag movement/release, and scrolling using fixture-owned state. |

This is native fixture acceptance, not acceptance for arbitrary applications or
the packaged desktop app. The rebuilt-app/provider-route acceptance gap above
remains open.

## No-op action recovery — 2026-11-09

The opt-in `scripts/e2e-computer-use-agent-runtime.mjs` acceptance was extended
so its deterministic local model first issues a valid hover that cannot change
the fixture, then must use the newly observed UIA node to click the button and
confirm the changed state. It runs the real Electron Agent Sidecar, Rust Host,
Host RPC and Windows UIA fixture, while only the two local loopback model
endpoints are deterministic fixtures. Three fresh-grant cycles passed, with
the expected `hover → click → done` sequence and three independent final state
checks. The test also now extracts the UID from the exact current node line;
this avoids selecting stale or unrelated UIDs from prior observations or action
history.

| Check | Result |
|---|---|
| `node scripts/e2e-computer-use-agent-runtime.mjs` | Passed locally on 2026-11-09; 3 cycles, 9 Computer-model requests, 6 native actions, 9 Host observations, 9 granted-window images, and final fixture state `CU-RUNTIME-FIXTURE-CLICKED-3`. |

This remains local interactive Windows fixture acceptance. It does not claim
acceptance across arbitrary providers or from the packaged end-user application.

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
| macOS backend | An `AXUIElement` backend exists in source; this evidence set does not contain macOS device acceptance. |
| Linux/X11 backend | X11 identity/geometry plus AT-SPI inspection and supported actions. Passed the GTK/Xvfb/dbus-run-session CI fixture on 2026-11-09 (workflow run `42525594538`): target discovery, AT-SPI control inspection, button invocation, and changed accessible status label. Wayland input remains explicitly unsupported. |
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
| Current Windows host-core targeted tests | Passed: 39 passed, 0 failed, 1 ignored. Linux-only backend tests are compiled/run by the Linux CI job, not this Windows result. |
| Linux GTK/AT-SPI fixture acceptance | Passed in CI workflow run `42525594538`. It verifies X11 target discovery, AT-SPI inspection, button invocation, and a changed accessible status label. |
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
- Add macOS device acceptance before claiming macOS runtime support; Linux/X11 CI evidence does not establish Wayland or arbitrary-toolkit coverage.
