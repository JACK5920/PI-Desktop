import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  GOAL_BUDGET_LIMITS,
  normalizeGoalBudgetDefaults,
  type AppSettings,
} from "@pi-desktop/shared";
import { Button, Field, Input, SettingsToggle } from "../../components/ui";
import { goalBudgetDraftFromBudget, validateGoalBudgetDraft } from "../../lib/goal-budget-form";
import { SettingsCard, SettingsRow } from "./primitives";

export function GoalBudgetDefaultsCard({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() =>
    goalBudgetDraftFromBudget(normalizeGoalBudgetDefaults(settings.goalBudgetDefaults)),
  );
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const validation = validateGoalBudgetDraft(draft);

  useEffect(() => {
    setDraft(
      goalBudgetDraftFromBudget(normalizeGoalBudgetDefaults(settings.goalBudgetDefaults)),
    );
    setSaveFailed(false);
  }, [settings.goalBudgetDefaults]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validation.budget || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await saveSettings({ goalBudgetDefaults: validation.budget });
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title={t("settings.goalBudgetDefaultsTitle")}
      description={t("settings.goalBudgetDefaultsDescription")}
      action={
        <Button
          form="goal-budget-defaults-form"
          type="submit"
          size="sm"
          variant="primary"
          disabled={saving || !validation.valid}
          data-testid="goal-budget-defaults-save"
        >
          {saving ? t("settings.goalBudgetSaving") : t("settings.goalBudgetSave")}
        </Button>
      }
    >
      <form
        id="goal-budget-defaults-form"
        className="settings-form-grid goal-budget-defaults-form"
        onSubmit={(event) => void save(event)}
      >
        <p className="goal-budget-hint">
          {t("settings.goalBudgetDefaultsDescription")}
        </p>
        <Field label={t("settings.goalBudgetRounds")}>
          <Input
            className="goal-budget-defaults-input"
            aria-label={t("settings.goalBudgetRounds")}
            aria-invalid={!validation.fields.maxRounds}
            data-testid="goal-budget-defaults-rounds"
            type="number"
            min={GOAL_BUDGET_LIMITS.minRounds}
            max={GOAL_BUDGET_LIMITS.maxRounds}
            step={1}
            value={draft.maxRounds}
            disabled={saving}
            onChange={(event) => setDraft({ ...draft, maxRounds: event.target.value })}
          />
        </Field>
        <Field label={t("settings.goalBudgetTokens")}>
          <Input
            className="goal-budget-defaults-input"
            aria-label={t("settings.goalBudgetTokens")}
            aria-invalid={!validation.fields.maxTokens}
            data-testid="goal-budget-defaults-tokens"
            type="number"
            min={GOAL_BUDGET_LIMITS.minTokens}
            max={GOAL_BUDGET_LIMITS.maxTokens}
            step={1}
            value={draft.maxTokens}
            disabled={saving}
            onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value })}
          />
        </Field>
        <Field label={t("settings.goalBudgetDuration")}>
          <Input
            className="goal-budget-defaults-input"
            aria-label={t("settings.goalBudgetDuration")}
            aria-invalid={!validation.fields.maxDurationMinutes}
            data-testid="goal-budget-defaults-duration"
            type="number"
            min={GOAL_BUDGET_LIMITS.minDurationMs / 60_000}
            max={GOAL_BUDGET_LIMITS.maxDurationMs / 60_000}
            step={1}
            value={draft.maxDurationMinutes}
            disabled={saving}
            onChange={(event) => setDraft({ ...draft, maxDurationMinutes: event.target.value })}
          />
        </Field>
        <SettingsRow title={t("settings.goalBudgetUnlimited")}>
          <SettingsToggle
            checked={draft.tokenBudgetUnlimited}
            label={t("settings.goalBudgetUnlimited")}
            disabled={saving}
            onChange={() =>
              setDraft({ ...draft, tokenBudgetUnlimited: !draft.tokenBudgetUnlimited })
            }
          />
        </SettingsRow>
        {draft.tokenBudgetUnlimited ? (
          <p className="goal-budget-hint" data-testid="goal-budget-defaults-unlimited-hint">
            {t("settings.goalBudgetUnlimitedHint")}
          </p>
        ) : null}
        {!validation.valid ? (
          <p className="goal-budget-error" role="alert">
            {t("settings.goalBudgetInvalid")}
          </p>
        ) : null}
        {saveFailed ? (
          <p className="goal-budget-error" role="alert">
            {t("settings.goalBudgetSaveFailed")}
          </p>
        ) : null}
      </form>
    </SettingsCard>
  );
}
