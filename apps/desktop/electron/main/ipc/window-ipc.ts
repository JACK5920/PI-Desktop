import { BrowserWindow, Menu, screen } from "electron";
import { isWindowBackgroundColor, MAX_WINDOW_CORNER_RADIUS } from "@pi-desktop/plugin-sdk";
import {
  builtinWindowBackground,
  ErrorCodes,
  IPC,
  isThemeColorScheme,
  NATIVE_MENU_ACTIONS,
  WINDOW_CONTROL_ACTIONS,
  parseTraySessionPreferences,
  type NativeMenuAction,
  type WindowControlAction,
  type WindowControlState,
  type LifecycleDialogChoice,
  type TraySessionPreferences,
  type WorkPanelTabMenuAction,
} from "@pi-desktop/shared";
import {
  clampWorkPanelTabMenuPointToDip,
  parseWorkPanelTabMenuRequest,
  waitForNativeMenuResult,
} from "../work-panel-tab-menu";
import {
  clampBoundsToWorkArea,
  clampMinimumSizeToWorkArea,
  emptyWorkPanelReservationState,
  parseWorkPanelChatWidth,
  parseWorkPanelReservationWidth,
  type WorkPanelReservationState,
} from "../work-panel-window";
import { isWindowFullScreen } from "../window-fullscreen";
import {
  beginMiniWindowMode,
  calculateMiniWindowBounds,
  endMiniWindowMode,
  isMiniWindowMode,
  MINI_WINDOW_DEFAULT_SIZE,
  MINI_WINDOW_MINIMUM_SIZE,
  miniWindowMinimumSize,
  miniWindowRestoreState,
} from "../mini-window-mode";
import { readMiniWindowSize, writeMiniWindowSize } from "../window-preferences";
import {
  DEFAULT_WINDOW_CORNER_RADIUS,
} from "../window-shape";
import { applyWindowCornerRadius, usesWindows11NativeCorners } from "../window-native-corners";
import { applyMainWindowBackground } from "../window-background";
import type { IpcRegistrar } from "./types";

export type WindowIpcDependencies = {
  registrar: IpcRegistrar;
  dataDir: string;
  getMainWindow: () => BrowserWindow | null;
  getWorkPanelReservationWidth: () => number;
  setWorkPanelReservationWidth: (width: number) => void;
  setWorkPanelReservation: (state: WorkPanelReservationState) => void;
  getWorkPanelChatWidthSetter: () => ((width: number) => number) | null;
  getWindowMinimumSize: () => { width: number; height: number };
  applyCloseBehavior: (behavior: "tray" | "quit") => void;
  getCloseBehavior: () => "ask" | "tray" | "quit";
  markLifecycleDialogRendererReady: (window: BrowserWindow) => boolean;
  respondLifecycleDialog: (senderWindowId: number, requestId: unknown, choice: LifecycleDialogChoice) => boolean;
  markMenuRendererReady: (window: BrowserWindow) => boolean;
  executeNativeMenuAction: (action: NativeMenuAction) => unknown;
  setTraySessionPreferences: (preferences: TraySessionPreferences) => Promise<void>;
  isMacosWindowTranslucent: () => boolean;
};

/**
 * Register renderer-drawn window chrome and work-panel geometry channels.
 *
 * `isMacosWindowTranslucent` reports the surface the running window was
 * created with: a translucent window leaves its pixels to the native vibrancy
 * material, so a theme colour must not paint over it.
 */
