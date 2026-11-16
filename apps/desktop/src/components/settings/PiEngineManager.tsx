import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type PiEngineOperation, type PiEngineProgress, type PiEngineStatus } from "../../lib/api";
import { Button } from "../ui";
import { SettingsCard } from "../../features/settings/primitives";

const PACKAGE_ROWS = [
  ["@earendil-works/pi-agent-core", "settings.piEngine.packageCore"],
  ["@earendil-works/pi-ai", "settings.piEngine.packageAi"],
  ["@earendil-works/pi-coding-agent", "settings.piEngine.packageCodingAgent"],
] as const;

function latestOperation(status: PiEngineStatus | null): PiEngineOperation | null {
  return status?.operation ?? null;
}

export function PiEngineManager() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PiEngineStatus | null>(null);
  const [busy, setBusy] = useState<"checking" | "updating" | "rollback" | "cancelling" | null>("checking");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<PiEngineProgress | null>(null);

  const applyStatus = useCallback((next: PiEngineStatus) => {
    setStatus(next);
    setProgress(next.operation?.progress ?? null);
    setError(next.operation?.state === "failed" ? next.operation.error ?? null : null);
  }, []);

  const refresh = useCallback(async () => {
    setBusy("checking");
    setError(null);
    try { applyStatus(await api.getPiEngineStatus()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }, [applyStatus]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => api.onPiEngineProgress((next) => {
    setProgress(next);
    setStatus((old) => old?.operation ? {
      ...old,
      operation: { ...old.operation, progress: next, updatedAt: Date.now() },
    } : old);
  }), []);

  const install = async () => {
    setBusy("updating"); setError(null); setProgress(null);
    try { applyStatus(await api.installOrUpdatePiEngine()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await refresh(); }
    finally { setBusy(null); }
  };

  const cancel = async () => {
    setBusy("cancelling"); setError(null);
    try {
      const result = await api.cancelPiEngineOperation();
      if (result.operation) setStatus((old) => old ? { ...old, operation: result.operation } : old);
      if (!result.cancelled) await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  const rollback = async () => {
    setBusy("rollback"); setError(null);
    try { applyStatus(await api.rollbackPiEngine()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  const openReleases = async () => {
    try { await api.openPiEngineReleases(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const openDependencyRepository = async () => {
    try { await api.openPiDependencyRepository(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const operation = latestOperation(status);
  const active = busy === "updating" || busy === "cancelling" || operation?.state === "running" || operation?.state === "cancelling";
  const cancelling = busy === "cancelling" || operation?.state === "cancelling";
  const current = status?.installedManifest ?? status?.runningManifest ?? null;

  return (
    <SettingsCard
      title={t("settings.piEngine.title")}
      description={t("settings.piEngine.description")}
      className="settings-stack"
    >
      <section className="settings-agent-engine-manager" aria-labelledby="pi-engine-manager-title">
        <div className="settings-agent-engine-section-heading">
          <div>
            <h4 id="pi-engine-manager-title" className="settings-row-title">{t("settings.piEngine.runtimeTitle")}</h4>
            <p className="settings-row-detail">{t("settings.piEngine.runtimeDescription")}</p>
          </div>
          {status?.updateAvailable && !status.restartRequired && <span className="settings-agent-engine-state">{t("settings.piEngine.updateAvailable")}</span>}
          {status?.restartRequired && <span className="settings-agent-engine-state">{t("settings.piEngine.restartRequired")}</span>}
        </div>

        {status?.supported === false ? <p role="status" className="settings-row-detail">{t("settings.piEngine.unsupported")}</p> : (
          <>
            <div className="settings-agent-engine-version-grid">
              <div className="settings-agent-engine-version">
                <span className="settings-agent-engine-version-label">{t("settings.piEngine.runningBuild")}</span>
                <strong>{status?.runningManifest?.desktopVersion ?? "—"}</strong>
              </div>
              <div className="settings-agent-engine-version">
                <span className="settings-agent-engine-version-label">{t("settings.piEngine.installedBuild")}</span>
                <strong>{status?.installedManifest?.desktopVersion ?? "—"}</strong>
              </div>
              <div className="settings-agent-engine-version">
                <span className="settings-agent-engine-version-label">{t("settings.piEngine.latestBuild")}</span>
                <strong>{status?.latestReleaseTag ?? "—"}</strong>
              </div>
            </div>

            <div className="settings-agent-engine-version-grid">
              <div className="settings-agent-engine-version">
                <span className="settings-agent-engine-version-label">{t("settings.piEngine.protocol")}</span>
                <strong>{current?.protocolVersion ?? "—"}</strong>
              </div>
              <div className="settings-agent-engine-version">
                <span className="settings-agent-engine-version-label">{t("settings.piEngine.runtime")}</span>
                <strong>{current?.agentRuntimeVersion ?? "—"}</strong>
              </div>
            </div>

            <div className="settings-agent-engine-manager" aria-label={t("settings.piEngine.packageVersions")}>
              <div className="settings-agent-engine-section-heading">
                <h4 className="settings-row-title">{t("settings.piEngine.packageVersions")}</h4>
                <Button size="sm" variant="ghost" onClick={() => void openDependencyRepository()} disabled={busy === "checking"}>
                  {t("settings.piEngine.openPackageRepository")}
                </Button>
              </div>
              <div className="settings-agent-engine-version-grid">
                {PACKAGE_ROWS.map(([packageName, labelKey]) => (
                  <div className="settings-agent-engine-version" key={packageName}>
                    <span className="settings-agent-engine-version-label">{t(labelKey)}</span>
                    <strong>{current?.piPackages[packageName] ?? "—"}</strong>
                    <span className="settings-row-detail">{t("settings.piEngine.npmLatest", { version: status?.latestPackageVersions?.[packageName] ?? "—" })}</span>
                  </div>
                ))}
              </div>
              {current?.piPatchHashes?.["@earendil-works/pi-coding-agent"] && <p className="settings-row-detail">{t("settings.piEngine.patchSet", { digest: current.piPatchHashes["@earendil-works/pi-coding-agent"].slice(0, 16) })}</p>}
            </div>

            {status?.restartRequired && <p role="status" className="settings-row-detail">{t("settings.piEngine.restartHint")}</p>}
            {status?.remoteError && <p role="status" className="settings-row-detail">{status.remoteError}</p>}
            {error && <p role="alert" className="settings-error-text">{error}</p>}
            {operation?.state === "completed" && <p role="status" className="settings-row-detail">{t("settings.piEngine.operationCompleted")}</p>}
            {operation?.state === "cancelled" && <p role="status" className="settings-row-detail">{t("settings.piEngine.operationCancelled")}</p>}
            {active && (
              <div role="status" aria-live="polite" className="settings-agent-engine-progress">
                <div className="settings-row-detail">{cancelling ? t("settings.piEngine.cancelling") : progress ? t(`settings.piEngine.progress.${progress.stage}`, { version: progress.version ?? "", asset: progress.assetName ?? "" }) : t("settings.piEngine.updating")}</div>
                <div className="settings-row-detail">{t("settings.piEngine.operationPersistenceHint")}</div>
                <progress
                  aria-label={t("settings.piEngine.updating")}
                  max={progress?.totalBytes && progress.totalBytes > 0 ? progress.totalBytes : undefined}
                  value={progress?.totalBytes && progress.totalBytes > 0 ? Math.min(progress.downloadedBytes ?? 0, progress.totalBytes) : undefined}
                />
                {progress?.totalBytes && progress.totalBytes > 0 && <div className="settings-row-detail">{Math.floor(((progress.downloadedBytes ?? 0) / progress.totalBytes) * 100)}% · {((progress.downloadedBytes ?? 0) / 1_048_576).toFixed(1)} / {(progress.totalBytes / 1_048_576).toFixed(1)} MB</div>}
              </div>
            )}
            {status?.latestReleaseNotes && <details className="settings-agent-engine-manager"><summary className="settings-row-title">{t("settings.piEngine.releaseNotes")}</summary><pre className="settings-row-detail settings-pi-engine-release-notes">{status.latestReleaseNotes}</pre></details>}
            <div className="settings-agent-engine-actions">
              {active ? (
                <Button variant="secondary" onClick={() => void cancel()} disabled={cancelling || progress?.stage === "activate"}>{cancelling ? t("settings.piEngine.cancelling") : t("settings.piEngine.cancel")}</Button>
              ) : (
                <Button onClick={() => void install()} disabled={busy !== null || !status?.supported || !status.updateAvailable}>{status?.installedManifest ? t("settings.piEngine.update") : t("settings.piEngine.install")}</Button>
              )}
              <Button variant="ghost" onClick={() => void openReleases()} disabled={busy === "checking"}>{t("settings.piEngine.manualDownload")}</Button>
              <div className="settings-agent-engine-actions-spacer" />
              <Button size="sm" variant="secondary" onClick={() => void rollback()} disabled={active || busy !== null || !status?.canRollback}>{t("settings.piEngine.rollback")}</Button>
              <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy !== null}>{t("settings.piEngine.refresh")}</Button>
            </div>
          </>
        )}
      </section>
    </SettingsCard>
  );
}
