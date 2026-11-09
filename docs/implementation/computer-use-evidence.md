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
verified/dispatched/failed semantics in the product UI at the time of this
acceptance. The completion evidence follow-up below adds explicit dispatch,
observation, and completion states.

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

At the time of this checkpoint, generic action-specific result statuses and
recovery under changing window/process availability remained unfinished.

## Agent Runtime Computer Use protocol matrix — 2026-11-09

The repeatable Windows Agent → Computer → Host → UIA fixture now runs the same
three-turn, distinct-chat/control-model scenario across four provider wire
formats: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and
Google Generative AI, in both accessibility-only and pixel-capture modes. Run
the full matrix with
`node scripts/e2e-computer-use-protocol-matrix.mjs`, or invoke one format by
setting `PI_COMPUTER_E2E_API_STYLE=<style>` and running
`node scripts/e2e-computer-use-agent-runtime.mjs`; add
`PI_COMPUTER_E2E_CAPTURE_MODE=pixels` to select pixel capture. The matrix uses
a local fake endpoint and an isolated WinForms window; it creates no provider
credentials and does not call a real model provider. It does not save screenshots.

For each protocol the server asserts the adapter's actual request path and
wire-format tool declaration, then returns a Computer tool call. The separately
configured `deepseek-flash` Computer model receives the current pinned-window
observation and returns `hover → click → done`; the Host re-inspects after each
action, checks fresh completion evidence, and revokes the grant before the next
cycle. The native fixture's final state is read from its own file after every
cycle.

| Check | Result |
|---|---|
| `node scripts/e2e-computer-use-protocol-matrix.mjs` | Passed 8/8 combinations: 4 protocols × 2 capture modes. Every combination completed 3 fresh grant cycles, 6 UIA actions, 9 Computer decisions, 12 Host inspections, 6 conversation requests with Computer declared, and 3 revocations; all cycles verified native fixture state. |
| Pixel transport across protocols | Passed: 9/9 Computer decisions per protocol received non-empty PNG payloads (36/36 total) in OpenAI Chat `image_url`, Responses `input_image`, Anthropic base64 image source, and Gemini `inlineData` forms. Only image MIME/byte counts were reported; no image files were saved. |

This is protocol-adapter and local-runtime acceptance, not proof that real
Anthropic/Gemini/OpenAI accounts or arbitrary compatible gateways behave the
same, nor that those models interpret the transmitted pixels correctly.

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

## Completion citation and live status — 2026-11-09

The loop now treats model completion as a claim that needs a current, checkable
UIA citation. A `done` answer includes one to eight exact element UIDs from the
latest observation. After the model responds, the loop re-observes the same
Host-bound target, then accepts the answer only if each cited UID is still
present and its value-free UIA shape (role, label, value-presence flag, enabled
and focus state, bounds, parent, and supported actions) still matches the
decision observation. The whole-tree observation diff separately marks each
action as `dispatched`, `observed-change`, or `observed-no-change`.

If citations are absent or stale, the loop refreshes the pinned target and asks
again once without replaying any action. A second unverifiable `done` returns an
explicit `unverified` result, not success. The Agent tool returns it as an
error-result so the conversation cannot silently treat it as a successful tool
call. Accessibility values and screenshot bytes are excluded from the UIA diff;
pixel-only claims without current structured UIA references remain unverified.
The accepted state is explicitly **model-confirmed against current UIA evidence**,
not an independent semantic proof that the requested task is correct.

The live widget now shows dispatch/observation/completion-verification state and
distinguishes `unverified` from `completed`. The recent activity trail updates
the same step in place as the Host dispatch and post-action observation arrive.
When pixel capture is enabled, the widget also distinguishes a screenshot
attached for the current step from an unavailable screenshot; in the latter
case the model receives an explicit instruction to rely only on UIA and not
claim visual inspection. Window-scoped grants expose only their pinned window
in model context; desktop-scoped grants retain the desktop window list.

