import { useCallback, useEffect, useState, type Dispatch, type SetStateAction, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TFunction } from "i18next";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { IconBot, IconCheck, IconChevronDown } from "../../../components/icons";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { composerEngineMenuFocusIndex } from "./omp-engine-compatibility.mjs";
import { AGENT_ENGINE_REGISTRY, getAgentEngine, type AgentEngineId } from "../../../../../../packages/shared/src/agent-engine-registry.mjs";
import { agentEngineForState } from "../../../lib/session-agent-engine";

type EngineStatus = Awaited<ReturnType<typeof api.getOmpEngineStatus>>;
type EngineIssue = "checking" | "statusUnavailable" | "unsupportedPlatform" | "notInstalled";

export function ComposerEnginePicker({
  t,
  controlsBlocked,
  open,
  setOpen,
  onCloseOtherMenus,
  onIssueChange,
}: {
  t: TFunction;
  controlsBlocked: boolean;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  onCloseOtherMenus: () => void;
  onIssueChange: (issue: EngineIssue | null) => void;
}) {
  const engine = useAppStore(agentEngineForState);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const refreshStatus = useCallback(async (): Promise<EngineStatus | null> => {
    setStatusLoading(true);
    setStatusFailed(false);
    try {
      const nextStatus = await api.getOmpEngineStatus();
      setStatus(nextStatus);
      return nextStatus;
    } catch {
      setStatusFailed(true);
      return null;
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (engine === "omp" && status === null && !statusLoading && !statusFailed) {
      void refreshStatus();
    }
  }, [engine, refreshStatus, status, statusFailed, statusLoading]);

  const issue: EngineIssue | null = engine !== "omp"
    ? null
    : statusLoading || status === null && !statusFailed
      ? "checking"
      : statusFailed
        ? "statusUnavailable"
        : status?.supported !== true
          ? "unsupportedPlatform"
          : !status.installedVersion
            ? "notInstalled"
          : null;

  useEffect(() => onIssueChange(issue), [issue, onIssueChange]);

  const selectEngine = async (next: AgentEngineId) => {
    setOpen(false);
    if (next === engine) return;
    if (next === "omp") {
      const latestStatus = await refreshStatus();
      if (!latestStatus?.supported || !latestStatus.installedVersion) {
        useAppStore.getState().setSettingsTab("agentEngines");
        useAppStore.getState().setSettingsAnchor("settings.agentEngines.title");
        return;
      }
    }
    setSaving(true);
    try {
      // Scoped to the open conversation (or the draft when there is none), and
      // remembered as the default for the next new conversation.
      await useAppStore.getState().setAgentEngine(next);
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const issueText = issue
    ? issue === "checking"
      ? t("settings.omp.engineChecking")
      : issue === "statusUnavailable"
        ? t("settings.omp.engineStatusUnavailable")
        : issue === "unsupportedPlatform"
          ? t("settings.omp.unsupported")
          : issue === "notInstalled"
            ? t("settings.omp.engineInstallFirst")
            : ""
    : null;
  const engineName = t(getAgentEngine(engine)?.nameKey ?? "settings.omp.enginePi");

  const openManager = () => {
    setOpen(false);
    useAppStore.getState().setSettingsTab("agentEngines");
    useAppStore.getState().setSettingsAnchor("settings.agentEngines.title");
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"], [role="menuitem"]',
    ));
    const next = composerEngineMenuFocusIndex(
      items,
      items.indexOf(document.activeElement as HTMLButtonElement),
      key,
    );
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <AnchoredMenu
      className="composer-agent-engine"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-mode-menu composer-agent-engine-menu"
      label={t("settings.omp.engine")}
      role="menu"
      align="end"
      side="top"
      onMenuKeyDown={onMenuKeyDown}
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`icon-btn composer-agent-engine-chip${open ? " active" : ""}`}
          data-engine={engine}
          tooltip={issueText ? `${t("settings.omp.engine")}: ${engineName}. ${issueText}` : `${t("settings.omp.engine")}: ${engineName}`}
          ariaLabel={`${t("settings.omp.engine")}: ${engineName}${issueText ? `. ${issueText}` : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-invalid={issue !== null && engine === "omp"}
          disabled={controlsBlocked || saving}
          onClick={() => {
            onCloseOtherMenus();
            setOpen((current) => !current);
            if (status === null || statusFailed) void refreshStatus();
          }}
        >
          <IconBot size={13} aria-hidden="true" />
          <span>{engine === "omp" ? "oh-my-pi" : "PI"}</span>
          <IconChevronDown size={11} aria-hidden="true" />
        </TooltipButton>
      )}
    >
      <div className="composer-menu-section-label" role="presentation">{t("settings.omp.engine")}</div>
      {AGENT_ENGINE_REGISTRY.map((definition) => {
        const selected = engine === definition.id;
        const managedStatus = definition.id === "omp" ? status : null;
        const unavailable = definition.id === "omp" && (statusLoading || status?.supported === false);
        return (
          <button
            key={definition.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className={`composer-plus-item ${selected ? "active" : ""}`}
            disabled={saving || unavailable}
            title={definition.id === "omp" ? t("settings.omp.historyIsolated") : undefined}
            onClick={() => void selectEngine(definition.id)}
          >
            <span className="flex-1 text-left">
              <span className="composer-agent-engine-option-title">{t(definition.nameKey)}</span>
              {definition.managed && (
                <span className="composer-agent-engine-option-detail">
                  {statusLoading
                    ? t("settings.omp.engineChecking")
                    : managedStatus?.installedVersion
                      ? t("settings.omp.installedVersionShort", { version: managedStatus.installedVersion })
                      : t("settings.omp.notInstalled")}
                </span>
              )}
            </span>
            {selected ? <IconCheck size={13} /> : null}
          </button>
        );
      })}
      {status?.supported === false ? (
        <div className="composer-menu-hint" role="status">{t("settings.omp.unsupported")}</div>
      ) : !status?.installedVersion && !statusLoading ? (
        <button type="button" className="composer-plus-item" role="menuitem" onClick={openManager}>
          <span className="flex-1 text-left">{t("settings.omp.openManager")}</span>
          <IconChevronDown size={12} aria-hidden="true" />
        </button>
      ) : null}
      {engine === "omp" && issueText ? (
        <div className="composer-menu-hint composer-agent-engine-issue" role="status">{issueText}</div>
      ) : null}
      <div className="composer-plus-sep" role="separator" />
      <div className="composer-menu-hint" role="presentation">{t("settings.omp.engineNextTurnHint")}</div>
    </AnchoredMenu>
  );
}
