# OMP RPC GUI Parity

> Scope: the desktop's `rpc-ui` integration for the managed Oh My Pi (OMP)
> engine. This spec tracks the tested RPC contract and its GUI equivalents; it
> does not claim pixel- or workflow-identical parity with OMP's terminal TUI.

## Version and authority

- The current parity baseline is OMP **19.2.0**, verified with the isolated
  executable used by `omp-rpc-native-integration.test.mjs`.
- The runtime negotiates the public RPC v2 protocol when offered. The pinned
  command and outbound-frame manifests in the desktop tests are the executable
  compatibility gate; update them only after checking the release source and an
  isolated native binary.
- A compatibility test does not activate or replace the user's managed engine.
  At this verification, the development profile's active engine remains
  independent of the isolated 19.2.0 test binary.
- No real account, credentials, provider request, model generation, or user
  session is part of the acceptance tests.

## GUI equivalents for the 19.2.0 additions

| Native capability | Desktop surface | Contract and regression coverage |
| --- | --- | --- |
| `get_model_picker` | Composer model selector; an `@role` query asks OMP for its native role ranking and displays the role and role-specific effort. Selecting a row sends the native provider/model plus role and thinking-level fields. | `omp-thinking-level-refresh.test.mjs`; isolated profile-backed quick-role RPC smoke. |
| `abort_and_deliver_queue` | OMP session controls, visible only while work is active and steering/follow-up text is queued. OMP remains the authority for abort/delivery outcome. | `omp-session-controls.test.mjs`; isolated empty-queue response check. |
| `resume` | OMP session controls for a non-running OMP session with native messages. The action is sent to OMP; errors such as an empty/non-resumable session remain engine responses. | `omp-session-controls.test.mjs`; isolated empty-session rejection check. |
| Retry fallback events | Main conversation status shows source model, fallback model, and the engine-provided reason for `retry_fallback_applied` and `retry_fallback_succeeded`. | `omp-rpc-frame-parity.test.mjs`; `omp-rpc-native-integration.test.mjs`. |
| Agent-loop failure metadata | The transcript marks an OMP `errorFromAgentLoop` completion as a non-retriable agent-loop error, distinct from a provider transport/request failure. | `omp-rpc-native-integration.test.mjs`. |
| Subagent wait/retry/model metadata | Main conversation cards and the details panel distinguish waiting, retry delay/failure, resolved model, and fallback-model use when OMP supplies those progress fields. | `omp-subagent-progress.test.mjs`, `omp-subagent-turn-group.test.mjs`, `omp-subagent-roster.test.mjs`. |
| Configuration/advisor status events | Session-scoped status area signals that configuration warnings changed and shows advisor cost/yield notices; the current RPC event has no warning payload, so it does not claim to render individual warning details. Raw provider or workspace data is not persisted by this projection. | `omp-rpc-native-integration.test.mjs`; `omp-extension-state.test.mjs`. |

The `omp-rpc-command-parity.test.mjs` manifest contains the 77 public commands
verified for 19.2.0 and checks that each is accounted for by the explicit IPC
allowlist and any narrower provider-management allowlist. The manifest is not
permission to expose arbitrary RPC or file access to the renderer. Commands
without a dedicated visible control remain limited to existing purpose-built
surfaces, internal runtime flows, or an explicit unsupported response; do not
add a silent fallback to PI Agent Runtime or PI Host tools.

## Invariants

- OMP owns its model catalog, session history, extension execution, tools,
  authentication and permission semantics. PI renders the interaction and
  mirrors visible events; it does not execute OMP requests through a different
  engine.
- `@role` selection must preserve native role identity and `auto` effort. A
  successful `set_model` stays successful if the subsequent capability/state
  refresh fails; stale reasoning options are cleared and the UI reports the
  refresh failure without claiming the model switch was rejected.
- Session queue and resume actions are explicit user actions. The GUI must not
  infer success from issuing a command; it uses OMP's response and keeps the
  session transcript and queue semantics native.
- OMP agent-loop errors are not mislabeled as provider errors. Retry fallback
  and subagent status displays are projections of OMP events/progress only;
  missing fields must not be invented.
- Event status and model strings are bounded before display. Session change or
  RPC process exit clears transient state.

## TUI-only and not claimed as GUI parity

The desktop does not embed a terminal or emulate arbitrary terminal output.
Raw TUI key handling, terminal-size-dependent layout, terminal-only widgets,
and flows that have no public RPC representation are outside this parity
contract. They must be called limitations, not reported as completed because
a similarly named command is forwarded. If a later OMP release adds a public
RPC method, update the command/frame manifest, classify its semantics, add a
purpose-fit GUI surface or a visible unsupported response, and validate it
against an isolated binary before claiming support.

## Acceptance

For an OMP release update:

1. Compare the upstream RPC type/command/frame contract to the pinned test
   manifests; document additions, removals and semantic changes.
2. Run command, frame, event-adapter, session-control, model-picker, extension,
   subagent and transcript regression tests.
3. When the matching executable is available, use a temporary profile and
   data directory to exercise protocol negotiation, state/model reads, the
   new or changed RPC commands, extension events and error shapes. Do not use
   the active managed profile or issue a real model request.
4. Run i18n validation, desktop typecheck, desktop build, and `git diff
   --check`; record the binary version and hash separately from the active
   managed engine version.