| Check | Result |
|---|---|
| `@pi-desktop/computer-use` tests | Passed: 51 tests, including stale UID rejection, UI change during model response, screenshot-only unverified completion, missing-evidence `unverified`, no action replay, observed-change/no-change states, and explicit unavailable-pixel guidance. |
| Electron Main Computer Use tests | Passed: 12 tests, including unverified tool result, no input dispatch, grant revocation, and surfaced capture success/unavailability. |
| `@pi-desktop/desktop` and `@pi-desktop/i18n` typecheck | Passed. |
| `node scripts/e2e-computer-use-agent-runtime.mjs` | UIA mode passed in 3 consecutive runs; opt-in pixel mode (`PI_COMPUTER_E2E_CAPTURE_MODE=pixels`) passed in 3 consecutive runs after the target-only context and exact-current-image assertions. Each run used 3 fresh grants, 6 native UIA actions, 9 loopback Computer-model decisions, 12 Host inspections including fresh completion checks, and three exact fixture-state readbacks. Pixel runs delivered 9 non-empty PNG data URLs to the dedicated loopback Computer model (129,560–136,132 base64 characters per run); no screenshots were saved. The fixture wrapper pins each grant to the exact Host-issued disposable-window target ID, asserts the Host returns `scope=window`, and checks that each model observation contains only that pinned window. Ordinary conversation and Computer model used distinct fixture routes. |
| `node scripts/e2e-computer-use-settings.mjs` | Passed in isolated Electron: settings writes, live dispatch, model-confirmed UIA status, visible "Screenshot unavailable; using accessibility only" fallback, and Stop request ownership. |
| `git diff --check` | Passed. |

These tests use a deterministic local model endpoint and an isolated WinForms
fixture. They do not establish semantic verification across arbitrary models,
arbitrary toolkits, or the packaged user application.

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
| Pixel capture and cursor overlay | Windows path packaged-app smoke acceptance passed on the primary display (two-point composite sampling; no image saved); multi-display/DPI acceptance remains open. |
| Packaged desktop acceptance | Startup smoke passed. This earlier matrix snapshot predates the packaged interaction and Stop/overlay E2E results recorded below. |

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
| Repeated Windows target-selection baseline | Passed in 3 independent test-process runs on 2026-11-09 using `cargo test -p host-core --locked computer::tests::windows_backend_repeats_target_binding_under_three_start_conditions -- --ignored --exact --nocapture`: each run covered 50 exact-ID pinned grants in a fresh test process, 50 alternating binds while two isolated target windows and a third process repeatedly opened/closed transient windows, then 10 create/revoke setup grants followed by 50 more binds. Across 480 target-resolution policy calls (450 scenario trials + 30 churn setup grants), first-attempt failures = 0, retries = 0, unrecovered failures = 0, late recoveries = 0, target mismatches = 0. The test cleans all fixture processes, scripts, and readiness markers. |

The recursive `build:js` gate passed after the documentation links were
corrected. VitePress still reports the repository's existing large-chunk and
unsupported `gitignore` syntax-highlighting warnings; these do not fail the
build.

The Windows fixture probe is not evidence that arbitrary applications have
been accepted. It exercises only a temporary fixture window. The source-level
and automated checks do not establish packaged Computer Use interaction,
macOS device behavior, or a live provider run.

The initial native action fixture incorrectly used a WinForms `Label`'s
`MouseDoubleClick` callback as the double-click postcondition. Isolated Windows
message diagnostics showed the control received the double-click message, but
that Label did not raise the callback; those failures did not establish a
backend dispatch defect. The fixture now uses a dedicated, compact ListView and
observes its `ItemActivate` counter after every Host backend action. The
`windows_backend_drives_only_the_isolated_fixture_window` acceptance passed in
three independent Windows test-process runs: 50 double-click activations per
run, 150 total, with each counter increment observed exactly once and no
missed activations. Right-click remains independently checked against its
fixture event. This proves the action path against this WinForms ListView
fixture only; it does not establish behavior for every UI framework/control or
action-specific product status guarantees.

Current Windows rerun of `cargo test -p host-core --locked
computer::tests::windows_backend_drives_only_the_isolated_fixture_window --
--ignored --exact --nocapture` passed (1 test, 23.01 seconds). The isolated
WinForms fixture exercises click, double-click, right-click, hover, drag,
scroll, Unicode `type_text`, literal `press_keys`, repeated ComboBox and
ListBox selection with native state readback, then stale-target rejection
after the fixture window is closed and replaced. This is a local device pass
for these specific controls and does not generalize to all Windows apps.

