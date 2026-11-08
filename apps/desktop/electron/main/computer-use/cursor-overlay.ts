import { app, BrowserWindow, ipcMain, screen } from "electron";
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
  let displayBounds: ComputerRect | null = null;
  let activeGrant: string | null = null;
  let targetBounds: ComputerRect | null = null;
  let loaded = false;
  let pending: ComputerCursorEvent[] = [];
  let latestEvent: ComputerCursorEvent | null = null;
  let creation: Promise<BrowserWindow | null> | null = null;

  const send = (event: ComputerCursorEvent) => {
    if (!window || window.isDestroyed() || !loaded) {
      pending.push(event);
      if (pending.length > 16) pending.shift();
      return;
    }
    window.webContents.send(IPC.event.computerCursor, event);
  };

  ipcMain.handle(IPC.invoke.computerCursorReady, (event) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || !activeGrant || !displayBounds) {
      return false;
    }
    if (!targetBounds) return false;
    send({ kind: "show", grantId: activeGrant, bounds: targetBounds, displayBounds });
    if (latestEvent && latestEvent.kind !== "show" && latestEvent.kind !== "hide") send(latestEvent);
    return true;
  });

  const ensureWindow = async (display: ComputerRect): Promise<BrowserWindow | null> => {
    const rect = {
      x: Math.round(display.x),
      y: Math.round(display.y),
      width: Math.max(1, Math.round(display.width)),
      height: Math.max(1, Math.round(display.height)),
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
        targetBounds = null;
        displayBounds = null;
        latestEvent = null;
        const current = window;
        window = null;
        loaded = false;
        pending = [];
        if (current && !current.isDestroyed()) current.destroy();
        return;
      }
      if (event.kind === "show") {
        activeGrant = event.grantId;
        targetBounds = event.bounds;
        const matchedDisplay = screen.getDisplayMatching(event.bounds);
        displayBounds = matchedDisplay.bounds;
        const displayEvent = { ...event, displayBounds };
        latestEvent = displayEvent;
        void ensureWindow(displayBounds).then((created) => {
          if (!created || created.isDestroyed() || activeGrant !== event.grantId) return;
          if (!created.isVisible()) created.showInactive();
          send(displayEvent);
        });
        return;
      }
      if (activeGrant !== event.grantId || !displayBounds) return;
      latestEvent = event;
      send(event);
    },
    close() {
      activeGrant = null;
      targetBounds = null;
      displayBounds = null;
      latestEvent = null;
      pending = [];
      ipcMain.removeHandler(IPC.invoke.computerCursorReady);
      const current = window;
      window = null;
      loaded = false;
      if (current && !current.isDestroyed()) current.destroy();
    },
  };
}
