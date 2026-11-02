# ADR 0340: Add read-only GitHub Pull Request review to the Work Panel

- Status: Accepted
- Date: 2026-11-02
- Decision owners: PI-Desktop core
- Related: [ADR 0043](0043-message-owned-review-snapshots-and-rollback.md) ·
  [ADR 0308](0308-remove-pull-requests-destination.md) ·
  [ADR 0339](0339-independent-local-branch-review.md) ·
  [IPC protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [WorkPanel component spec](../spec/04-ux/08-component-spec.md) ·
  [E2E-269](../spec/06-delivery/04-e2e-test-plan.md)
- Amends: ADR 0308 for the independent read-only Work Panel surface only

## Context

ADR 0308 removed the old Pull Requests destination because it depended on the
GitHub CLI and ambient process authentication, did not provide a review surface,
and left an unused MCP listing operation. The message-owned Review and local
Branch Review surfaces have separate sources of truth and must remain unchanged
(ADR 0043 and ADR 0339).

Users still need a lightweight way to inspect a public GitHub pull request next
to the conversation that is working on it. The first iteration does not need
GitHub write permissions or private-repository credentials.

## Decision

1. Add a distinct host-owned **GitHub PR Review** Work Panel tool. It does not
   replace message Review or local Branch Review.
2. Resolve the repository only from the active local conversation's `origin`
   remote, and accept only `github.com` HTTPS/SSH remotes. Remote Host sessions,
   GitHub Enterprise, arbitrary URLs, and private repositories are unsupported.
3. Make no network request merely by opening the tab. A user action loads up to
   50 open pull requests from GitHub's public API. Selecting one loads its
   metadata, at most 100 changed-file patches, and public check-run / commit
   status summaries. Requests are bounded, use HTTPS, reject redirects, and do
   not attach credentials.
4. A changed-line action appends an editable note to that same session's
   Composer draft. The note identifies the repository, pull-request URL, head
   SHA, file and line, and quotes the selected diff line as untrusted source
   text. It never sends a turn or creates a GitHub review/comment/approval.
5. GitHub response data remains untrusted display/input data. Main owns API
   access and repository resolution; the Renderer receives only bounded typed
   results through allowlisted IPC. No GitHub token, OAuth flow, Host RPC, or
   persisted state is introduced.

## Consequences

- The original `gh`-backed Pull Requests destination and MCP `pulls/list` remain
  removed. The new panel is an independent, read-only public-API workflow.
- GitHub public API rate limits and network availability apply. Private
  repository access requires a separate credential and permission decision.
- Line feedback remains local and editable until the user independently sends
  the Composer draft.
- Message Review continues to show immutable message-owned snapshots, while
  Branch Review continues to inspect locally available Git refs only.

## Alternatives rejected

- **Restore the old `gh pr list` destination:** rejected because it again relies
  on ambient GitHub CLI authentication and still does not bind review feedback
  to an editable conversation draft.
- **Reuse the Review tab:** rejected because its message-owned history must not
  become a mutable GitHub or Git snapshot.
- **Add GitHub comments or approvals:** rejected for this iteration because
  those actions need authenticated write scope and explicit external-write UX.
