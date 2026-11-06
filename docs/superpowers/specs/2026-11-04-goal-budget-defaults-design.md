# Goal Budget Defaults in System Settings

## Intent

Let users choose the default execution budgets for Goals in System Settings,
with unlimited reported tokens enabled by default. This gives long-running
Goals room to continue without hiding the existing round, time, accounting, or
per-Goal controls.

## Goals and non-goals

- Add Goal budget defaults to the AI section of System Settings.
- New approved Goals snapshot those defaults into their own Host-owned
  lifecycle.
- Keep the existing per-Goal budget editor and all Host-side budget checks.
- Preserve usage tracking in unlimited-token mode; unlimited skips only the
  token cutoff.
- Do not change existing Goal lifecycles, approval behavior, execution
  recovery, or the immutable Goal contract.
- Do not remove round or elapsed-time limits or change how current Goals can
  override their own budgets.

## Current behavior

The AI settings page has no Goal budget controls. The Host creates every new
Goal with fixed defaults (8 rounds, 250,000 tokens, 60 minutes, finite token
mode). A user can edit those limits later in the Goal lifecycle bar. App
settings are already stored as a JSON object through the existing Host
`settings.get` / `settings.set` path, and the Goal lifecycle stores its own
budget snapshot separately.

## Approaches considered

1. **Only global limits, no per-Goal overrides.** Rejected because users
   already have a useful, persisted per-Goal editor and sometimes need one Goal
   to differ from future defaults.
2. **Global defaults plus per-Goal overrides (chosen).** Put default values in
   System Settings and copy them into each Goal when it is approved. Existing
   Goals remain untouched. This centralizes the normal choice without making
   one preference silently rewrite active work.
3. **Global setting retroactively updates every Goal.** Rejected because a
   preference change could silently stop or extend existing work, including a
   currently active Goal, and would make the per-Goal persisted values
   ambiguous.

## Decisions

- Add optional `AppSettings.goalBudgetDefaults` with `maxRounds`, `maxTokens`,
  `maxDurationMs`, and `tokenBudgetUnlimited`.
- Defaults for newly approved Goals: 8 rounds, 250,000 retained finite tokens,
  60 minutes, and `tokenBudgetUnlimited = true`.
- Keep existing ranges: rounds 1–32; finite token values are positive safe
  integers; duration 1–1,440 minutes.
- Keep the finite token value editable and retained while unlimited mode is
  selected.
- Place a “Goal defaults” card in the existing AI System Settings destination.
  These controls configure new Goals; the Goal lifecycle bar continues to
  display and edit the current Goal's effective limits.
- The Host reads the persisted defaults when approval creates the durable Goal
  lifecycle. This keeps Host ownership authoritative and avoids adding values
  to the approval or execution RPC contracts.
- Apply settings only when a Goal is approved after the setting is saved.
  Existing active, paused, blocked, interrupted, completed, and pending
  lifecycles keep their current data. There is no database schema migration.
- Treat this as a portable application preference using the existing
  application settings sync allowlist.
- Unlimited mode continues to count provider-reported tokens and retains the
  configured round/time ceilings and manual resume rules.

## Acceptance

- Missing `goalBudgetDefaults` resolves to the defaults above, including
  unlimited tokens.
- Invalid settings writes are rejected at the Host boundary and do not replace
  the last valid value.
- A newly approved Goal receives a snapshot of the configured defaults.
- Saving new defaults never mutates an already-created Goal.
- The settings UI allows editing the finite token value while unlimited is on;
  switching back to finite restores that saved value.
- Existing per-Goal editing, usage accounting, round/time enforcement,
  approval, and restart behavior remain unchanged.
- Application settings sync includes the non-sensitive Goal defaults.

## Risks and constraints

- The JSON settings object is intentionally backward-compatible: older builds
  may ignore the new optional field. They also keep their previous Goal
  creation defaults, so the preference applies when a build that understands
  it creates a Goal.
- Unlimited token mode is not a provider cost cap. Existing round/time limits
  remain the product safeguards; users can configure them in System Settings.
- No provider credential, permission mode, shell permission, or execution
  authorization changes are in scope.
