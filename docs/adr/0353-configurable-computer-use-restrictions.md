# ADR 0353: Make Computer Use application restrictions user-configurable

- Status: Accepted
- Date: 2026-11-08
- Decision: D690
- Deciders: PI-Desktop core
- Related: [ADR 0349](0349-os-computer-use-capability.md) ·
  [ADR 0350](0350-computer-use-whole-desktop-grant.md) ·
  [Computer Use spec](../spec/03-runtime/computer-use.md)

## Context

ADR 0350 made Computer Use an autonomous desktop-wide capability, but kept
several Host refusals unconditionally fixed. The product owner wants these
application-level restrictions to be manually configurable in Settings while
keeping the current behavior as the compatibility default.

## Decision

1. Computer Use Settings add four independently configurable restrictions:
   self-target blocking, secure/password-input blocking, target-denylist
   enforcement, and elevated-target blocking. Missing values default to the
   existing restrictive behavior.
2. A master `disableAll` setting temporarily overrides those four restrictions
   without erasing their individual values. Turning it off restores the saved
   per-item settings.
3. Host-core reads the effective policy from the existing app settings record
   on every Computer RPC. Renderer state cannot grant authority to itself.
4. The OS remains authoritative for operating-system permissions. Stop,
   request/schema validation, native target ownership checks, stale geometry
   checks, and the host-owned grant lifecycle remain active regardless of
   these switches.
5. No database migration is required: the settings object is additive and
   absent fields map to the current defaults. The user must explicitly enable
   any relaxation.

## Consequences

- Users can choose which application-level refusals apply, or temporarily
  disable all four through the master switch.
- If secure-input blocking is disabled, password/control information exposed by
  the platform backend can reach the selected model context; configured pixel
  capture can include the bound window. This is not logged as typed text or
  stored screenshots.
- Older settings remain compatible and keep all four restrictions enabled.
- The existing Computer Use capability and its audit event flow remain owned
  by Host-core; no plugin API or third-party permission contract changes.

## Alternatives considered

- Keep all refusals permanently hard-coded: rejected because users cannot
  configure the explicitly requested behavior.
- Make relaxed behavior the default: rejected to preserve existing installs
  and minimize migration surprises.
- Put policy decisions in the renderer: rejected because the renderer is not
  authoritative for Host capability enforcement.
