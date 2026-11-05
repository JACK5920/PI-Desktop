# ADR 0347: Side-chat session visibility

**Status:** Accepted for implementation
**Date:** 2026-11-05

## Context

Side chats use normal child sessions so they can reuse transcript storage,
streaming, cancellation, and child-scoped approvals. Treating every child as an
ordinary conversation makes a docked follow-up look like an automatic branch:
it appears in the main session list and global search even when the user only
wanted a temporary side panel. The renderer also loses its transient tab state
on close or restart, leaving a sent follow-up hard to rediscover.

## Decision

Persist side-chat provenance on the child session: parent session id, source
message id, selected excerpt, and an explicit promotion bit. Ordinary forks
remain unchanged. Existing sessions are not inferred or reclassified during
migration.

An unpromoted side chat is omitted from top-level session navigation and global
search, but remains in Host inventory so the parent can offer a reopen action.
Reopening loads the durable child transcript into a docked WorkPanel tab without
changing the parent/child execution path. “Open as a conversation” persists
promotion and then selects the child, making it an ordinary list/search result.

Deleting a parent sets the child's parent reference to null; this releases the
child as an ordinary conversation rather than deleting its transcript or
leaving it unreachable. Unsent drafts remain renderer-only and are not
persisted.

## Consequences

- SQLite schema v31 adds nullable provenance columns and a default-false
  promotion flag; v30 sessions migrate as ordinary conversations.
- Host remains authoritative for visibility metadata and global search.
- The renderer derives navigation grouping from Host session summaries and
  keeps open tabs as a transient projection.
- Side-chat children continue to use normal session permission, streaming,
  cancellation, and approval behavior.
- Remote RACP interoperability remains unchanged in this implementation;
  remote peers that do not expose this metadata keep their existing fork
  behavior.

## Alternatives

- Keep side chats renderer-only: rejected because sent transcripts cannot be
  reliably reopened after a renderer restart.
- Hide all forks: rejected because ordinary branch/fork workflows are explicit
  and must remain discoverable.
- Delete the child when its tab closes: rejected because closing presentation
  must not destroy user data or stop work.
