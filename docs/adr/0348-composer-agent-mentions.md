# ADR 0348: Route explicit `@agent` mentions through the existing Task tool

- Status: Accepted
- Date: 2026-11-06
- Deciders: PI-Desktop core
- Related: ADR 0024, ADR 0062, component spec §11.8

## Context

Subagents are currently selected when the model calls `Task`. A user who knows
which subagent should handle a portion of a request has no direct composer
entry point. The existing Task execution path already owns delegation policy,
approval, cancellation and result reporting, so mentions should route through
that path rather than introduce a second execution mechanism.

## Decision

1. In Agent mode only, the `@` autocomplete offers the current subagent catalog
   above file results. A root workspace file or directory with the same name
   wins. Plan and Goal keep `@name` as literal text.
2. Accepting a subagent inserts an atomic draft chip. At send time it serializes
   to `@name`; Main resolves only names in the current launch catalog and only
   complete word-boundary tokens. Unknown, malformed, e-mail-like and path-like
   tokens remain ordinary text.
3. Main adds a concise instruction to use the existing `Task` tool for the
   explicitly named agents, followed by the user's unchanged request. Skill and
   agent mentions compose in order. Existing app commands and leading template
   behavior take precedence.
4. The user transcript retains the typed request in `command` and stores
   validated `agentMentions` offsets in message metadata. The Host round-trips
   the optional field without a SQL migration. Invalid offsets render as plain
   text; old messages remain unchanged. Stop restores the typed command rather
   than the model-facing instruction.

## Consequences

This is an explicit prompt instruction, not guaranteed tool dispatch. Actual
Task execution retains existing permissions, approval, cancellation and
runtime behavior. No new RPC, database migration, Plugin SDK contract or
execution path is introduced.
