import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { GoalControlAction, GoalLifecycle } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { Badge, Button } from "./ui";

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

export function GoalLifecycleBar({ goal }: { goal: GoalLifecycle }) {
  const { t } = useTranslation();
  const sessionId = goal.sessionId;
  const controlGoal = useAppStore((state) => state.controlGoal);
  const showToast = useAppStore((state) => state.showToast);
  const proposal = useAppStore((state) => state.planCheckpoints[sessionId]);
  const [busy, setBusy] = useState<GoalControlAction | null>(null);

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
  const formatTokens = (value: number) => new Intl.NumberFormat().format(value);
  const formatMinutes = (value: number) => `${Math.ceil(value / 60_000)}m`;

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
          {t("goal.lifecycle.budget", {
            tokens: formatTokens(goal.tokensUsed),
            maxTokens: formatTokens(goal.maxTokens),
            elapsed: formatMinutes(goal.elapsedMs),
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
      <div className="goal-lifecycle-actions">
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
