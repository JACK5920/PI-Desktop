import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { applyAppLanguage } from "../../lib/app-language";
import type { ComputerGrantView } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import "../../styles/computer-use-widget.css";

export function ComputerUseWidget() {
  const { t } = useTranslation();
  const [grant, setGrant] = useState<ComputerGrantView | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState(false);

  useLayoutEffect(() => api.onComputerGrantChanged(setGrant), []);

  useEffect(() => {
    let cancelled = false;
    void api.computerGrantDescribe().then(({ grant: current }) => {
      if (!cancelled) setGrant(current);
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

  return (
    <section className="computer-use-widget" aria-label={t("computerUse.widgetTitle")}>
      {grant ? (
        <>
          <div className="computer-use-widget-copy">
            <strong>{t("computerUse.widgetTitle")}</strong>
            <span className="computer-use-widget-target" title={grant.targetLabel}>{grant.targetLabel}</span>
            <span className="computer-use-widget-meta">
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
