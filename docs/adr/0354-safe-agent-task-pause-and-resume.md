# ADR 0354: Pause Agent tasks at a safe turn boundary

- Status: Accepted for implementation
- Date: 2026-11-11
- Deciders: PI-Desktop maintainers
- Related: ADR 0053 (no replay after host restart), ADR 0213 (durable turn queue)

## Context

The Composer exposed one Stop action implemented as immediate abort. Users need
to pause long work and continue it later without conflating pause with cancel.
The Agent runtime already supports a graceful stop after the current assistant
turn and completed tool batch, which is a safe point to persist a resumable
marker. A shutdown in the middle of a tool call does not provide such a point;
replaying it could duplicate external side effects.

## Decision

1. The existing lower-right task control becomes a state toggle: a running
   local Agent session shows Pause, and a safely paused session shows Resume.
   Pause requests the existing graceful stop and is committed only after the
   matching `agent_end` arrives. Right-clicking the same control remains the
   immediate Stop action; unsupported session types keep the existing Stop
   button.
2. Resume creates a new user turn against the existing session transcript with
   an instruction to inspect recorded tool results, avoid repeating completed
   actions, and ask before retrying an uncertain side effect. It does not replay
   the old provider request or old tool call.
3. `AppSettings.autoResumePausedTasks` is optional and defaults to off.
   `AppSettings.pausedTaskSessionIds` stores only sessions paused at a completed
   turn boundary. When the preference is on, startup atomically clears each
   eligible marker before submitting one continuation prompt. A failed
   admission restores the marker for manual recovery.
4. An uncleanly interrupted turn never receives this safe-pause marker and is
   never automatically replayed. This keeps ADR 0053's startup no-replay rule
   for uncertain active work. Remote and native Pi sessions are not auto-resumed
   by the desktop-local setting.
5. User message bubbles use a theme-token blue surface matching the supplied
   Codex reference (`#173e76` in dark theme, a pale blue equivalent in light
   theme). The composer send and task-state controls use the supplied Codex
   blue (`#2c67c5`) rather than the neutral monochrome accent.

## Consequences

- Pause may take until the current provider response and tool batch settle; it
  is not a provider-stream suspension.
- Resume is a new model turn and may incur additional provider usage.
- Automatic resume is limited to explicit safe pauses. Uncleanly interrupted
  actions remain visible for user review and are not replayed.
- No SQLite schema or IPC protocol change is required; the checkpoint list uses
  the host-persisted settings blob.