export function registerWindowIpc({
  registrar,
  dataDir,
  getMainWindow,
  getWorkPanelReservationWidth,
  setWorkPanelReservationWidth,
  setWorkPanelReservation,
  getWorkPanelChatWidthSetter,
  getWindowMinimumSize,
  applyCloseBehavior,
  getCloseBehavior,
  markMenuRendererReady,
  markLifecycleDialogRendererReady,
  respondLifecycleDialog,
  executeNativeMenuAction,
  setTraySessionPreferences,
  isMacosWindowTranslucent,
}: WindowIpcDependencies): void {
  const { handle, handleWithEvent } = registrar;
  handleWithEvent(IPC.invoke.traySetSessionPreferences, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    const preferences = parseTraySessionPreferences(input);
    if (!preferences) {
      throw Object.assign(new Error("invalid tray session preferences"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    await setTraySessionPreferences(preferences);
    return { ok: true };
  });

  handle(IPC.invoke.windowSetWorkPanelReservation, async (input: unknown = {}) => {
    const requested = parseWorkPanelReservationWidth(input);
    if (requested === null) {
      throw Object.assign(new Error("invalid work panel reservation width"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("main window unavailable");
    }
    if (isMiniWindowMode(mainWindow)) return { requested: 0, reserved: 0 };
    setWorkPanelReservationWidth(0);
    setWorkPanelReservation(emptyWorkPanelReservationState());
    return { requested: 0, reserved: 0 };
  });

  handle(IPC.invoke.windowSetWorkPanelChatWidth, async (input: unknown = {}) => {
    const requested = parseWorkPanelChatWidth(input);
    if (requested === null) {
      throw Object.assign(new Error("invalid work panel chat width"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("main window unavailable");
    }
    if (isMiniWindowMode(mainWindow)) {
      return { requested, applied: mainWindow.getBounds().width };
    }
    const setter = getWorkPanelChatWidthSetter();
    if (!setter || getWorkPanelReservationWidth() <= 0) {
      throw new Error("work panel unavailable");
    }
    return { requested, applied: setter(requested) };
  });

  handleWithEvent(IPC.invoke.windowSetBackgroundColor, async (event, input: unknown = {}) => {
    registrar.assertMainWindowSender(event);
    const theme = (input as { theme?: unknown })?.theme;
    if (!isThemeColorScheme(theme)) {
      throw Object.assign(new Error("invalid window background theme"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    // A plugin theme may name its own background; anything else, including an
    // omitted value, falls back to the host palette for the resolved theme. The
    // renderer recomputes this from the persisted preference and the live theme
    // catalog on every theme, plugin, and OS-appearance change, so switching
    // away, disabling, or uninstalling the provider restores the default by
    // derivation rather than by remembering what to undo.
    const requested = (input as { color?: unknown })?.color;
    if (requested !== undefined && requested !== null && !isWindowBackgroundColor(requested)) {
      throw Object.assign(new Error("invalid window background color"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const requestedRadius = (input as { cornerRadius?: unknown })?.cornerRadius;
    if (
      requestedRadius !== undefined && requestedRadius !== null &&
      (typeof requestedRadius !== "number" || !Number.isInteger(requestedRadius) ||
        requestedRadius < 0 || requestedRadius > MAX_WINDOW_CORNER_RADIUS)
    ) {
      throw Object.assign(new Error("invalid window corner radius"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    // A translucent macOS window keeps its pixels transparent over the native
    // vibrancy material; painting the theme colour would flatten the glass.
    // The default opaque surface takes the colour like every other platform.
    if (process.platform === "darwin" && isMacosWindowTranslucent()) {
      return { applied: false, theme };
    }
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("main window unavailable");
    }
    const color = isWindowBackgroundColor(requested)
      ? requested
      : builtinWindowBackground(theme);
    const windows11NativeCorners = usesWindows11NativeCorners(
      process.platform,
      process.getSystemVersion(),
    );
    applyMainWindowBackground(
      mainWindow,
      process.platform,
      color,
      windows11NativeCorners,
      builtinWindowBackground(theme),
    );
    const cornerRadius = process.platform === "win32"
      ? await applyWindowCornerRadius(
          mainWindow,
          typeof requestedRadius === "number" ? requestedRadius : DEFAULT_WINDOW_CORNER_RADIUS,
        )
      : null;
    return { applied: true, theme, color, cornerRadius };
  });

  handle(IPC.invoke.windowControl, async (input: { action?: string } = {}) => {
    if (
      !input.action ||
      !WINDOW_CONTROL_ACTIONS.includes(input.action as WindowControlAction)
    ) {
      throw new Error("unsupported window control action");
    }
    const macosWindowTranslucency =
      process.platform === "darwin" && isMacosWindowTranslucent();
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return {
        maximized: false,
        miniMode: false,
        alwaysOnTop: false,
        fullScreen: false,
        macosWindowTranslucency,
      } satisfies WindowControlState;
    }
    const state = (): WindowControlState => ({
      maximized: !mainWindow.isDestroyed() && mainWindow.isMaximized(),
      miniMode: isMiniWindowMode(mainWindow),
      alwaysOnTop: !mainWindow.isDestroyed() && mainWindow.isAlwaysOnTop(),
      fullScreen: !mainWindow.isDestroyed() && isWindowFullScreen(mainWindow),
      // The surface this window was created with, so a Settings switch can tell
      // whether the stored preference has taken effect (#1064 / ADR 0332).
      macosWindowTranslucency,
    });
    const publishState = () => {
      if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(IPC.event.windowModeChanged, state());
      }
    };

    switch (input.action as WindowControlAction) {
      case "getState":
        break;
      case "minimize":
        mainWindow.minimize();
        break;
      case "enterMiniMode": {
        if (isWindowFullScreen(mainWindow)) {
          throw new Error("mini window is unavailable while the window is full screen");
        }
        if (isMiniWindowMode(mainWindow)) break;
        const preferredMiniSize = readMiniWindowSize(
          dataDir,
          MINI_WINDOW_MINIMUM_SIZE.width,
          MINI_WINDOW_MINIMUM_SIZE.height,
        );
        const wasMaximized = mainWindow.isMaximized();
        const restoreBounds = wasMaximized
          ? mainWindow.getNormalBounds()
          : mainWindow.getBounds();
        const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
        if (!beginMiniWindowMode(mainWindow, { bounds: restoreBounds, wasMaximized })) {
          break;
        }
        if (wasMaximized) mainWindow.unmaximize();
        const minimum = miniWindowMinimumSize(workArea);
        mainWindow.setMinimumSize(minimum.width, minimum.height);
        mainWindow.setBounds(
          calculateMiniWindowBounds(workArea, preferredMiniSize ?? MINI_WINDOW_DEFAULT_SIZE),
          false,
        );
        publishState();
        break;
      }
      case "resetMiniModeSize": {
        if (!isMiniWindowMode(mainWindow)) break;
        const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
        const minimum = miniWindowMinimumSize(workArea);
        mainWindow.setMinimumSize(minimum.width, minimum.height);
        mainWindow.setBounds(calculateMiniWindowBounds(workArea), false);
        writeMiniWindowSize(dataDir, MINI_WINDOW_DEFAULT_SIZE);
        publishState();
        break;
      }
      case "exitMiniMode": {
        const restore = miniWindowRestoreState(mainWindow);
        if (!restore) break;
        const miniBounds = mainWindow.getBounds();
        if (
          miniBounds.width >= MINI_WINDOW_MINIMUM_SIZE.width &&
          miniBounds.height >= MINI_WINDOW_MINIMUM_SIZE.height
        ) {
          writeMiniWindowSize(dataDir, miniBounds);
        }
        const workArea = screen.getDisplayMatching(restore.bounds).workArea;
        const bounds = clampBoundsToWorkArea(restore.bounds, workArea);
        const requestedMinimum = getWindowMinimumSize();
        const minimum = clampMinimumSizeToWorkArea(requestedMinimum, workArea);
        mainWindow.setMinimumSize(minimum.width, minimum.height);
        mainWindow.setBounds(bounds, false);
        if (restore.wasMaximized) mainWindow.maximize();
        endMiniWindowMode(mainWindow);
        publishState();
        break;
      }
      case "toggleAlwaysOnTop":
        mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop(), "floating");
        publishState();
        break;
      // `toggleMaximize` and close run through the shared native-menu action so
      // the maximize/fullscreen interlock has one implementation.
      case "toggleMaximize":
      case "close":
        if (isMiniWindowMode(mainWindow) && input.action === "toggleMaximize") {
          const restore = miniWindowRestoreState(mainWindow);
          if (restore) {
            const miniBounds = mainWindow.getBounds();
            if (
              miniBounds.width >= MINI_WINDOW_MINIMUM_SIZE.width &&
              miniBounds.height >= MINI_WINDOW_MINIMUM_SIZE.height
            ) {
              writeMiniWindowSize(dataDir, miniBounds);
            }
            const workArea = screen.getDisplayMatching(restore.bounds).workArea;
            const minimum = clampMinimumSizeToWorkArea(getWindowMinimumSize(), workArea);
            mainWindow.setMinimumSize(minimum.width, minimum.height);
            mainWindow.setBounds(clampBoundsToWorkArea(restore.bounds, workArea), false);
            if (restore.wasMaximized) mainWindow.maximize();
            endMiniWindowMode(mainWindow);
            publishState();
          }
        }
        return executeNativeMenuAction(input.action as NativeMenuAction);
    }
    return state();
  });

  handle(IPC.invoke.closeBehaviorGet, async () => ({
    behavior: getCloseBehavior(),
    supported: process.platform !== "darwin",
  }));

  handle(IPC.invoke.closeBehaviorSet, async (input: unknown = {}) => {
    if (process.platform === "darwin") {
      throw Object.assign(new Error("close behavior is not configurable"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const behavior = (input as { behavior?: unknown })?.behavior;
    if (behavior !== "tray" && behavior !== "quit") {
      throw Object.assign(new Error("invalid close behavior"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    applyCloseBehavior(behavior);
    return { behavior };
  });

  handleWithEvent(IPC.invoke.lifecycleDialogReady, async (event) => {
    registrar.assertMainWindowSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !markLifecycleDialogRendererReady(window)) {
      throw Object.assign(new Error("lifecycle dialog renderer is not ready"), {
        errorCode: ErrorCodes.INTERNAL,
      });
    }
    return { ready: true };
  });

  handleWithEvent(IPC.invoke.lifecycleDialogRespond, async (event, input: unknown = {}) => {
    registrar.assertMainWindowSender(event);
    const value = input && typeof input === "object"
      ? input as Record<string, unknown>
      : null;
    if (
      !value ||
      typeof value.requestId !== "string" ||
      !value.requestId ||
      value.requestId.length > 64 ||
      (value.choice !== "cancel" && value.choice !== "confirm" && value.choice !== "tray" && value.choice !== "quit")
    ) {
      throw Object.assign(new Error("invalid lifecycle dialog response"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return {
      accepted: respondLifecycleDialog(event.sender.id, value.requestId, value.choice as LifecycleDialogChoice),
    };
  });
  handleWithEvent(IPC.invoke.menuRendererReady, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const mainWindow = getMainWindow();
    if (!window || window !== mainWindow || !markMenuRendererReady(window)) {
      throw new Error("menu renderer is not attached to the main window");
    }
    return { ready: true };
  });

  handleWithEvent(IPC.invoke.workPanelTabMenu, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const mainWindow = getMainWindow();
    if (!window || window !== mainWindow || window.isDestroyed()) {
      throw new Error("main window unavailable for work panel menu");
    }
    const request = parseWorkPanelTabMenuRequest(input);
    if (!request) {
      throw Object.assign(new Error("invalid work panel tab menu request"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const [contentWidth, contentHeight] = window.getContentSize();
    const { x, y } = clampWorkPanelTabMenuPointToDip(
      request,
      event.sender.getZoomFactor(),
      contentWidth,
      contentHeight,
    );
    let selected: WorkPanelTabMenuAction | null = null;
    const menu = Menu.buildFromTemplate([
      { label: request.closeTabLabel, click: () => { selected = "closeTab"; } },
      { type: "separator" },
      {
        label: request.closeOtherTabsLabel,
        enabled: request.canCloseOthers,
        click: () => { selected = "closeOtherTabs"; },
      },
      { label: request.closeAllTabsLabel, click: () => { selected = "closeAllTabs"; } },
    ]);
    return waitForNativeMenuResult(
      window,
      (onMenuClosed) => menu.popup({ window, x, y, callback: onMenuClosed }),
      () => selected,
    );
  });


  handle(IPC.invoke.nativeMenuAction, async (input: { action?: string } = {}) => {
    if (
      !input.action ||
      !NATIVE_MENU_ACTIONS.includes(input.action as NativeMenuAction)
    ) {
      throw new Error("unsupported native menu action");
    }
    return executeNativeMenuAction(input.action as NativeMenuAction);
  });
}
