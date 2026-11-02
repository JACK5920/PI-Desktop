# ADR 0341: Authenticate GitHub PR Review and gate external writes

- Status: Accepted
- Date: 2026-11-03
- Decision owners: PI-Desktop core
- Related: [ADR 0340](0340-read-only-github-pull-request-review.md) ·
  [ADR 0308](0308-remove-pull-requests-destination.md) ·
  [IPC protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [WorkPanel component spec](../spec/04-ux/08-component-spec.md) ·
  [E2E-270](../spec/06-delivery/04-e2e-test-plan.md)
- Amends: ADR 0340 for private-repository reads and explicitly confirmed PR
  review writes; message Review and local Branch Review remain unchanged

## Context

ADR 0340 introduced an independent, public, read-only GitHub PR Review surface.
Users also need to inspect private repositories and optionally publish line
comments or a pull-request review without relying on ambient `gh` credentials.
These operations cross an external write boundary and must remain separate from
the editable Composer-draft feedback path.

## Decision

1. Keep GitHub PR Review as a separate Work Panel tool. Public reads remain
   available without sign-in. Private-repository reads and writes require a
   user-authorized GitHub App. Only local conversations whose `origin` is a
   GitHub.com HTTPS or SSH remote are supported; remote Host sessions, GitHub
   Enterprise, and arbitrary URLs remain unsupported.
2. Use GitHub App authorization-code flow with PKCE, a random `state`, and an
   ephemeral loopback callback bound to `127.0.0.1`. Configure only
   `offline_access` for expiring user and refresh tokens. The user supplies the
   GitHub App Client ID and Client Secret in the UI. The Electron main process
   stores credentials and rotating tokens through Host secret storage; no
   token or secret is returned to the Renderer or written to repository files.
   The callback accepts only loopback requests and expires after five minutes.
3. The app registration requests the minimum repository permissions needed:
   Pull requests read/write, Checks read, and Commit statuses read. The user
   must install the App on private repositories they want to access. GitHub
   user-access-token permissions remain bounded by both the App grant and the
   user's own access.
4. Opening the tab still makes no GitHub API request. Explicit user actions
   load at most 50 open PRs and at most 100 changed-file patches per PR from
   `api.github.com`. API reads and writes use HTTPS, fixed hosts, bounded
   responses, timeouts, and redirect rejection.
5. A line-comment or review action opens a confirmation dialog that displays
   the destination, revision, text preview, and external-write warning. The
   user must explicitly submit from that dialog. Approvals additionally require
   a separate confirmation checkbox naming the PR. No write occurs on opening
   the dialog, editing a draft, loading a PR, or pressing Cancel.
6. Before a write, Main obtains the user's current access token and re-reads the
   pull request. It rejects closed PRs, stale head SHAs, and inline anchors no
   longer present on the selected side of the current changed-file patch. Only
   inline comments and GitHub review events `COMMENT`, `APPROVE`, and
   `REQUEST_CHANGES` are supported. A failed or stale request does not retry a
   write automatically.
7. Sign-out removes the stored user and refresh tokens but keeps the App
   configuration. Clearing the App configuration removes both credentials and
   tokens. Pending authorization is cancellable; cancelled or superseded flows
   must not persist tokens after they settle.

## Consequences

- Private access is not a general GitHub credential pass-through: each request
  remains tied to the active local conversation's GitHub.com origin and GitHub
  enforces the user's and App's permissions.
- Users who do not configure a GitHub App keep public read-only access and
  local editable draft feedback. No external write is implicit.
- Native desktop storage cannot make a user-supplied Client Secret
  confidential from the device owner. The value is kept out of the Renderer
  after saving and uses the Host's existing secret-storage backend.
- GitHub controls token revocation and expiration. Temporary refresh/network
  failures must not discard a still-valid refresh token; invalid or revoked
  tokens require reauthorization.
- Message Review remains message-owned history; Branch Review remains based on
  local Git refs. Neither surface reads or writes GitHub state.

## Alternatives rejected

- **Reuse ambient GitHub CLI authentication:** rejected because it obscures
  which account and permissions authorize a write and is not a controlled
  desktop credential lifecycle.
- **Use a personal access token:** rejected because it is a broad, manually
  managed credential rather than an App-bound user authorization.
- **Send comments or approvals directly from diff clicks:** rejected because
  it omits a text preview and explicit confirmation.
- **Automatically retry write requests:** rejected because an ambiguous
  network failure may occur after GitHub has already accepted the write.
