import { beforeEach, describe, expect, it, vi } from "vitest";

const electronFixture = vi.hoisted(() => ({
  displayBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  physicalToDipPoint: (point: { x: number; y: number }) => point,
  physicalToDipRect: (rect: { x: number; y: number; width: number; height: number }) => rect,
  targetBounds: null as unknown,
  options: null as unknown,
  readyHandler: null as ((event: { sender: unknown }) => unknown) | null,
  didFinishLoad: null as (() => void) | null,
  window: null as null | {
    bounds: { x: number; y: number; width: number; height: number };
    isVisible: () => boolean;
    isDestroyed: () => boolean;
    showInactive: () => void;
    setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
    webContents: {
      send: ReturnType<typeof vi.fn>;
    };
  },
}));

vi.mock("electron", () => {
  class MockBrowserWindow {
    bounds: { x: number; y: number; width: number; height: number };
    private visible = false;
    private destroyed = false;
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === "did-finish-load") electronFixture.didFinishLoad = listener;
      }),
      send: vi.fn(),
    };
    on = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => { this.bounds = bounds; });
    isVisible = () => this.visible;
    isDestroyed = () => this.destroyed;
    showInactive = () => { this.visible = true; };
    destroy = () => { this.destroyed = true; };
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);

    constructor(options: { x: number; y: number; width: number; height: number }) {
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      electronFixture.options = options;
      electronFixture.window = this;
    }
  }

  return {
    app: { getLocale: () => "en-US" },
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle: vi.fn((_channel: string, handler: (event: { sender: unknown }) => unknown) => {
        electronFixture.readyHandler = handler;
      }),
      removeHandler: vi.fn(),
    },
    screen: {
      getDisplayMatching: vi.fn((bounds: unknown) => {
        electronFixture.targetBounds = bounds;
        return { bounds: electronFixture.displayBounds };
      }),
      screenToDipPoint: vi.fn((point: { x: number; y: number }) => electronFixture.physicalToDipPoint(point)),
      screenToDipRect: vi.fn((_window: null, rect: { x: number; y: number; width: number; height: number }) => electronFixture.physicalToDipRect(rect)),
    },
  };
});

vi.mock("../module-path", () => ({ getModuleDirectory: () => "C:/fixture" }));

import { createComputerCursorOverlay } from "./cursor-overlay.js";
import { IPC } from "@pi-desktop/shared";

describe("Computer cursor overlay display bounds", () => {
  beforeEach(() => {
    electronFixture.displayBounds = { x: -1920, y: 0, width: 1920, height: 1080 };
    electronFixture.physicalToDipPoint = (point) => point;
    electronFixture.physicalToDipRect = (rect) => rect;
    electronFixture.targetBounds = null;
    electronFixture.options = null;
    electronFixture.readyHandler = null;
    electronFixture.didFinishLoad = null;
    electronFixture.window = null;
  });

  it("covers the full monitor containing the bound target instead of framing the target window", () => {
    const targetBounds = { x: -1700, y: 120, width: 860, height: 620 };
    const overlay = createComputerCursorOverlay();
    overlay.apply({ kind: "show", grantId: "grant-1", bounds: targetBounds });

    expect(electronFixture.targetBounds).toEqual(targetBounds);
    expect(electronFixture.options).toMatchObject(electronFixture.displayBounds);
    expect(electronFixture.options).not.toMatchObject(targetBounds);
    expect(electronFixture.window?.bounds).toEqual(electronFixture.displayBounds);
    expect(electronFixture.window?.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    overlay.close();
  });

  it("replays the active screen state after the renderer subscribes, even if load completed first", async () => {
    const targetBounds = { x: -1700, y: 120, width: 860, height: 620 };
    const overlay = createComputerCursorOverlay();
    overlay.apply({ kind: "show", grantId: "grant-1", bounds: targetBounds });
    const latestMove = { kind: "move" as const, grantId: "grant-1", x: -1400, y: 360, label: "Continue" };
    overlay.apply(latestMove);
    await Promise.resolve();
    await Promise.resolve();
    electronFixture.didFinishLoad?.();

    const sender = electronFixture.window?.webContents;
    expect(sender).toBeTruthy();
    expect(electronFixture.readyHandler).toBeTruthy();
    sender?.send.mockClear();
    await electronFixture.readyHandler?.({ sender });

    expect(sender?.send).toHaveBeenCalledWith(
      IPC.event.computerCursor,
      expect.objectContaining({ kind: "show", grantId: "grant-1", bounds: targetBounds, displayBounds: electronFixture.displayBounds }),
    );
    expect(sender?.send).toHaveBeenCalledWith(IPC.event.computerCursor, latestMove);
    overlay.close();
  });

  it.each([
    {
      name: "100% baseline display",
      physicalBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      dipBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scale: 1,
      originX: 0,
      originY: 0,
      dipOriginX: 0,
      dipOriginY: 0,
      physicalPoint: { x: 960, y: 540 },
      dipPoint: { x: 960, y: 540 },
      display: { x: 0, y: 0, width: 1920, height: 1080 },
    },
    {
      name: "125% primary display",
      physicalBounds: { x: 0, y: 0, width: 2400, height: 1350 },
      dipBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scale: 1.25,
      originX: 0,
      originY: 0,
      dipOriginX: 0,
      dipOriginY: 0,
      physicalPoint: { x: 1200, y: 675 },
      dipPoint: { x: 960, y: 540 },
      display: { x: 0, y: 0, width: 1920, height: 1080 },
    },
    {
      name: "150% negative-origin secondary display",
      physicalBounds: { x: -2880, y: 0, width: 2880, height: 1620 },
      dipBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      scale: 1.5,
      originX: -2880,
      originY: 0,
      dipOriginX: -1920,
      dipOriginY: 0,
      physicalPoint: { x: -1440, y: 900 },
      dipPoint: { x: -960, y: 600 },
      display: { x: -1920, y: 0, width: 1920, height: 1080 },
    },
  ])("converts Host physical pixels to Electron DIPs on $name", async ({
    physicalBounds,
    dipBounds,
    scale,
    originX,
    originY,
    dipOriginX,
    dipOriginY,
    physicalPoint,
    dipPoint,
    display,
  }) => {
    electronFixture.displayBounds = display;
    const pointToDip = (point: { x: number; y: number }) => ({
      x: dipOriginX + (point.x - originX) / scale,
      y: dipOriginY + (point.y - originY) / scale,
    });
    electronFixture.physicalToDipPoint = pointToDip;
    electronFixture.physicalToDipRect = (rect) => {
      const topLeft = pointToDip({ x: rect.x, y: rect.y });
      const bottomRight = pointToDip({ x: rect.x + rect.width, y: rect.y + rect.height });
      return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
    };

    const overlay = createComputerCursorOverlay({ windowsCoordinates: true });
    overlay.apply({ kind: "show", grantId: "dpi-grant", bounds: physicalBounds });
    overlay.apply({ kind: "move", grantId: "dpi-grant", ...physicalPoint });
    await Promise.resolve();
    await Promise.resolve();

    expect(electronFixture.targetBounds).toEqual(dipBounds);
    expect(electronFixture.window?.bounds).toEqual(display);
    electronFixture.didFinishLoad?.();
    expect(electronFixture.window?.webContents.send).toHaveBeenCalledWith(
      IPC.event.computerCursor,
      expect.objectContaining({ kind: "move", grantId: "dpi-grant", ...dipPoint }),
    );
    overlay.close();
  });
});
