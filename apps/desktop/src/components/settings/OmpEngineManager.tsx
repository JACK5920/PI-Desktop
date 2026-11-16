import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { OmpEngineOperation, OmpEngineProgress } from "../../lib/api";
import { Button } from "../ui";
import { SettingsCard } from "../../features/settings/primitives";
import type { AppSettings } from "@pi-desktop/shared";
import { getAgentEngine } from "../../../../../packages/shared/src/agent-engine-registry.mjs";
import { OmpCustomModelPanel } from "./OmpCustomModelPanel";

type OmpStatus = {
  supported: boolean;
  installedVersion?: string | null;
  previousVersion?: string | null;
  latestVersion?: string | null;
  canRollback?: boolean;
  operation?: OmpEngineOperation | null;
};
type OmpProgress = OmpEngineProgress;

export function OmpEngineManager({ section = "engine", settings }: { section?: "engine" | "customApi"; settings: AppSettings }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<OmpStatus | null>(null);
  const [busy, setBusy] = useState<"checking" | "updating" | "rollback" | "cancelling" | null>("checking");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<OmpProgress | null>(null);

  const applyStatus = useCallback((next: OmpStatus) => {
    setStatus(next);
    setProgress(next.operation?.progress ?? null);
    if (next.operation?.state === "failed") setError(next.operation.error ?? null);
    else setError(null);
  }, []);

  const refresh = useCallback(async () => {
    setBusy("checking");
    setError(null);
    try {
      applyStatus(await api.getOmpEngineStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [applyStatus]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => api.onOmpEngineProgress((next) => {
    setProgress(next);
    setStatus((old) => old ? {
      ...old,
      operation: old.operation ? { ...old.operation, progress: next, updatedAt: Date.now() } : old.operation,
    } : old);
  }), []);

  const installOrUpdate = async () => {
    setBusy("updating");
    setError(null);
    setProgress(null);
    try {
      applyStatus({ supported: true, ...(await api.installOrUpdateOmpEngine()) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const cancelOperation = async () => {
    setBusy("cancelling");
    setError(null);
    try {
      const result = await api.cancelOmpEngineOperation();
      if (result.operation) {
        setStatus((old) => old ? { ...old, operation: result.operation } : old);
        setProgress(result.operation.progress ?? null);
      }
      if (!result.cancelled) await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const openOfficialReleases = async () => {
    try {
      await api.openOmpReleases();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openEngineStorageFolder = async () => {
    try {
      await api.openOmpEngineStorageFolder();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const rollback = async () => {
    setBusy("rollback");
    setError(null);
    try {
      setStatus({ supported: true, ...(await api.rollbackOmpEngine()) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const importLocal = async () => {
    setBusy("updating");
    setError(null);
    setProgress(null);
    try {
      const result = await api.importLocalOmpEngine();
      if (result.cancelled) return;
      applyStatus({ supported: true, ...result });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  // The custom-service editor is its own panel: one service, many models, the
  // same picker the native AI-service dialog renders.
  if (section === "customApi") return <OmpCustomModelPanel />;

  // The composer owns engine switching; this page only reports the choice so
  // the two entry points cannot drift apart.
  const reportedEngine = settings.defaultAgentEngine ?? settings.agentEngine ?? "pi";
  const currentEngineName = t(getAgentEngine(reportedEngine)?.nameKey ?? "settings.omp.enginePi");
  const operation = status?.operation;
  const operationActive = busy === "updating" || busy === "cancelling" || operation?.state === "running" || operation?.state === "cancelling";
  const cancellationPending = busy === "cancelling" || operation?.state === "cancelling";

  return (
    <SettingsCard
      title={t("settings.agentEngines.managerTitle")}
      description={t("settings.agentEngines.managerDescription")}
      className="settings-stack"
    >
      <>
        <section className="settings-agent-engine-choice" aria-labelledby="agent-engine-choice-title">
          <div className="settings-agent-engine-section-heading">
            <div>
              <h4 id="agent-engine-choice-title" className="settings-row-title">{t("settings.agentEngines.defaultEngine")}</h4>
              <p className="settings-row-detail">{t("settings.agentEngines.defaultEngineHint")}</p>
            </div>
            <span className="settings-agent-engine-state">{currentEngineName}</span>
          </div>
        </section>

        <section className="settings-agent-engine-manager" aria-label={t("settings.agentEngines.managerTitle")}>
          <div className="settings-agent-engine-section-heading">
            <div>
              <h4 className="settings-row-title">{t("settings.agentEngines.managerTitle")}</h4>
              <p className="settings-row-detail">{t("settings.agentEngines.managerDescription")}</p>
            </div>
            {!status?.installedVersion && status?.supported !== false && <span className="settings-agent-engine-state">{t("settings.omp.notInstalled")}</span>}
          </div>
          {status?.supported === false ? <p className="settings-row-detail">{t("settings.omp.unsupported")}</p> : (
            <>
              <div className="settings-agent-engine-version-grid">
                <div className="settings-agent-engine-version">
                  <span className="settings-agent-engine-version-label">{t("settings.omp.installed")}</span>
                  <strong>{status?.installedVersion ?? "—"}</strong>
                </div>
                <div className="settings-agent-engine-version">
                  <span className="settings-agent-engine-version-label">{t("settings.omp.latest")}</span>
                  <strong>{status?.latestVersion ?? "—"}</strong>
                </div>
              </div>
              {error && <p role="alert" className="settings-error-text">{error}</p>}
              {operation?.state === "completed" && <p role="status" className="settings-row-detail">{t("settings.omp.operationCompleted", { version: operation.progress?.version ?? status?.installedVersion ?? "" })}</p>}
              {operation?.state === "cancelled" && <p role="status" className="settings-row-detail">{t("settings.omp.operationCancelled")}</p>}
              {operationActive && (
                <div role="status" aria-live="polite" className="settings-agent-engine-progress">
                  <div className="settings-row-detail">{cancellationPending ? t("settings.omp.cancelling") : progress ? t(`settings.omp.progress.${progress.stage}`, { version: progress.version, asset: progress.assetName ?? "" }) : t("settings.omp.updating")}</div>
                  <div className="settings-row-detail">{t("settings.omp.operationPersistenceHint")}</div>
                  <progress
                    aria-label={t("settings.omp.updating")}
                    max={progress?.totalBytes && progress.totalBytes > 0 ? progress.totalBytes : undefined}
                    value={progress?.totalBytes && progress.totalBytes > 0 ? Math.min(progress.downloadedBytes ?? 0, progress.totalBytes) : undefined}
                  />
                  {progress?.totalBytes && progress.totalBytes > 0 && <div className="settings-row-detail">{Math.floor(((progress.downloadedBytes ?? 0) / progress.totalBytes) * 100)}% · {((progress.downloadedBytes ?? 0) / 1_048_576).toFixed(1)} / {(progress.totalBytes / 1_048_576).toFixed(1)} MB</div>}
                </div>
              )}
              <div className="settings-agent-engine-actions">
                {operationActive ? (
                  <Button variant="secondary" onClick={() => void cancelOperation()} disabled={cancellationPending || operation?.progress?.stage === "activate" || progress?.stage === "activate"}>
                    {cancellationPending ? t("settings.omp.cancelling") : t("settings.omp.cancel")}
                  </Button>
                ) : (
                  <Button onClick={() => void installOrUpdate()} disabled={busy !== null || !status?.supported}>
                  {status?.installedVersion ? t("settings.omp.update") : t("settings.omp.install")}
                  </Button>
                )}
                <Button variant="secondary" onClick={() => void importLocal()} disabled={operationActive || busy !== null || !status?.supported}>{t("settings.omp.importLocal")}</Button>
                <Button variant="ghost" onClick={() => void openEngineStorageFolder()} disabled={busy === "checking" || !status?.supported}>{t("settings.omp.openEngineFolder")}</Button>
                <Button variant="ghost" onClick={() => void openOfficialReleases()} disabled={busy === "checking"}>{t("settings.omp.manualDownload")}</Button>
                <div className="settings-agent-engine-actions-spacer" />
                <Button size="sm" variant="secondary" onClick={() => void rollback()} disabled={operationActive || busy !== null || !status?.canRollback}>{t("settings.omp.rollback")}</Button>
                <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy !== null}>{t("settings.omp.refresh")}</Button>
              </div>
            </>
          )}
        </section>
      </>
    </SettingsCard>
  );
}
