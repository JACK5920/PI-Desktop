import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { IPC, type ComputerCursorEvent, type ComputerRect } from "@pi-desktop/shared";
import { getModuleDirectory } from "../module-path";

export type ComputerCursorOverlay = {
  apply(event: ComputerCursorEvent): void;
  close(): void;
};

/** A click-through visual only; Host remains the sole authority for input. */
export function createComputerCursorOverlay(): ComputerCursorOverlay {
  let window: BrowserWindow | null = null;
  let bounds: ComputerRect | null = null;
  let activeGrant: string | null = null;
  let loaded = false;
  let pending: ComputerCursorEvent[] = [];
  let creation: Promise<BrowserWindow | null> | null = null;

  const send = (event: ComputerCursorEvent) => {
    if (!window || window.isDestroyed() || !loaded) {
      pending.push(event);
      if (pending.length > 16) pending.shift();
      return;
    }
    window.webContents.send(IPC.event.computerCursor, event);
  };

  const ensureWindow = async (target: ComputerRect): Promise<BrowserWindow | null> => {
    const outer = 48;
    const rect = {
      x: Math.round(target.x - outer),
      y: Math.round(target.y - outer),
      width: Math.max(1, Math.round(target.width + outer * 2)),
      height: Math.max(1, Math.round(target.height + outer * 2)),
    };
    if (window && !window.isDestroyed()) {
      window.setBounds(rect, false);
      return window;
    }
    if (creation) {
      const pendingCreation = creation;
      return pendingCreation.then((created) => {
        if (created && !created.isDestroyed()) created.setBounds(rect, false);
        return created;
      });
    }
    const promise = (async () => {
      const created = new BrowserWindow({
        ...rect,
        title: "PI-Desktop Computer Use Cursor",
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        movable: false,
        focusable: false,
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
      created.setIgnoreMouseEvents(true);
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      created.webContents.on("will-navigate", (event, url) => {
        const devOrigin = process.env.ELECTRON_RENDERER_URL;
        if (!devOrigin || !url.startsWith(devOrigin)) event.preventDefault();
      });
      created.webContents.on("did-finish-load", () => {
        loaded = true;
        for (const event of pending.splice(0)) created.webContents.send(IPC.event.computerCursor, event);
      });
      created.on("closed", () => {
        if (window === created) window = null;
        loaded = false;
      });
      try {
        if (process.env.ELECTRON_RENDERER_URL) {
          const url = new URL(process.env.ELECTRON_RENDERER_URL);
          url.searchParams.set("surface", "computer-use-cursor");
          await created.loadURL(url.toString());
        } else {
          await created.loadFile(join(getModuleDirectory(import.meta.url), "../renderer/index.html"), {
            query: { surface: "computer-use-cursor" },
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

  return {
    apply(event) {
      if (event.kind === "hide") {
        if (activeGrant !== event.grantId) return;
        send(event);
        activeGrant = null;
        bounds = null;
        const current = window;
        window = null;
        loaded = false;
        pending = [];
        if (current && !current.isDestroyed()) current.destroy();
        return;
      }
      if (event.kind === "show") {
        activeGrant = event.grantId;
        bounds = event.bounds;
        void ensureWindow(event.bounds).then((created) => {
          if (!created || created.isDestroyed() || activeGrant !== event.grantId) return;
          if (!created.isVisible()) created.showInactive();
          send(event);
        });
        return;
      }
      if (activeGrant !== event.grantId || !bounds) return;
      send(event);
    },
    close() {
      activeGrant = null;
      bounds = null;
      pending = [];
      const current = window;
      window = null;
      loaded = false;
      if (current && !current.isDestroyed()) current.destroy();
    },
  };
}
