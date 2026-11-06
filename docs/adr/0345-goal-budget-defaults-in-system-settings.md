# ADR 0345: Configure Goal budget defaults in AI Settings

- Status: Accepted for implementation
- Date: 2026-11-04
- Deciders: PI-Desktop maintainers
- Related: ADR 0338 (persisted Goal lifecycle), ADR 0344 (per-cycle Goal budgets),
  D679, D684
- Amends: ADR 0344's default token mode and settings scope; ADR 0344's per-Goal
  override, lifecycle, and schema-v30 decisions remain unchanged

## Context

ADR 0344 made per-cycle Goal budgets editable and added an explicit unlimited
token mode, but users could only change limits after approving each Goal. The
fixed finite default could also stop a long Goal even when the user wanted
unlimited token usage. Users need one settings surface for the behavior applied
to future Goals, while retaining per-Goal overrides and the existing Host-owned
approval/lifecycle boundary.

## Decision

1. Store `AppSettings.goalBudgetDefaults` as an optional application setting
   with `maxRounds`, `maxTokens`, `maxDurationMs`, and
   `tokenBudgetUnlimited`. Normalize missing or malformed stored values to
   eight rounds, 250,000 retained finite tokens, 60 minutes, and unlimited
   tokens enabled. Validate settings writes in host-core.
2. Expose these defaults in a Goal budget card on Settings → AI. The token
   number remains editable while unlimited mode is enabled, and toggling back
   to finite mode restores that retained value. Settings changes are portable
   application preferences and participate in the existing configuration sync.
3. When an approval creates a Goal lifecycle, host-core reads the latest saved
   settings in the approval transaction and snapshots the normalized budget
   into that lifecycle. A settings change affects only Goals approved later;
   it never rewrites an existing Goal, including an active one. The existing
   Goal lifecycle editor remains the per-Goal override surface.
4. Unlimited-token mode continues to record and display provider-reported
   usage, but skips only the token cutoff. Round/time limits, explicit manual
   resume, and no-replay recovery remain unchanged.
5. Do not add a schema or RPC version migration. The setting lives in the
   existing Host-owned application settings JSON; protocol v11 and schema v30
   remain unchanged.

## Consequences

- Users can change future Goal behavior centrally without repeatedly editing
  every new Goal.
- Each approved Goal keeps a stable budget snapshot even if global defaults
  change while it is active.
- Existing profiles acquire the new default through Host normalization, while
  existing persisted Goal cycles retain their saved values.
- Because unlimited is the default for newly approved Goals, only the round
  and elapsed-time ceilings bound automatic continuation unless the user
  selects a finite token default or per-Goal override.

## Alternatives considered

- Keep finite token mode as the default and require per-Goal editing: rejected
  because long-running users must repeat a preference and can hit the finite
  cutoff unexpectedly.
- Apply changed defaults to all existing Goals: rejected because it would
  mutate active execution contracts and undermine the lifecycle's durable
  snapshot semantics.
- Remove token accounting or the per-Goal budget editor: rejected because
  usage visibility and explicit per-Goal control remain useful even when the
  default token cutoff is unlimited.
