import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import type { AgentTurnResult } from "../stores/app-store";
import { useAppStore } from "../stores/app-store";
import { IconCircleAlert } from "./icons";
import { IconFileText, IconMore } from "./icons";
import { ContextMenu } from "./ContextMenu";
import { useChatFileMenu } from "../hooks/use-chat-file-menu";
import { selectTurnDeliverables } from "../lib/turn-artifact-presentation";
import { toolWorkPanelTab } from "../lib/work-panel-tabs";

type TurnOutcomeCardProps = {
  messages: UiMessage[];
  result?: AgentTurnResult;
};

function latestTurnMessages(messages: UiMessage[]) {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return lastUserIndex < 0 ? messages : messages.slice(lastUserIndex + 1);
}

export function TurnOutcomeCard({
  messages,
  result,
}: TurnOutcomeCardProps) {
  const { t } = useTranslation();
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const openFile = useAppStore((state) => state.openFileInWorkPanel);
  const openWorkPanelTab = useAppStore((state) => state.openWorkPanelTab);
  const { fileMenu, openFileMenu, closeFileMenu } = useChatFileMenu();

  if (!result) return null;
  const { artifacts, total: deliverableCount } = selectTurnDeliverables(result.artifacts ?? [], latestTurnMessages(messages));
  const artifactCard = artifacts.length > 0 ? (
    <section className="turn-artifacts-card" data-testid="turn-artifacts-card" aria-label={t("panel.artifacts.title")}>
      <div className="turn-artifacts-heading">
        <IconFileText size={16} aria-hidden />
        <strong>{result.partial ? t("panel.artifacts.partialTitle") : t("panel.artifacts.turnTitle")}</strong>
        <span>{t("panel.artifacts.count", { count: deliverableCount })}</span>
        <button type="button" className="turn-artifacts-all" onClick={() => openWorkPanelTab(toolWorkPanelTab("artifacts"))}>
          {t("panel.artifacts.viewAll")}
        </button>
      </div>
      <div className="turn-artifacts-list">
        {artifacts.slice(0, 6).map((artifact) => {
          const name = artifact.path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? artifact.path;
          return (
            <div className="turn-artifact-row" key={artifact.id} onContextMenu={(event) => openFileMenu(event, { path: artifact.path })}>
              <button type="button" className="turn-artifact-open" disabled={!artifact.existsNow} onClick={() => openFile(artifact.path)} title={artifact.path}>
                <strong>{name}</strong><span>{artifact.path}</span>
              </button>
              <span className="turn-artifact-evidence">{artifact.source === "workspace_diff" ? t("panel.artifacts.detected") : t("panel.artifacts.confirmed")}</span>
              {artifact.existsNow ? (
                <button type="button" className="turn-artifact-reveal" title={t("chat.openWith")} aria-label={t("chat.openWith")} onClick={(event) => openFileMenu(event, { path: artifact.path })}>
                  <IconMore size={14} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  ) : null;
  if (result.status === "completed") return <>{artifactCard}<ContextMenu state={fileMenu} onClose={closeFileMenu} /></>;

  const tail = latestTurnMessages(messages);
  const hasInlineError = tail.some((message) => Boolean(message.error));
  if (hasInlineError) return <>{artifactCard}<ContextMenu state={fileMenu} onClose={closeFileMenu} /></>;

  const toolCount = tail.filter((message) => message.role === "tool").length;
  const hasVisibleTurn = tail.some(
    (message) =>
      Boolean(message.content.trim()) ||
      message.role === "tool" ||
      Boolean(message.error),
  );

  if (!hasVisibleTurn) return <>{artifactCard}<ContextMenu state={fileMenu} onClose={closeFileMenu} /></>;

  return (
    <>
    {artifactCard}
    <section
      className="turn-outcome-card failed"
      data-testid="turn-outcome-card"
      data-outcome="failed"
      role="status"
      aria-live="polite"
    >
      <div className="turn-outcome-heading">
        <span className="turn-outcome-icon" aria-hidden>
          <IconCircleAlert size={16} />
        </span>
        <div className="turn-outcome-copy">
          <strong>{t("chat.resultNeedsAttention")}</strong>
          <span>{t("chat.resultFailedBody")}</span>
        </div>
      </div>
      {toolCount > 0 ? (
        <div className="turn-outcome-stats">
          <span>{t("chat.resultSteps", { count: toolCount })}</span>
        </div>
      ) : null}
      <div className="turn-outcome-actions">
        <button
          type="button"
          className="copy-btn primary"
          onClick={() =>
            void sendPrompt(t("chat.continueUnfinishedTaskPrompt"))
          }
        >
          {t("chat.resultContinue")}
        </button>
      </div>
    </section>
    <ContextMenu state={fileMenu} onClose={closeFileMenu} />
    </>
  );
}