The Agent→Host→UIA completion-evidence fixture defaults to accessibility-only
capture so UIA assertions stay independent. An initial opt-in pixel run
revealed a harness flaw: its desktop grant was not pinned to the test window,
so the model received the current frontmost desktop observation rather than
the fixture control. This was target-selection drift in the test setup, not
proof of a Windows Graphics Capture failure. The fixture now passes the exact
Host-issued fixture target ID to each grant; opt-in pixel mode then passed
three independent runs and delivered non-empty images to the local
vision-capable model endpoint. The standalone capture matcher test still
verifies that a missing exact HWND source does not fall back to another window.

## Packaged Windows startup smoke — 2026-11-09

The unpacked Electron application was rebuilt after generating the Agent
Runtime bundle (`packages/agent-runtime/dist-bundle`). An initial package
attempt without that bundle logged a missing-source warning; the bundle was
generated with `node packages/agent-runtime/scripts/bundle.mjs` and packaging
was repeated. The resulting executable is
`apps/desktop/release/win-unpacked/PI-Desktop.exe`.

The packaged executable was launched with both `--user-data-dir` and
`PI_DESKTOP_DATA_DIR` set to the temporary profile
`E:\\PI-Desktop-dev\\.artifacts\\packaged-smoke`; no installed user's profile
or database was used. The top-level window reported `PI-Desktop`, responded to
window queries, and isolated logs recorded successful host-core handshake,
Agent Sidecar configuration, and scheduled-runner startup. A second launch
used a separate throwaway profile and inspected the actual packaged renderer
through its temporary local DevTools endpoint: the `window.piDesktop` bridge
was present, Windows UIA and capture capability probes both returned
`granted`, and `computerGrantDescribe` correctly reported no active grant. A
Computer Use enablement/pixel-mode settings write was then read back through
the packaged app's own settings IPC. No model was configured and no action or
capture was started in this settings-only check. Both app processes were
closed, and both temporary profiles removed. The unpacked build output remains
in the development directory.

At the time of this settings-only smoke check, packaged Computer Use interaction
acceptance had not yet been run. The later “Packaged Windows Computer Use
interaction E2E” section below records the subsequent packaged interaction run
and its remaining scope.

## Remaining acceptance

- The automated primary-display composite smoke check below passed twice; still
  perform human visual QA and test multi-display/DPI placement on suitable
  hardware. Simulated DPI-coordinate coverage is recorded below. Do not persist
  desktop screenshots.
- Keep the native Windows fixture opt-in because it opens a visible window.
- Add macOS device acceptance before claiming macOS runtime support; Linux/X11 CI evidence does not establish Wayland or arbitrary-toolkit coverage.

## Documentation build — 2026-11-09

VitePress build passed on this checkout with `node ..\node_modules\vitepress\bin\vitepress.js build .` from `E:\PI-Desktop-dev\docs` (`vitepress v1.6.4`, build complete). The root `corepack pnpm docs:build` wrapper could not launch because the current PATH `pnpm` shim resolves to v11.7.0 while this repository pins 12.8.1; invoking the repository-installed VitePress binary directly completed the same docs build without changing package-manager configuration.

## Packaged Windows Computer Use interaction E2E — 2026-11-09

The unpacked Release build was refreshed after `cargo build --release -p host-core --locked`; the packaged `resources/bin/pi-desktop-host-core.exe` has the same 2026-11-09 build timestamp as `target/release/pi-desktop-host-core.exe`. A local-only fake OpenAI-compatible endpoint and a disposable WinForms fixture were used with a fresh profile/data directory under `.artifacts`. No external provider was contacted, no screenshot file was saved, and the test fixture was the only target window acted on.

The test exercised the packaged renderer and Electron IPC end to end: create separate chat and Computer model providers, enable Computer Use with pixel capture, read settings back, create a new agent session, send a real prompt, and verify that the chat-model request declared `Computer`. The Computer model first received a non-target current-window observation, returned a switch using the exact quoted Host window ID, then received target-bound observations including image payloads. It performed hover and click using observed UIDs; the fixture wrote `CU-PACKAGED-CLICKED-1` only from its button click handler. The model then returned `done` with a current observation UID as completion evidence, and the chat model produced the final response.

