import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  beginMiniWindowMode,
  calculateMiniWindowBounds,
  endMiniWindowMode,
  MINI_WINDOW_DEFAULT_SIZE,
  MINI_WINDOW_MINIMUM_SIZE,
  isMiniWindowMode,
  miniWindowMinimumSize,
  miniWindowRestoreState,
} = await import("../electron/main/mini-window-mode.ts");
const { readMiniWindowSize, writeMiniWindowSize } = await import("../electron/main/window-preferences.ts");

const [protocolSource, windowIpcSource, windowBootstrapSource, appShellSource, chatShellCss, controlsSource] = await Promise.all([
  readFile(new URL("../../../packages/shared/src/protocol.ts", import.meta.url), "utf8"),
  readFile(new URL("../electron/main/ipc/window-ipc.ts", import.meta.url), "utf8"),
  readFile(new URL("../electron/main/bootstrap/window.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/features/app/AppShell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/chat-shell.css", import.meta.url), "utf8"),
  readFile(new URL("../src/components/WindowControls.tsx", import.meta.url), "utf8"),
]);

test("mini window is centered at the target footprint within the display work area", () => {
  assert.deepEqual(
    calculateMiniWindowBounds({ x: 100, y: 40, width: 1920, height: 1040 }),
    { x: 840, y: 240, width: 440, height: 640 },
  );
});

test("mini window shrinks to fit small work areas and keeps a usable minimum", () => {
  const workArea = { x: -320, y: 20, width: 300, height: 350 };
  assert.deepEqual(calculateMiniWindowBounds(workArea), {
    x: -320,
    y: 20,
    width: 300,
    height: 350,
  });
  assert.deepEqual(miniWindowMinimumSize(workArea), { width: 300, height: 350 });
});

test("mini window uses a saved size, centers it, and clamps it to the display", () => {
  assert.deepEqual(MINI_WINDOW_DEFAULT_SIZE, { width: 440, height: 640 });
  assert.deepEqual(MINI_WINDOW_MINIMUM_SIZE, { width: 320, height: 400 });
  assert.deepEqual(
    calculateMiniWindowBounds({ x: 0, y: 0, width: 1920, height: 1080 }, { width: 720, height: 500 }),
    { x: 600, y: 290, width: 720, height: 500 },
  );
  assert.deepEqual(
    calculateMiniWindowBounds({ x: 0, y: 0, width: 500, height: 450 }, { width: 720, height: 500 }),
    { x: 0, y: 0, width: 500, height: 450 },
  );
});

