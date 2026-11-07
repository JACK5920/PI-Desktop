import { app, BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { IPC, type ComputerGrantView } from "@pi-desktop/shared";
import { getModuleDirectory } from "../module-path";
import { subscribeComputerUseRun } from "./active-run";

export type ComputerUseWidget = {
  owns: (webContentsId: number) => boolean;
  setPresentation: (visible: boolean, width: number, height: number) => void;
  close: () => void;
};

const DEFAULT_SIZE = { width: 390, height: 100 };

/** Desktop-level status/Stop chrome; native actions and authority stay in Main/Host. */
export function createComputerUseWidget(): ComputerUseWidget {
  let window: BrowserWindow | null = null;
  let creation: Promise<BrowserWindow | null> | null = null;
  let loaded = false;
  let latest: ComputerGrantView | null = null;
  let requestedVisible = false;
  let closingForShutdown = false;
  let size = DEFAULT_SIZE;

  const send = () => {
    if (window && !window.isDestroyed() && loaded) {
      window.webContents.send(IPC.event.computerGrantChanged, latest);
      if (latest && !window.isVisible()) window.showInactive();
      if (!latest && window.isVisible()) window.hide();
    }
  };

  const ensureWindow = async (): Promise<BrowserWindow | null> => {
    if (window && !window.isDestroyed()) return window;
    if (creation) return creation;
    const bounds = screen.getPrimaryDisplay().workArea;
    const promise = (async () => {
      const created = new BrowserWindow({
        x: bounds.x + bounds.width - size.width - 24,
        y: bounds.y + 24,
        ...size,
        title: "PI-Desktop Computer Use",
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(getModuleDirectory(import.meta.url), "../preload/index.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          additionalArguments: [`--pi-desktop-locale=${app.getLocale()}`],
        },
      });
      window = created;
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      created.webContents.on("will-navigate", (event, url) => {
        const devOrigin = process.env.ELECTRON_RENDERER_URL;
        if (!devOrigin || !url.startsWith(devOrigin)) event.preventDefault();
      });
      created.webContents.on("did-finish-load", () => {
        loaded = true;
        send();
      });
      created.on("close", (event) => {
        if (latest && !closingForShutdown) {
          event.preventDefault();
          if (!created.isDestroyed() && !created.isVisible()) created.showInactive();
        }
      });
      created.on("closed", () => {
        if (window === created) window = null;
        loaded = false;
      });
      try {
        if (process.env.ELECTRON_RENDERER_URL) {
          const url = new URL(process.env.ELECTRON_RENDERER_URL);
          url.searchParams.set("surface", "computer-use-widget");
          await created.loadURL(url.toString());
        } else {
          await created.loadFile(join(getModuleDirectory(import.meta.url), "../renderer/index.html"), {
            query: { surface: "computer-use-widget" },
          });
        }
        return created;
      } catch {
        if (!created.isDestroyed()) created.destroy();
        if (window === created) window = null;
        return null;
      }
    })();
    creation = promise;
    void promise.then(() => { if (creation === promise) creation = null; });
    return promise;
  };

  const unsubscribe = subscribeComputerUseRun((run) => {
    latest = run;
    if (run) void ensureWindow().then(send);
    else send();
  });

  return {
    owns(webContentsId) {
      return Boolean(window && !window.isDestroyed() && window.webContents.id === webContentsId);
    },
    setPresentation(visible, width, height) {
      requestedVisible = visible && latest !== null;
      size = {
        width: Math.max(320, Math.min(520, Math.ceil(width))),
        height: Math.max(72, Math.min(220, Math.ceil(height))),
      };
      if (!requestedVisible) {
        if (window && !window.isDestroyed() && window.isVisible()) window.hide();
        send();
        return;
      }
      void ensureWindow().then((created) => {
        if (!created || created.isDestroyed() || !requestedVisible) return;
        const workArea = screen.getDisplayMatching(created.getBounds()).workArea;
        const x = Math.max(workArea.x, Math.min(created.getBounds().x, workArea.x + workArea.width - size.width));
        const y = Math.max(workArea.y, Math.min(created.getBounds().y, workArea.y + workArea.height - size.height));
        created.setBounds({ x, y, ...size }, false);
        if (!created.isVisible()) created.showInactive();
        send();
      });
    },
    close() {
      closingForShutdown = true;
      unsubscribe();
      const current = window;
      window = null;
      loaded = false;
      if (current && !current.isDestroyed()) current.destroy();
    },
  };
}