Result: packaged interaction E2E **passed** (`switchN=1`, `computerN=4`, `imageN=3`, `finalN=1`; fixture postcondition exactly `CU-PACKAGED-CLICKED-1`). The first attempt did not test switching because the fixture was topmost and already foreground; the harness was corrected to start from the app window and to parse only the value inside `window_id="..."`, then the target-switch run passed. That first attempt is not counted as acceptance.

This establishes the tested packaged path for provider/settings/session wiring, model tool declaration, exact-ID target switch, pixel payload delivery to the configured Computer model, one UIA hover/click sequence, and evidence-backed completion on this Windows fixture. It does **not** establish arbitrary application compatibility, live external-provider behavior, or screenshot persistence/privacy beyond this harness. At that time, cursor-overlay visuals and Stop/cancellation were still separate checks; later evidence below covers packaged Stop behavior and a two-point primary-display composite smoke test. Both app and fixture processes were closed by the harness. Temporary `.artifacts/packaged-cu-debug*` files are test-only and are removed after evidence capture.

## Windows Host target-selection recheck — 2026-11-09

After the packaged image-path acceptance, reran the ignored native Windows fixture tests on the current checkout. `windows_backend_drives_only_the_isolated_fixture_window` passed (1/1, 21.92 s), exercising the isolated WinForms fixture controls and stale-target rejection. `windows_backend_repeats_target_binding_under_three_start_conditions` passed (1/1, 12.63 s): 50 fresh-host attempts, 50 two-window churn attempts, and 60 attempts after ten grant lifecycle cycles; first-attempt failures, 100 ms recoveries, late recoveries, unrecovered attempts, and target mismatches were all zero. These are focused local Windows fixture results, not claims about arbitrary apps or other platforms.

The existing isolated Electron settings/Stop E2E was also rerun on this checkout on 2026-11-09 (`node scripts/e2e-computer-use-settings.mjs`, exit 0). It verified Computer Use enablement/model/budget/expiry writes, restriction-setting round trips, and the Stop path forwarding the exact owning `{ sessionId, grantId }`. This remains renderer/Electron test-harness evidence; later packaged Stop/overlay acceptance and the automated composite smoke test are documented below. Human visual QA and multi-display/DPI checks remain open.

## Agent Runtime Computer tool registration recheck — 2026-11-09

Reran the focused Agent Runtime registration and fixed-declaration tests on this checkout: 13 passed, 0 failed (407 unrelated tests skipped by the name filter). This confirms Computer remains registered as a core Agent-mode tool when enabled and is absent when disabled or in Plan/Goal modes; fixed declarations remain restricted to the explicitly verified model/API route rather than silently assumed for arbitrary providers.

A full current-checkout Windows Host Core run completed on 2026-11-09: `cargo test --locked -p host-core` — 1,242 passed, 0 failed, 3 ignored, 0 filtered (100.46 seconds). This includes the Computer grant/policy/RPC tests plus the rest of Host Core; it is Windows-only and does not substitute for Linux/macOS device acceptance.

## Packaged Computer Use Stop and overlay E2E — 2026-11-09

Added a repeatable Windows-only test at `scripts/e2e-computer-use-packaged-stop.mjs`, exposed as `pnpm test:e2e:computer-use-packaged`. It requires the unpacked Release app to exist, uses a local fake provider endpoint plus a throwaway profile and WinForms fixture under `.artifacts`, and removes the profile/data/fixture directory when finished. By default it does not capture a preview. Setting `PI_CU_E2E_CAPTURE_PREVIEW=1` streams a downscaled preview of the cursor renderer surface in memory through stdout; it does not write an image file and does not include the underlying desktop. Setting `PI_CU_E2E_VERIFY_DESKTOP_COMPOSITE=1` samples only two in-memory pixels (near the primary display edge and fixture center) and checks the foreground process ID; it outputs boolean pass/fail diagnostics and no pixel colors or screenshot data.

