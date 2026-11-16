# ADR 0356: Session artifact library and inline review feedback

## Status

Accepted

## Context

Workspace files created during a conversation were recorded by Host Core, but
the desktop exposed them only indirectly through file references and change
cards. Review was a chronological snapshot list with no path search, directory
grouping, review marks, or direct line feedback.

## Decision

- Reuse the Host-owned `artifacts` index; do not copy files, create a second
  artifact database, or mix incoming attachments with generated workspace
  files. Include the originating turn identifier in list results.
- Add an explicit session-scoped Artifacts work-panel destination. It lists
  recorded deliverables, supports path search, previews the file in the panel,
  reveals its containing folder, copies its full path, returns to the source
  assistant reply when the Host can map its turn, and exposes the shared file
  context menu. On Windows the menu can invoke the native Open With chooser,
  after Host path resolution and local-file validation.
- Use the shared file-reference context menu across Markdown file links,
  inline references, tool-output paths, generated-image cards/viewers,
  turn-change rows, review rows, and the Artifacts list. A file-target right
  click is consumed by that reference; right-clicking surrounding reply text
  keeps the ordinary message menu. Fenced code stays literal and only exposes
  file actions when the pointer or selection identifies a valid file token.
- Keep Files as workspace browsing and Review as message-owned code-change
  evidence. Review adds path search, status filters, directory grouping, local
  per-session reviewed marks, and line-level feedback that is added to the
  current Composer but never sent automatically. Navigating to a change from a
  turn card clears Review's current search and status filters so the requested
  snapshot can be found and focused.
- Preserve existing Host checks for file roots and guarded rollback. No
  automatic file opening, screenshot, upload, or filesystem copy is introduced.

## Consequences

The work panel gives generated workspace deliverables a discoverable index
without changing the existing artifact ownership or write path. Review remains
anchored to immutable message snapshots; feedback is an ordinary draft and the
user decides whether to send it. Reviewed marks are renderer-local convenience
state, not authoritative audit data.

## Alternatives

- Create a new relational artifact catalog: rejected because the existing Host
  index already records the needed source session, path, operation, and turn.
- Merge artifacts, file browsing, and review into one list: rejected because
  deliverables, workspace navigation, and code-change evidence have different
  lifecycles and actions.
