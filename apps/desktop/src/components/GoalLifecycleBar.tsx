import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  GOAL_BUDGET_LIMITS,
  type GoalControlAction,
  type GoalLifecycle,
  type GoalProgressEvent,
} from "@pi-desktop/shared";
import {
  formatGoalElapsed,
  goalElapsedMs,
  goalTokensUsed,
} from "../lib/goal-lifecycle-state";
import {
  goalBudgetDraftFromBudget,
  validateGoalBudgetDraft,
  type GoalBudgetDraft,
} from "../lib/goal-budget-form";
import { useAppStore } from "../stores/app-store";
import { Badge, Button, Field, Input, SettingsToggle } from "./ui";

function statusTone(
  status: GoalLifecycle["status"],
): "neutral" | "success" | "error" | "warning" {
  if (status === "completed") return "success";
  if (status === "blocked") return "error";
  if (status === "paused" || status === "interrupted") return "warning";
  return "neutral";
}

function statusDetail(goal: GoalLifecycle, t: TFunction): string {
  if (goal.status === "active") {
    return t("goal.lifecycle.round", {
      round: goal.roundInCycle,
      max: goal.maxRounds,
      cycle: goal.cycle,
    });
  }
  if (goal.status === "blocked") {
    return goal.latestReport?.summary || t("goal.lifecycle.blockedFallback");
  }
  if (goal.status === "paused") {
    if (goal.stopReason === "GOAL_BUDGET_EXHAUSTED") {
      return t("goal.lifecycle.budgetLimit");
    }
    return goal.stopReason === "GOAL_AUTO_ROUND_LIMIT"
      ? t("goal.lifecycle.roundLimit", { max: goal.maxRounds })
      : t("goal.lifecycle.pausedByUser");
  }
  if (goal.status === "interrupted") {
    return goal.stopReason === "host_restart" || goal.stopReason === "migration_requires_review"
      ? t("goal.lifecycle.restartInterrupted")
      : t("goal.lifecycle.interrupted");
  }
  return "";
}

