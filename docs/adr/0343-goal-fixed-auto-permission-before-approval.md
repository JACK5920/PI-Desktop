# ADR 0343: Goal Uses Fixed Auto Permission Before Approval

- Status: Accepted for implementation
- Date: 2026-11-03
- Deciders: PI-Desktop maintainers
- Related: ADR 0053, ADR 0211, ADR 0338, D198
- Amends: Goal permission behavior in D198 and the permission UX specification

## Context

Goal displays a fixed Auto permission chip and does not offer the normal
permission-mode menu. Its approval card separately asks the user to choose the
permission mode for the approved Agent execution. Host-core currently resolves
the Goal contract phase from the stored session permission and global default,
so an inherited Ask session can display Auto while Bash still opens a
permission card. The visible mode and the authoritative policy therefore
disagree.

## Decision

1. While the Host-owned durable session mode is Goal, permission evaluation
   uses Auto for the Goal contract phase, regardless of the stored session
   permission or global default.
2. This is an effective policy only; entering or leaving Goal does not mutate
   the persisted session permission. Returning to Agent or Plan resumes the
   existing session/global resolution.
3. An explicit permission scope on a delegated call keeps its existing
   precedence. The durable session mode and contract tool allowlist remain
   Host-owned; renderer or sidecar mode claims cannot grant a tool.
4. The existing Goal contract hard-deny remains ahead of permission mode:
   Write, Edit, unknown tools, the other contract submit tool, and plugin tools
   without declared safe actions remain denied. Bash and other admitted tools
   follow the fixed Auto posture.
5. Approving a Goal still transitions the session to Agent and applies the
   mode explicitly selected on the approval card (Ask by default). That mode
   governs the approved execution, not the preceding Goal contract phase.

No protocol, IPC, database, or persisted-data change is introduced.

## Consequences

- The Auto chip and Host behavior agree while Goal is active.
- Goal Bash can mutate workspace or scratch state without a permission card;
  the existing warning and path, shell, timeout, and cancellation checks remain.
- A session's prior permission preference is preserved when the user leaves
  Goal.
- The post-approval execution remains a separate, explicit permission decision.

## Alternatives

### Keep Ask behavior and display the stored mode

Rejected because Goal intentionally has a fixed Auto chip and no permission
menu; a displayed Ask state would contradict the accepted Goal UX.

### Persist Auto when entering Goal

Rejected because it would silently alter the user's durable session preference
after switching back to Agent.

### Trust the renderer to send Auto

Rejected because the Host must remain authoritative for permission decisions.

## References

- docs/spec/03-runtime/03-tools-and-permissions.md
- docs/spec/03-runtime/05-host-core-rust.md
- docs/spec/03-runtime/06-host-rpc-protocol.md
- docs/spec/04-ux/03-permission-ux.md
- docs/spec/04-ux/08-component-spec.md
- docs/spec/06-delivery/04-e2e-test-plan.md E2E-019c and E2E-121
