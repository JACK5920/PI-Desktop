import {
  keybindingDisplayParts,
  type Mode,
  type PermissionMode,
  type PluginComposerTransformMeta,
  type ProviderPublic,
  type SessionThinkingLevel,
  type ShortcutPlatform,
} from "@pi-desktop/shared";
import type { TFunction } from "i18next";
import { useState, type Dispatch, type SetStateAction } from "react";
import { ContextUsageInspector } from "../../../components/ContextUsageInspector";
import { OmpNativeControls } from "../../../components/OmpNativeControls";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import {
  IconArrowUp,
  IconPause,
  IconPlay,
  IconPlus,
  IconSparkles,
  IconStop,
  IconUndo2,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { type AppState, useAppStore } from "../../../stores/app-store";
import { agentEngineForState } from "../../../lib/session-agent-engine";
import { LiveVoiceControls } from "../../voice/live/LiveVoiceControls";
import { ComposerControlSlots } from "./ComposerControlSlots";
import { ComposerModelPicker } from "./ComposerModelPicker";
import { ComposerEnginePicker } from "./ComposerEnginePicker";
import { ComposerOmpModelPicker } from "./ComposerOmpModelPicker";
import { ComposerModePicker } from "./ComposerModePicker";
import { ComposerPermissionPicker } from "./ComposerPermissionPicker";
import type { GoalTemplate } from "./goal-templates.mjs";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;
type ContextUsage = Parameters<typeof ContextUsageInspector>[0];

export type ComposerToolbarProps = {
  t: TFunction;
  mode: Mode;
  planningLive: boolean;
  providerId?: string;
  modelId?: string;
  thinkingLevel: SessionThinkingLevel;
  composerPermissionMode: Exclude<PermissionMode, "inherit">;
  modeOpen: boolean;
  setModeOpen: Dispatch<SetStateAction<boolean>>;
  permissionOpen: boolean;
  setPermissionOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  engineSwitchBlocked?: boolean;
  localToolsAllowed?: boolean;
  attachmentsAllowed?: boolean;
  stopAllowed?: boolean;
  pasting: boolean;
  pickAndAttach: () => Promise<void>;
  configureActiveSession: AppState["configureActiveSession"];
  showToast: AppState["showToast"];
  onSelectGoalTemplate: (template: GoalTemplate) => void | Promise<void>;
  modelMenu: ModelMenuController;
  modelLabel: string;
  engineIssueMessage?: string | null;
  selectedProvider?: ProviderPublic;
  onEngineIssueChange: (engine: ReturnType<typeof agentEngineForState>, issue: string | null) => void;
  thinkingLabel: string;
  /** The selected model asks for OpenAI's priority tier (ADR 0334). */
  modelFastMode?: boolean;
  contextUsage: ContextUsage | null;
  value: string;
  modelReady: boolean;
  sendBlocked: boolean;
  composerTransforms: PluginComposerTransformMeta[];
  activeTransformKey: string | null;
  undoTransform: PluginComposerTransformMeta | null;
  runComposerTransform: (transform: PluginComposerTransformMeta) => Promise<void>;
  undoComposerTransform: () => void;
  runActive: boolean;
  hasDraftContent: boolean;
  steeringAllowed?: boolean;
  nativeSession?: boolean;
  abort: AppState["abort"];
  taskPaused?: boolean;
  pausePending?: boolean;
  pauseTask?: () => Promise<void>;
  resumeTask?: () => Promise<void>;
  submit: (steering?: boolean) => Promise<void>;
  workSessionId?: string;
  workSessionLabel?: string;
};

/** Composer controls: mode, permission, model, plugin actions, and send/stop. */
export function ComposerToolbar({
  t,
  mode,
  planningLive,
  providerId,
  modelId,
  thinkingLevel,
  composerPermissionMode,
  modeOpen,
  setModeOpen,
  permissionOpen,
  setPermissionOpen,
  controlsBlocked,
  engineSwitchBlocked = controlsBlocked,
  localToolsAllowed = true,
  attachmentsAllowed = true,
  stopAllowed = true,
  pasting,
  pickAndAttach,
  configureActiveSession,
  showToast,
  onSelectGoalTemplate,
  modelMenu,
  modelLabel,
  engineIssueMessage = null,
  selectedProvider,
  onEngineIssueChange,
  thinkingLabel,
  modelFastMode = false,
  contextUsage,
  value,
  modelReady,
  sendBlocked,
  composerTransforms,
  activeTransformKey,
  undoTransform,
  runComposerTransform,
  undoComposerTransform,
  runActive,
  hasDraftContent,
  steeringAllowed = true,
  nativeSession = false,
  abort,
  taskPaused = false,
  pausePending = false,
  pauseTask,
  resumeTask,
  submit,
  workSessionId,
  workSessionLabel,
}: ComposerToolbarProps) {
  const [sendOptionsOpen, setSendOptionsOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);
  // The open conversation may pin its own engine; the app-wide setting only
  // decides what a brand-new conversation starts on.
  const selectedEngine = useAppStore(agentEngineForState);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;
  const steeringShortcut = keybindingDisplayParts("Alt+Enter", platform).join("+");
  // OMP exposes native steer/follow-up delivery through RPC, so it gets the
  // same accessible choice menu without borrowing PI's host-side queue.
  const sendOptionsAvailable = runActive && hasDraftContent && (!nativeSession || selectedEngine === "omp");
  const openSendOptions = () => {
    if (!sendOptionsAvailable) return;
    modelMenu.setOpen(false);
    setEngineOpen(false);
    setModeOpen(false);
    setPermissionOpen(false);
    setSendOptionsOpen(true);
  };
  return (
    <div className="composer-toolbar">
      <div className="composer-left">
        <div className="composer-plus">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("chat.addFiles")}
            ariaLabel={t("chat.addFiles")}
            disabled={controlsBlocked || pasting || !attachmentsAllowed}
            onClick={() => {
              setPermissionOpen(false);
              void pickAndAttach();
            }}
          >
            <IconPlus size={15} aria-hidden="true" />
          </TooltipButton>
        </div>
        {localToolsAllowed && selectedEngine !== "omp" ? <LiveVoiceControls t={t} workSessionId={workSessionId} /> : null}
        {localToolsAllowed && selectedEngine === "omp" ? <OmpNativeControls sessionId={activeSessionId ?? null} t={t} /> : null}
        {selectedEngine !== "omp" ? <ComposerModePicker
          t={t}
          mode={mode}
          planningLive={planningLive}
          open={modeOpen}
          setOpen={setModeOpen}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => {
            modelMenu.setOpen(false);
            setEngineOpen(false);
            setPermissionOpen(false);
          }}
          onSelect={async (next) => {
            try {
              await configureActiveSession({
                mode: next,
                providerId,
                modelId,
                thinkingLevel,
              });
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error), {
                variant: "error",
              });
            }
          }}
          onSelectGoalTemplate={onSelectGoalTemplate}
        /> : null}
        {selectedEngine !== "omp" ? <ComposerPermissionPicker t={t} mode={mode}
          composerPermissionMode={composerPermissionMode}
          permissionOpen={permissionOpen} setPermissionOpen={setPermissionOpen}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => {
            modelMenu.setOpen(false);
            setEngineOpen(false);
            setModeOpen(false);
          }}
          onSelect={async (candidate) => {
                try {
                  await configureActiveSession({
                    mode,
                    providerId,
                    modelId,
                    thinkingLevel,
                    permissionMode: candidate,
                  });
                } catch (error) {
                  showToast(error instanceof Error ? error.message : String(error), {
                    variant: "error",
                  });
                }
          }} /> : null}
        {localToolsAllowed ? <ComposerControlSlots side="left" /> : null}
      </div>

      <div className="composer-right">
        {localToolsAllowed ? <ComposerControlSlots side="right" /> : null}
        {contextUsage && selectedEngine !== "omp" ? <ContextUsageInspector {...contextUsage} /> : null}
        <ComposerEnginePicker
          t={t}
          controlsBlocked={engineSwitchBlocked}
          open={engineOpen}
          setOpen={setEngineOpen}
          onCloseOtherMenus={() => {
            modelMenu.setOpen(false);
            setModeOpen(false);
            setPermissionOpen(false);
          }}
          onIssueChange={onEngineIssueChange}
        />
        {selectedEngine === "omp" ? (
          <ComposerOmpModelPicker
            t={t}
            // A running OMP turn must not lock the picker: choosing a model is
            // a next-turn setting, and a disabled chip reads as a dead button.
            controlsBlocked={controlsBlocked && !runActive}
            onCloseOtherMenus={() => {
              modelMenu.setOpen(false);
              setPermissionOpen(false);
              setEngineOpen(false);
              setModeOpen(false);
            }}
          />
        ) : (
          <ComposerModelPicker
            t={t}
            controller={modelMenu}
            modelLabel={modelLabel}
            thinkingLabel={thinkingLabel}
            fastMode={modelFastMode}
            thinkingLevel={thinkingLevel}
            selectedProviderId={providerId}
            selectedModelId={modelId}
            controlsBlocked={controlsBlocked}
            onOpenModelSettings={() => useAppStore.getState().setSettingsTab("agent")}
            onCloseOtherMenus={() => {
              setPermissionOpen(false);
              setEngineOpen(false);
              setModeOpen(false);
            }}
          />
        )}
        {composerTransforms.map((transform) => {
          const key = `${transform.pluginId}/${transform.id}`;
          const isActive = activeTransformKey === key;
          return (
          <TooltipButton
            key={key}
            type="button"
            className={`icon-btn icon-btn-square composer-plugin-transform-btn${isActive ? " is-loading" : ""}`}
            tooltip={transform.title}
            ariaLabel={transform.title}
            aria-busy={isActive}
            disabled={
              !value.trim() ||
              value.trim().startsWith("/") ||
              controlsBlocked ||
              sendBlocked ||
              pasting ||
              activeTransformKey !== null
            }
            onClick={() => void runComposerTransform(transform)}
          >
            {isActive ? <span className="tool-spinner" aria-hidden="true" /> : <IconSparkles size={15} aria-hidden="true" />}
          </TooltipButton>
          );
        })}
        {undoTransform ? (
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square composer-plugin-transform-undo"
            tooltip={undoTransform.undoTitle}
            ariaLabel={undoTransform.undoTitle}
            disabled={controlsBlocked}
            onClick={undoComposerTransform}
          >
            <IconUndo2 size={15} aria-hidden="true" />
          </TooltipButton>
        ) : null}
        {runActive && !hasDraftContent ? (
          pauseTask ? (
            <TooltipButton
              type="button"
              className="pause-btn"
              tooltip={t("chat.pauseGeneratingTooltip")}
              ariaLabel={t("chat.pauseGenerating")}
              aria-description={t("chat.stopGenerating")}
              disabled={!stopAllowed || pausePending}
              onClick={() => void pauseTask()}
              onContextMenu={(event) => {
                event.preventDefault();
                if (stopAllowed) void abort();
              }}
            >
              <IconPause size={14} />
            </TooltipButton>
          ) : (
            <TooltipButton
              type="button"
              className="stop-btn"
              tooltip={t("chat.stopGenerating")}
              ariaLabel={t("chat.stopGenerating")}
              disabled={!stopAllowed}
              onClick={() => void abort()}
            >
              <IconStop size={14} />
            </TooltipButton>
          )
        ) : taskPaused && !hasDraftContent ? (
          <TooltipButton
            type="button"
            className="resume-btn"
            tooltip={t("chat.resumePausedTaskTooltip")}
            ariaLabel={t("chat.resumePausedTask")}
            aria-description={t("chat.stopGenerating")}
            disabled={!resumeTask}
            onClick={() => void resumeTask?.()}
            onContextMenu={(event) => {
              event.preventDefault();
              if (stopAllowed) void abort();
            }}
          >
            <IconPlay size={14} />
          </TooltipButton>
        ) : (
          <AnchoredMenu
            className="composer-send-options"
            open={sendOptionsOpen && sendOptionsAvailable}
            onClose={() => setSendOptionsOpen(false)}
            menuClassName="composer-send-options-menu"
            label={t("chat.sendOptions")}
            role="menu"
            align="end"
            side="top"
            onMenuKeyDown={(event) => {
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              );
              if (items.length === 0) return;
              const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
              const nextIndex =
                event.key === "ArrowDown"
                  ? (activeIndex + 1 + items.length) % items.length
                  : event.key === "ArrowUp"
                    ? (activeIndex - 1 + items.length) % items.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : -1;
              if (nextIndex < 0) return;
              event.preventDefault();
              items[nextIndex]?.focus();
            }}
            trigger={(ref) => (
              <TooltipButton
                ref={ref}
                type="button"
                className="send-btn"
                ariaLabel={modelReady ? t("chat.send") : t("settings.addProvider")}
                aria-haspopup={sendOptionsAvailable ? "menu" : undefined}
                aria-expanded={sendOptionsAvailable ? sendOptionsOpen : undefined}
                tooltip={
                  engineIssueMessage ?? (runActive
                    ? t("chat.sendWhileRunning", { shortcut: steeringShortcut })
                    : modelReady
                      ? t("chat.send")
                      : t("settings.addProvider"))
                }
                disabled={
                  !hasDraftContent ||
                  sendBlocked ||
                  (!modelReady && !value.trim().startsWith("/"))
                }
                onClick={() => void submit()}
                onContextMenu={(event) => {
                  if (!sendOptionsAvailable) return;
                  event.preventDefault();
                  openSendOptions();
                }}
                onKeyDown={(event) => {
                  if (!sendOptionsAvailable || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
                  event.preventDefault();
                  openSendOptions();
                }}
              >
                <IconArrowUp size={15} />
              </TooltipButton>
            )}
          >
            <button
              type="button"
              role="menuitem"
              className="composer-plus-item"
              disabled={!steeringAllowed || sendBlocked}
              onClick={() => {
                setSendOptionsOpen(false);
                void submit(true);
              }}
            >
              <span className="flex-1 text-left">{t("chat.steerCurrentRun")}</span>
              <span className="composer-menu-shortcut">{steeringShortcut}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="composer-plus-item"
              disabled={sendBlocked}
              onClick={() => {
                setSendOptionsOpen(false);
                void submit();
              }}
            >
              <span className="flex-1 text-left">{t("chat.queueAsFollowUp")}</span>
            </button>
          </AnchoredMenu>
        )}
      </div>
    </div>
  );
}