export function GoalLifecycleBar({
  goal,
  liveProgress,
}: {
  goal: GoalLifecycle;
  liveProgress?: GoalProgressEvent;
}) {
  const { t, i18n } = useTranslation();
  const sessionId = goal.sessionId;
  const controlGoal = useAppStore((state) => state.controlGoal);
  const updateGoalBudget = useAppStore((state) => state.updateGoalBudget);
  const showToast = useAppStore((state) => state.showToast);
  const proposal = useAppStore((state) => state.planCheckpoints[sessionId]);
  const [busy, setBusy] = useState<GoalControlAction | "budget" | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<GoalBudgetDraft | null>(null);
  const [budgetError, setBudgetError] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (
      goal.status !== "active" ||
      typeof goal.cycleStartedAt !== "number" ||
      !Number.isFinite(goal.cycleStartedAt)
    ) {
      return;
    }
    const refreshNow = () => setNowMs(Date.now());
    refreshNow();
    const interval = window.setInterval(refreshNow, 1_000);
    return () => window.clearInterval(interval);
  }, [goal.status, goal.cycleStartedAt, goal.currentExecutionId]);

  if (goal.status === "cleared") return null;

  const runAction = async (action: GoalControlAction) => {
    if (busy) return;
    if (action === "clear" && !window.confirm(t("goal.lifecycle.clearConfirm"))) {
      return;
    }
    setBusy(action);
    try {
      await controlGoal(sessionId, goal.proposalId, action);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
        sessionId,
      });
    } finally {
      setBusy(null);
    }
  };

  const canResume = ["paused", "blocked", "interrupted"].includes(goal.status);
  const canPause = goal.status === "active";
  const canEditBudget = ["active", "paused", "blocked", "interrupted"].includes(goal.status);
  const formatTokens = (value: number) => new Intl.NumberFormat().format(value);
  const formatMinutes = (value: number) => `${Math.ceil(value / 60_000)}m`;
  const elapsedMs = goalElapsedMs(goal, nowMs);
  const tokensUsed = goalTokensUsed(goal, liveProgress);
  const elapsed = formatGoalElapsed(elapsedMs, i18n.resolvedLanguage || i18n.language);
  const budgetValidation = budgetDraft ? validateGoalBudgetDraft(budgetDraft) : null;

  const startBudgetEdit = () => {
    setBudgetError(false);
    setBudgetDraft(
      goalBudgetDraftFromBudget({
        maxRounds: goal.maxRounds,
        maxTokens: goal.maxTokens,
        maxDurationMs: goal.maxDurationMs,
        tokenBudgetUnlimited: goal.tokenBudgetUnlimited === true,
      }),
    );
  };

  const saveBudget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!budgetDraft || !budgetValidation?.budget || busy) {
      setBudgetError(true);
      return;
    }
    setBusy("budget");
    setBudgetError(false);
    try {
      await updateGoalBudget(sessionId, goal.proposalId, budgetValidation.budget);
      setBudgetDraft(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
        sessionId,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="goal-lifecycle-bar"
      role="region"
      aria-label={t("goal.lifecycle.region")}
      aria-busy={busy !== null}
      data-testid="goal-lifecycle-bar"
      data-status={goal.status}
      data-proposal-id={goal.proposalId}
    >
      <div className="goal-lifecycle-copy">
        <div className="goal-lifecycle-heading">
          <h2 className="goal-lifecycle-title">
            {proposal?.id === goal.proposalId && proposal.title.trim()
              ? proposal.title
              : goal.title.trim() || t("goal.untitled")}
          </h2>
          <Badge tone={statusTone(goal.status)}>{t(`goal.lifecycle.status.${goal.status}`)}</Badge>
        </div>
        <p className="goal-lifecycle-detail">{statusDetail(goal, t)}</p>
        <p className="goal-lifecycle-budget">
          {goal.tokenBudgetUnlimited
            ? t("goal.lifecycle.budgetUnlimited", {
                tokens: formatTokens(tokensUsed),
                elapsed,
                maxDuration: formatMinutes(goal.maxDurationMs),
              })
            : t("goal.lifecycle.budget", {
                tokens: formatTokens(tokensUsed),
                maxTokens: formatTokens(goal.maxTokens),
                elapsed,
                maxDuration: formatMinutes(goal.maxDurationMs),
              })}
        </p>
        {goal.latestReport ? (
          <details className="goal-lifecycle-report">
            <summary>{t("goal.lifecycle.latestReport")}</summary>
            <p>{goal.latestReport.summary}</p>
            <ul>
              {goal.latestReport.criteria.map((criterion, index) => (
                <li key={`${criterion.criterion}-${index}`}>
                  <span className="goal-lifecycle-criterion">
                    {t(`goal.lifecycle.criteria.${criterion.status}`)}: {criterion.criterion}
                  </span>
                  <ul>
                    {criterion.evidence.map((evidence, evidenceIndex) => (
                      <li key={`${evidenceIndex}-${evidence}`}>{evidence}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      {budgetDraft ? (
        <form
          className="goal-budget-editor"
          data-testid="goal-budget-editor"
          onSubmit={(event) => void saveBudget(event)}
        >
          <Field label={t("goal.lifecycle.roundBudgetLabel")}>
            <Input
              aria-label={t("goal.lifecycle.roundBudgetLabel")}
              data-testid="goal-budget-rounds"
              type="number"
              min={GOAL_BUDGET_LIMITS.minRounds}
              max={GOAL_BUDGET_LIMITS.maxRounds}
              step={1}
              value={budgetDraft.maxRounds}
              disabled={busy !== null}
              onChange={(event) => setBudgetDraft({ ...budgetDraft, maxRounds: event.target.value })}
            />
          </Field>
          <Field label={t("goal.lifecycle.tokenBudgetLabel")}>
            <Input
              aria-label={t("goal.lifecycle.tokenBudgetLabel")}
              data-testid="goal-budget-tokens"
              type="number"
              min={GOAL_BUDGET_LIMITS.minTokens}
              max={GOAL_BUDGET_LIMITS.maxTokens}
              step={1}
              value={budgetDraft.maxTokens}
              disabled={busy !== null}
              onChange={(event) => setBudgetDraft({ ...budgetDraft, maxTokens: event.target.value })}
            />
          </Field>
          <Field label={t("goal.lifecycle.timeBudgetLabel")}>
            <Input
              aria-label={t("goal.lifecycle.timeBudgetLabel")}
              data-testid="goal-budget-minutes"
              type="number"
              min={GOAL_BUDGET_LIMITS.minDurationMs / 60_000}
              max={GOAL_BUDGET_LIMITS.maxDurationMs / 60_000}
              step={1}
              value={budgetDraft.maxDurationMinutes}
              disabled={busy !== null}
              onChange={(event) => setBudgetDraft({ ...budgetDraft, maxDurationMinutes: event.target.value })}
            />
          </Field>
          <div className="goal-budget-unlimited">
            <span>{t("goal.lifecycle.unlimitedTokenBudget")}</span>
            <SettingsToggle
              checked={budgetDraft.tokenBudgetUnlimited}
              label={t("goal.lifecycle.unlimitedTokenBudget")}
              disabled={busy !== null}
              onChange={() =>
                setBudgetDraft({
                  ...budgetDraft,
                  tokenBudgetUnlimited: !budgetDraft.tokenBudgetUnlimited,
                })
              }
            />
          </div>
          {budgetDraft.tokenBudgetUnlimited ? (
            <p className="goal-budget-hint" data-testid="goal-budget-unlimited-hint">
              {t("goal.lifecycle.unlimitedTokenBudgetHint")}
            </p>
          ) : null}
          {budgetError || !budgetValidation?.valid ? (
            <p className="goal-budget-error" role="alert">
              {t("goal.lifecycle.budgetInvalid")}
            </p>
          ) : null}
          <div className="goal-budget-actions">
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy !== null}
              data-testid="goal-budget-cancel"
              onClick={() => setBudgetDraft(null)}
            >
              {t("goal.lifecycle.cancelBudgetEdit")}
            </Button>
            <Button
              size="sm"
              type="submit"
              variant="primary"
              disabled={busy !== null || !budgetValidation?.valid}
              data-testid="goal-budget-save"
            >
              {busy === "budget" ? t("goal.lifecycle.savingBudget") : t("goal.lifecycle.saveBudget")}
            </Button>
          </div>
        </form>
      ) : null}
      <div className="goal-lifecycle-actions">
        {canEditBudget ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            data-testid="goal-budget-edit"
            onClick={startBudgetEdit}
          >
            {t("goal.lifecycle.editBudget")}
          </Button>
        ) : null}
        {canPause ? (
          <Button
            size="sm"
            disabled={busy !== null}
            data-testid="goal-pause"
            onClick={() => void runAction("pause")}
          >
            {busy === "pause" ? t("goal.lifecycle.pausing") : t("goal.lifecycle.pause")}
          </Button>
        ) : null}
        {canResume ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null}
            data-testid="goal-resume"
            onClick={() => void runAction("resume")}
          >
            {busy === "resume" ? t("goal.lifecycle.resuming") : t("goal.lifecycle.resume")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          data-testid="goal-clear"
          onClick={() => void runAction("clear")}
        >
          {busy === "clear" ? t("goal.lifecycle.clearing") : t("goal.lifecycle.clear")}
        </Button>
      </div>
    </section>
  );
}
