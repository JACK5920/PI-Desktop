import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { applyAppLanguage } from "../../lib/app-language";
import type { ComputerGrantView, ComputerRunActivity } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import "../../styles/computer-use-widget.css";

export function ComputerUseWidget() {
  const { t } = useTranslation();
  const [grant, setGrant] = useState<ComputerGrantView | null>(null);
  const [activity, setActivity] = useState<ComputerRunActivity | null>(null);
  const grantIdRef = useRef<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState(false);

  useLayoutEffect(() => {
    const unsubscribeGrant = api.onComputerGrantChanged((next) => {
      grantIdRef.current = next?.grantId ?? null;
      setGrant(next);
      setActivity((current) => next && current?.grantId === next.grantId ? current : null);
    });
    const unsubscribeActivity = api.onComputerActivityChanged((next) => {
      setActivity(next?.grantId === grantIdRef.current ? next : null);
    });
    return () => {
      unsubscribeGrant();
      unsubscribeActivity();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.computerGrantDescribe().then(({ grant: current }) => {
      if (!cancelled) {
        grantIdRef.current = current?.grantId ?? null;
        setGrant(current);
      }
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    void api.getSettings().then((settings) => {
      if (!cancelled) applyAppLanguage(settings.language);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!grant) {
      setStopping(false);
      setError(false);
    }
  }, [grant?.grantId]);

  const stop = async () => {
    if (!grant || stopping) return;
    setStopping(true);
    setError(false);
    try {
      const result = await api.computerGrantRevoke({ sessionId: grant.sessionId, grantId: grant.grantId });
      if (!result.requested) setError(true);
    } catch {
      setError(true);
    } finally {
      setStopping(false);
    }
  };

  const phase = activity?.phase ?? "starting";
  const phaseText = t(`computerUse.activityPhase.${phase}`);
  const actionText = activity?.action ? t(`computerUse.activityAction.${activity.action}`) : null;
  const verificationText = activity?.verification ? t(`computerUse.verificationStatus.${activity.verification}`) : null;
  const captureStatusText = activity?.captureStatus ? t(`computerUse.captureStatus.${activity.captureStatus}`) : null;
  const currentActivity = [phaseText, actionText, verificationText, activity?.target ?? grant?.targetLabel]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const recentActivity = activity?.recentSteps.slice(-2).map((step) => {
    const action = step.action === "done" ? t("computerUse.completionCheck") : t(`computerUse.activityAction.${step.action}`);
    const status = step.verification ? t(`computerUse.verificationStatus.${step.verification}`) : null;
    return [action, step.target, status].filter((part): part is string => Boolean(part)).join(" · ");
  }).join("  ›  ");

  return (
    <section className="computer-use-widget" aria-label={t("computerUse.widgetTitle")}>
      {grant ? (
        <>
          <div className="computer-use-widget-copy">
            <strong>{t("computerUse.widgetTitle")}</strong>
            <span className="computer-use-widget-target" title={currentActivity} aria-live="polite">{currentActivity}</span>
            <span className="computer-use-widget-meta">
              {recentActivity ? `${t("computerUse.recentSteps")}: ${recentActivity}` : null}
              {recentActivity ? " · " : null}
              {captureStatusText ? `${captureStatusText} · ` : null}
              {t("computerUse.widgetBudget", { count: grant.remainingBudget })} · {grant.capture === "a11y-and-pixels"
                ? t("settings.computerUseAccessibilityAndPixels")
                : t("computerUse.captureA11yOnly")}
            </span>
            {error ? <span className="computer-use-widget-error" role="alert">{t("computerUse.stopFailed")}</span> : null}
          </div>
          <Button className="computer-use-widget-stop" variant="secondary" disabled={stopping} onClick={() => void stop()}>
            {stopping ? t("computerUse.stopping") : t("computerUse.stop")}
          </Button>
        </>
      ) : error ? <span role="status">{t("computerUse.stateUnavailable")}</span> : null}
    </section>
  );
}
