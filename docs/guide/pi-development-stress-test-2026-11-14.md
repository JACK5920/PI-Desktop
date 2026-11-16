# PI Development Stress Test Report — 2026-11-14

## Executive result

**Overall: not a clean pass.** Core host RPC, queued/background tools, transcript recovery, config sync, image generation, browser file-boundary checks, and renderer responsiveness passed their exercised scenarios. Several acceptance probes failed; see the result matrix. This run does not establish stability for every PI capability.

## Test basis and limits

- Environment: Windows 10 x64; shell Node.js 24.18.0. The renderer probe reported Electron 43.6.0, Chromium 150.0.7871.250, and its embedded Node.js 24.20.0.
- The test began in an already modified, uncommitted worktree (`fix/computer-use-reliability`); results apply to that local checkout and its existing build artifacts, not to a clean release candidate.
- Live model requests were disabled. Real provider APIs, paid services, live voice hardware, and native Computer Use device acceptance were not exercised.
- The Subagents E2E refused to run on Windows because its HOME isolation contract only supports Linux/macOS; it made no registry writes.
- Electron boot and supervision probes returned no probe payload. A development Desktop process was present in the environment; whether single-instance/profile interaction caused these failures is unconfirmed.
- Raw test stdout was available in the execution transcript but was not saved as raw files. Start/end wall-clock timestamps were not captured. No source-tree fingerprint manifest was generated: its helper reads every pre-existing untracked file in this already dirty worktree.

## Capability results

| Capability | Scenario and observed load | Result |
|---|---|---|
| Host RPC, tools, permissions, plugin dispatch | `node scripts/e2e-smoke.mjs`; 23 checks passed, including sandbox denial, Plan-mode write denial, tool reads, plugin dispatch, and persistence. Live model and streaming checks skipped. | **Pass, offline scope only** |
| Tool admission under contention | `node scripts/e2e-tool-admission.mjs`; 4 active plus 12 queued shells left capacity for another session's Read/Write and drained cleanly. | **Pass** |
| Background task throughput | `node scripts/e2e-background-tasks-host.mjs`; 10 jobs produced 202,000,000 bytes across stdout/stderr; 18 polls, RPC p95 31.76 ms, max 54.1 ms, retained output bounded to 262,144 bytes per stream. Turn abort did not stop the jobs; final output remained available. | **Pass** |
| Plan and Goal lifecycle | `node scripts/e2e-plan.mjs`; 14 passed, 1 failed, 3 skipped. Goal lifecycle returned `tokenBudgetUnlimited=true` where the test expects the finite default; the remaining Plan execution, approval, shell, and abort cases passed. | **Fail: Goal default** |
| Transcript cache and restart recovery | `node scripts/e2e-transcript-cache.mjs`; paging, legacy cache recovery, navigation, Task rewrite, restart, and bounded invalid-UTF-8 reads passed. | **Pass** |
| Large tool/image-result persistence | `node --max-old-space-size=4096 scripts/e2e-tool-result-persistence.mjs`; 35-screenshot history (98,989,920-byte old request; 24,843,724 stored bytes) and a 95-image, 67,114,080-byte history both passed. Final profile-relocation comparison failed: actual path used `/` while the Windows expected path used `\\`. | **Partial pass; relocation assertion failed** |
| Multi-host config sync | `node scripts/e2e-config-sync-multidevice.mjs`; 4 hosts, 374 requests, 43 objects; encryption, signatures, conflict handling, restart/restore, and password rewrap passed. Remote-fixture cleanup reported 0 remaining objects and 0 versions. | **Pass** |
| Renderer responsiveness | `node scripts/e2e-renderer-responsiveness.mjs`; 180 ordered deltas, 92,182 final characters, complete marker/tool output; 11 native actions had p95 latency 11.23 ms. | **Pass** |
| Image generation | `node scripts/e2e-image-generation.mjs`; 5 local fixture requests covering batch generation, edit, large image, Plan denial, restart, and binding cleanup. | **Pass** |
| Browser local-file boundary | `node scripts/e2e-browser-local-file-access.mjs`; local file URL/path/link and HTTP loading worked; missing file was blocked. | **Pass** |
| Plugin project picker | `node scripts/e2e-plugin-projects.mjs`; 1/1 test passed. | **Pass** |
| Plugin UI slots and lifecycle | `node scripts/e2e-plugin-ui-slots.mjs`; 63/64 checks passed. The toolbar-fit assertion failed for five controls whose measured widths exceeded their available widths. | **Fail: toolbar fit** |
| MCP market install and URL boundary | `node scripts/e2e-mcp-market.mjs`; 2/4 passed. Install checks failed, including a missing expected server record file (`ENOENT`). | **Fail: install path** |
| Skill market install and URL boundary | `node scripts/e2e-skill-market.mjs`; boundary, ID alignment, size-limit, and resource-expansion checks passed; install check failed. Teardown then hit Windows `EPERM` while removing the temporary data directory. | **Fail: install and teardown** |
| Generated UI | `node scripts/e2e-gen-ui.mjs`; Electron emitted no `GENUI_E2E` result marker. | **Fail: no probe result** |
| Electron boot | `node scripts/e2e-electron-boot.mjs`; `boot-probe` was `null`; no boot/session-list responsiveness evidence was produced. | **Unverified / failed probe** |
| Host supervision | `node scripts/e2e-supervision.mjs`; `supervision-probe` was `null`; no restart/recovery evidence was produced. | **Unverified / failed probe** |
| Subagents | `node scripts/e2e-subagents.mjs`; preflight rejected this Windows environment before writes. | **Not run** |

## Stability assessment

The highest-load completed checks show bounded background output, responsive renderer interactions under streaming load, and successful transcript/config-sync recovery. They do not outweigh the failed Goal default, Windows relocation-path assertion, MCP/Skill installation checks, plugin toolbar-fit assertion, and missing Electron probes. **Do not treat this development build as fully stability-qualified.**

## Cleanup and execution notes

- Temporary directories created by the completed scenarios were removed; the final scan found no remaining directories matching this run's E2E temp prefixes. Test-created browser and plugin UI artifacts, interrupted persistence fixtures, and marketplace fixtures were explicitly removed.
- Pre-existing workspace changes and unrelated pre-existing temporary directories were left untouched.
- Initial `pnpm` alias invocations failed because the Windows `pnpm` shim path could not be executed. Equivalent test scripts were invoked directly with Node where possible.
- No product code was changed for this report. Test failures are recorded as observations, not fixes.

## Commands executed

```text
node scripts/e2e-smoke.mjs
node scripts/e2e-tool-admission.mjs
node scripts/e2e-background-tasks-host.mjs
node scripts/e2e-plan.mjs
node scripts/e2e-transcript-cache.mjs
node --max-old-space-size=4096 scripts/e2e-tool-result-persistence.mjs
node scripts/e2e-config-sync-multidevice.mjs
node scripts/e2e-renderer-responsiveness.mjs
node scripts/e2e-image-generation.mjs
node scripts/e2e-browser-local-file-access.mjs
node scripts/e2e-gen-ui.mjs
node scripts/e2e-mcp-market.mjs
node scripts/e2e-skill-market.mjs
node scripts/e2e-plugin-projects.mjs
node scripts/e2e-plugin-ui-slots.mjs
node scripts/e2e-supervision.mjs
node scripts/e2e-electron-boot.mjs
node scripts/e2e-subagents.mjs
```
