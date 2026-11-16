# ADR 0357: Manage oh-my-pi as an optional native RPC engine

## Status

Accepted; public RPC-UI integration is the product direction.

## Context

oh-my-pi (OMP) is an independent agent runtime with its own model providers,
credentials, tools, extensions, sessions, subagents, and operating-system
permissions. PI users prefer PI's chat GUI over a terminal UI. The integration
therefore keeps PI's transcript and composer while launching OMP in its official
`rpc-ui` mode. PI transports OMP RPC frames and renders a supported shared/UI
subset; it does not execute OMP work through PI Agent Runtime or PI Host tools.

The public RPC contract is documented upstream in `docs/rpc.md` and typed in
`packages/coding-agent/src/modes/rpc/rpc-types.ts`. It exposes model/session
control, streamed messages, extension UI requests, subagent events, context and
compaction state, login, queues, goals, live voice, and more. A public RPC
surface is not identical to OMP's terminal: raw TUI key handling, terminal
widgets, arbitrary terminal rendering, and some interactive flows have no
one-to-one GUI representation. Unsupported requests must be surfaced, not
silently dropped or claimed as parity.

The standalone OMP executable is large and follows an independent release
cadence, so it is optional and installed on demand.

## Decision

1. PI and OMP remain the only engine choices. PI is the default. OMP runs as
   its own RPC-UI process and owns model selection, authentication, native
   built-in tools, extension execution, OMP session history, and its own
   permission semantics.
2. PI renders OMP's message/tool lifecycle in the existing chat UI and presents
   supported extension UI requests. OMP tool calls are never dispatched into
   PI's Agent Runtime or Host tool approval chain. The operating-system account
   and permissions remain the effective execution boundary.
3. OMP is installed only from official `can1357/oh-my-pi` GitHub Releases.
   Activate a binary only after validating the release SHA-256 and reported
   version; keep a previous verified version for rollback. Do not bundle the
   executable into the default PI installer.
4. OMP profile configuration and authentication are stored in a dedicated PI
   data subdirectory. Each PI session maps to a deterministic OMP session
   directory. They are separate from PI model credentials and transcript data.
   The desktop may add one PI-managed custom compatible provider to OMP's
   `models.json` (OpenAI Completions/Responses, Anthropic Messages, or Gemini).
   Its endpoint and model metadata stay in the OMP profile; its API key is
   stored only in Host's encrypted secret store and injected into the OMP child
   process environment at spawn. The renderer receives only a configured bit,
   never the saved key. Saving does not terminate running OMP sessions; the
   provider is available to newly started OMP RPC processes.
5. PI session messages are mirrored for display/audit, but existing PI history
   is not imported into OMP context. While OMP is selected, PI history editing
   and truncation are refused until a verified OMP branch mapping exists; this
   avoids silently mutating one transcript while continuing another.
6. All OMP RPC entry points are scoped to an existing local PI session and use
   the session's mapped workspace path, never an arbitrary renderer-supplied
   path. Remote workspace sessions are refused.
7. The adapter must negotiate RPC protocol v2 when advertised, validate chunk
   sequencing and sizes, correlate request IDs, preserve stderr diagnostics,
   reject or clearly report unsupported host-tool/URI interactions, and stop
   child processes cleanly during app shutdown.
8. OMP RPC is an evolving protocol. Features only count as integrated when
   the GUI has a tested renderer and correct lifecycle semantics. In
   particular, subagents, live voice/dictation, queue controls, branch/tree
   navigation, rich widgets, and all login/logout variations remain explicit
   acceptance items unless implemented and tested. The UI must not imply that
   a feature is supported merely because its RPC command is forwarded.

## Consequences

- The user gets PI's GUI with OMP's own runtime and tools, without xterm/PTY or
  a second terminal interface embedded in PI.
- Existing PI conversations display in the same transcript, but their earlier
  messages are not automatically part of OMP's model context; the GUI states
  this clearly.
- RPC-UI can represent much of OMP's public agent/session behavior, but cannot
  promise exact parity with terminal-only workflows. Missing features remain
  visible as gaps rather than being mislabeled “all native capabilities.”
- OMP files remain separate by design. Switching engines does not merge,
  rewrite, or delete either engine's history or credentials.
- An upstream OAuth 403 such as `unsupported_country_region_territory` is a
  service-side refusal, not a GUI setting the app can override. The independent
  custom-provider form gives users a supported way to configure another
  compatible endpoint they are entitled to use; it does not proxy or bypass
  the rejected OAuth flow.

## Acceptance gates

- Manager tests cover platform resolution, official origin, digest/size/version
  checks, failed activation, successful install, and rollback.
- RPC transport tests cover handshake, command correlation/timeouts, v2 chunks,
  malformed frames, process errors, concurrent attach, abort, and shutdown.
- UI tests cover streaming assistant/tool output, login/open-url, extension
  select/confirm/input/ask, session scoping, unsupported requests, and engine
  switching without transcript truncation.
- Local isolated smoke verifies `ready → negotiate_protocol → open_session →
  get_state/get_available_models`; no real account or model request is needed
  for this transport gate.
- Separate acceptance is required before claiming subagent UI, live voice,
  dictation, branch editing, or other advanced RPC features are complete.