The packaged Stop/overlay run passed twice with `PI_CU_E2E_VERIFY_DESKTOP_COMPOSITE=1`: the chat model selected the `Computer` tool; Computer switched using the observed exact fixture window ID and received pixel payloads; an observed fixture button was clicked to ensure the green fixture was foreground; the live status widget displayed the fixture target and an enabled Stop button; the cursor renderer surface loaded with the blue full-screen edge border/glow CSS; then the two-pixel composite check confirmed the fixture remained visible at the sampled center and the blue edge effect changed the sampled edge pixel. Clicking Stop aborted the pending Computer-model request, Host grant state became empty, and the widget cleared. The aborted run correctly produced no final chat-model response (`finalReplies=0`); cancellation stops the owning tool turn rather than inventing a completion message. No image was captured or saved; the output reported only booleans and `screenshotsSaved=0`.

This proves DOM/CSS/runtime wiring and Stop cancellation in the packaged Windows app, plus an automated pixel-level smoke check of the actual primary-display composite over a known isolated fixture. It does not establish how the effect looks to a human across the entire display, nor multi-display/scaling or graphics-driver behavior; those remain open. No screenshot image was written.

## Windows overlay DPI coordinate normalization — 2026-11-09

The Windows Host supplies screen coordinates from native window/UIA geometry,
while Electron positions the click-through overlay and renderer cursor in DIPs.
Computer Host operations now temporarily use Per-Monitor V2 DPI awareness
(falling back to Per-Monitor V1) and restore the worker thread's original DPI
context when the operation ends. This makes `GetWindowRect` measurements
consistent with UIA physical-screen geometry even though the Host executable
does not provide a DPI manifest. At the Electron boundary, the Host target
rectangle is converted with `screen.screenToDipRect` before display matching,
and Host cursor points are converted with `screen.screenToDipPoint` before
renderer delivery. Non-Windows backends retain their existing coordinate
contract; Host input/target coordinates remain physical screen pixels.

| Check | Result |
|---|---|
| `cursor-overlay.test.ts` | Passed 5/5: baseline 100%, simulated 125% primary display, simulated 150% negative-origin secondary display, full-monitor overlay bounds, and renderer state replay. |
| Host DPI awareness unit test | Passed: native thread context became Per-Monitor aware and was restored exactly after scope exit. |
| Full Windows Host Core suite | Passed: `cargo test --locked -p host-core` — 1,243 passed, 0 failed, 3 ignored. |
| Native Windows Host fixture | Passed: isolated UIA action/readback fixture and 160 target-binding trials (50 fresh, 50 two-window churn, 60 after grant cycles); zero mismatches or recovery failures. |
| Agent Runtime + Host pixel E2E | Passed on the current checkout: 3 isolated grant cycles, 6 UIA actions, 9 post-action decisions/observations, 9 PNG payloads sent only to the local fake image-capable model endpoint; the fixture confirmed all three state changes. No screenshot was saved. |
| Development Host binary | Passed: `cargo build --locked -p host-core`. |
| Desktop TypeScript check | Passed: `tsc -p apps/desktop/tsconfig.json --noEmit`. |
| Electron Vite desktop build | Passed: main, preload, and renderer bundles built. |
| Physical display environment | This machine has one 1920×1080 monitor at 96 DPI. No physical mixed-DPI or multi-monitor acceptance was possible in this run; the 125%/150% tests exercise simulated Electron conversions, not real display hardware. |

The physical multi-monitor/DPI and human visual checks remain open; this change
does not claim those hardware cases are accepted.

## Linux X11 Hover/Drag implementation — 2026-11-09

The Linux X11 backend now detects the XTEST extension and advertises `Hover`
and `Drag` only for accessible nodes with screen bounds when XTEST is available.
Hover defaults to the center of the selected node; drag requires explicit
start/end points. Both are interpreted relative to the already-bound target
window, checked against that window's measured bounds, converted to XTEST
root-screen coordinates, and rejected if coordinates are non-finite or outside
the X11 signed-coordinate range. The GTK fixture now changes its accessible
status only after receiving real pointer-enter and button-drag events.

The existing Ubuntu CI Xvfb/GTK/AT-SPI step exercises the extended integration
test for XTEST availability, advertised actions, hover state, drag state, and
the existing AT-SPI click. Local Linux-target `cargo check` and
`cargo check --tests` both passed on 2026-11-09. This Windows host has no Linux
desktop session, WSL distribution, or running Docker Linux engine, so the GTK /
Xvfb runtime acceptance has not yet run locally; require the Ubuntu CI result
before treating Linux X11 Hover/Drag as runtime-accepted. Wayland and other
platforms remain out of scope for this batch.