test("mini window size preference persists valid dimensions and rejects stale or invalid values", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-mini-window-"));
  try {
    assert.equal(readMiniWindowSize(dataDir, MINI_WINDOW_MINIMUM_SIZE.width, MINI_WINDOW_MINIMUM_SIZE.height), null);
    writeMiniWindowSize(dataDir, { width: 517.4, height: 733.2 });
    assert.deepEqual(
      readMiniWindowSize(dataDir, MINI_WINDOW_MINIMUM_SIZE.width, MINI_WINDOW_MINIMUM_SIZE.height),
      { width: 517, height: 733 },
    );
    writeFileSync(join(dataDir, "mini-window-state.json"), JSON.stringify({ version: 1, width: 200, height: 300 }));
    assert.equal(readMiniWindowSize(dataDir, MINI_WINDOW_MINIMUM_SIZE.width, MINI_WINDOW_MINIMUM_SIZE.height), null);
    writeFileSync(join(dataDir, "mini-window-state.json"), JSON.stringify({ version: 99, width: 600, height: 700 }));
    assert.equal(readMiniWindowSize(dataDir, MINI_WINDOW_MINIMUM_SIZE.width, MINI_WINDOW_MINIMUM_SIZE.height), null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("mini mode snapshots the original bounds once and restores maximized intent", () => {
  const window = {};
  const original = {
    bounds: { x: 80, y: 90, width: 1420, height: 900 },
    wasMaximized: true,
  };
  assert.equal(beginMiniWindowMode(window, original), true);
  original.bounds.width = 440;
  assert.equal(beginMiniWindowMode(window, { bounds: original.bounds, wasMaximized: false }), false);
  assert.equal(isMiniWindowMode(window), true);
  assert.deepEqual(miniWindowRestoreState(window), {
    bounds: { x: 80, y: 90, width: 1420, height: 900 },
    wasMaximized: true,
  });
  assert.deepEqual(endMiniWindowMode(window), {
    bounds: { x: 80, y: 90, width: 1420, height: 900 },
    wasMaximized: true,
  });
  assert.equal(isMiniWindowMode(window), false);
  assert.equal(endMiniWindowMode(window), null);
});


test("compact window actions preserve normal geometry and follow native window state", () => {
  assert.match(protocolSource, /"enterMiniMode"/);
  assert.match(protocolSource, /"resetMiniModeSize"/);
  assert.match(protocolSource, /"exitMiniMode"/);
  assert.match(protocolSource, /"toggleAlwaysOnTop"/);
  assert.match(protocolSource, /windowModeChanged:/);
  assert.match(windowIpcSource, /beginMiniWindowMode\(mainWindow, \{ bounds: restoreBounds, wasMaximized \}\)/);
  assert.match(windowIpcSource, /readMiniWindowSize\(\s*dataDir,[\s\S]*?MINI_WINDOW_MINIMUM_SIZE\.height/s);
  assert.match(windowIpcSource, /calculateMiniWindowBounds\(workArea, preferredMiniSize \?\? MINI_WINDOW_DEFAULT_SIZE\)/);
  assert.match(windowIpcSource, /writeMiniWindowSize\(dataDir, MINI_WINDOW_DEFAULT_SIZE\)/);
  assert.match(windowIpcSource, /writeMiniWindowSize\(dataDir, miniBounds\)/);
  assert.match(windowIpcSource, /clampBoundsToWorkArea\(restore\.bounds, workArea\)/);
  assert.match(windowIpcSource, /mainWindow\.setAlwaysOnTop\(!mainWindow\.isAlwaysOnTop\(\), "floating"\)/);
  assert.match(controlsSource, /runAction\("toggleAlwaysOnTop"\)/);
  assert.match(controlsSource, /runAction\("resetMiniModeSize"\)/);
  assert.match(controlsSource, /runAction\("exitMiniMode"\)/);

  const persistence = windowBootstrapSource.slice(
    windowBootstrapSource.indexOf("const persistNormalWindowState = () =>"),
    windowBootstrapSource.indexOf("const scheduleStateSave = () =>"),
  );
  assert.match(persistence, /isMiniWindowMode\(window\)/);
  assert.match(windowBootstrapSource, /const persistMiniWindowSize = \(\) =>/);
  assert.match(windowBootstrapSource, /writeMiniWindowSize\(dataDir, bounds\)/);
  assert.match(windowBootstrapSource, /persistCurrentWindowState\(\)/);
});

test("compact chat hides navigation without unmounting chat and removes the composer divider", () => {
  assert.match(chatShellCss, /\.app-chat-shell\.is-mini-window > \.sidebar,[\s\S]*?\.app-chat-shell\.is-mini-window > \.work-panel/);
  assert.match(appShellSource, /className=\{cx\("app-chat-shell", miniMode && "is-mini-window"\)\}/);
  assert.match(appShellSource, /PortalVisibilityProvider visible=\{page !== "settings"\}/);
  assert.match(
    chatShellCss,
    /\.app-shell\.is-mini-window \.main-pane \.composer-shell > \.composer-toolbar\s*\{[^}]*border:\s*0 !important;[^}]*border-block-start:\s*0 !important;/s,
  );
  assert.match(chatShellCss, /\.composer-shell > \.composer-toolbar::before,[\s\S]*?display: none !important;/);
});
