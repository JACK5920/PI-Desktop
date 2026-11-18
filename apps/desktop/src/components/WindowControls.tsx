import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import {
  IconBrowser,
  IconClose,
  IconCopy,
  IconMinus,
  IconPanelRestore,
  IconPin,
  IconRefresh,
  IconSquare,
} from "./icons";
import { TooltipButton } from "./ui";
import type { WindowControlAction, WindowControlState } from "@pi-desktop/shared";

/**
 * Renderer-drawn window controls for Windows/Linux (D-frameless chrome).
 *
 * macOS keeps native inset traffic lights; other platforms run a frameless
 * window, so minimize/maximize/close live here — flat Codex-style glyph
 * buttons pinned to the top-right of the 46px titlebar band. AppShell owns a
 * single control band outside the conversation and work-panel stacking contexts.
 */
export function WindowControls({
  miniMode = false,
  alwaysOnTop = false,
  miniModeAvailable = true,
  onStateChange,
}: {
  miniMode?: boolean;
  alwaysOnTop?: boolean;
  miniModeAvailable?: boolean;
  onStateChange?: (state: WindowControlState) => void;
}) {
  const { t } = useTranslation();
  const platform = window.piDesktop?.platform ?? "darwin";
  const [maximized, setMaximized] = useState(false);

  const runAction = (action: WindowControlAction) => {
    void api.windowControl(action).then((state) => {
      setMaximized(state.maximized);
      onStateChange?.(state);
    }).catch((error: unknown) => {
      console.warn("Window control failed", action, error);
    });
  };

  useEffect(() => {
    if (platform === "darwin") return;
    let mounted = true;
    void api.windowControl("getState").then((state) => {
      if (mounted) setMaximized(state.maximized);
    }).catch(() => undefined);
    const unsubscribe = api.onWindowMaximized((e) =>
      setMaximized(e.maximized),
    );
    const unsubscribeMode = api.onWindowModeChanged((state) => {
      setMaximized(state.maximized);
      onStateChange?.(state);
    });
    return () => {
      mounted = false;
      unsubscribe();
      unsubscribeMode();
    };
  }, [platform, onStateChange]);

  if (platform === "darwin" && !miniMode && !miniModeAvailable) return null;
  if (platform === "darwin" && !miniMode) {
    return (
      <div className="window-controls window-controls-macos no-drag">
        <TooltipButton
          type="button"
          className="window-control-btn"
          tooltip={t("window.enterMiniMode", "Compact window")}
          ariaLabel={t("window.enterMiniMode", "Compact window")}
          onClick={() => runAction("enterMiniMode")}
        >
          <IconBrowser size={14} strokeWidth={1.5} aria-hidden />
        </TooltipButton>
      </div>
    );
  }

  return (
    <div className={`window-controls no-drag${miniMode ? " window-controls-mini" : ""}`}>
      {miniMode ? (
        <>
          <TooltipButton
            type="button"
            className={`window-control-btn${alwaysOnTop ? " is-active" : ""}`}
            tooltip={t("window.alwaysOnTop", "Keep on top")}
            ariaLabel={t("window.alwaysOnTop", "Keep on top")}
            aria-pressed={alwaysOnTop}
            onClick={() => runAction("toggleAlwaysOnTop")}
          >
            <IconPin size={13} strokeWidth={1.5} aria-hidden />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="window-control-btn"
            tooltip={t("window.resetMiniModeSize", "Reset compact size")}
            ariaLabel={t("window.resetMiniModeSize", "Reset compact size")}
            onClick={() => runAction("resetMiniModeSize")}
          >
            <IconRefresh size={13} strokeWidth={1.5} aria-hidden />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="window-control-btn"
            tooltip={t("window.exitMiniMode", "Restore full window")}
            ariaLabel={t("window.exitMiniMode", "Restore full window")}
            onClick={() => runAction("exitMiniMode")}
          >
            <IconPanelRestore size={13} strokeWidth={1.5} aria-hidden />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="window-control-btn window-control-close"
            tooltip={t("window.close", "Close")}
            ariaLabel={t("window.close", "Close")}
            onClick={() => runAction("close")}
          >
            <IconClose size={12} strokeWidth={1.5} aria-hidden />
          </TooltipButton>
        </>
      ) : (
        <>
          <TooltipButton
            type="button"
            className="window-control-btn"
            tooltip={t("window.minimize", "Minimize")}
            ariaLabel={t("window.minimize", "Minimize")}
            onClick={() => runAction("minimize")}
          >
            <IconMinus size={12} strokeWidth={1.5} aria-hidden />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="window-control-btn"
            tooltip={maximized ? t("window.restore", "Restore") : t("window.maximize", "Maximize")}
            ariaLabel={maximized ? t("window.restore", "Restore") : t("window.maximize", "Maximize")}
            onClick={() => runAction("toggleMaximize")}
          >
            {maximized ? (
              <IconCopy size={11} strokeWidth={1.4} aria-hidden />
            ) : (
              <IconSquare size={10} strokeWidth={1.4} aria-hidden />
            )}
          </TooltipButton>
          <TooltipButton
            type="button"
            className="window-control-btn"
            tooltip={t("window.enterMiniMode", "Compact window")}
            ariaLabel={t("window.enterMiniMode", "Compact window")}
            disabled={!miniModeAvailable}
            onClick={() => runAction("enterMiniMode")}
          >
            <IconBrowser size={14} strokeWidth={1.5} aria-hidden />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="window-control-btn window-control-close"
            tooltip={t("window.close", "Close")}
            ariaLabel={t("window.close", "Close")}
            onClick={() => runAction("close")}
          >
            <IconClose size={12} strokeWidth={1.5} aria-hidden />
          </TooltipButton>
        </>
      )}
    </div>
  );
}
