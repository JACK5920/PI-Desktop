#!/usr/bin/env node
/** Isolated Electron renderer path for Computer Use settings and the Stop widget. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-computer-use-settings-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/computer-use-settings.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src"),
      "@pi-desktop/shared": join(root, "packages/shared/src"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"),
      "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });

  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Run pnpm build:js before this test");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><html data-platform="win32"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`,
  );
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 680, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const settings = await window.webContents.executeJavaScript("window.runComputerUseSettingsProbe()");
    const stop = await window.webContents.executeJavaScript("window.runComputerUseStopWidgetProbe()");
    console.log("COMPUTER_USE_SETTINGS_PATH " + JSON.stringify({ settings, stop }));
    app.exit(0);
  } catch (error) { console.error("COMPUTER_USE_SETTINGS_PATH_ERROR " + String(error)); app.exit(1); }
});
`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("COMPUTER_USE_SETTINGS_PATH "));
  assert(line, `Electron fixture returned no result (exit=${code}): ${output.slice(-5000)}`);
  const result = JSON.parse(line.slice("COMPUTER_USE_SETTINGS_PATH ".length));
  assert.equal(code, 0, output.slice(-5000));
  assert.equal(result.settings.writes.length, 2);
  assert.equal(result.settings.stopRequests, 0);
  assert.equal(result.stop.stopRequests.length, 1);
  assert.equal(result.stop.stopRequests[0].sessionId, "fixture-session-1");
  assert.equal(result.stop.stopRequests[0].grantId, "fixture-grant-1");
  console.log("COMPUTER_USE_SETTINGS_PATH " + JSON.stringify(result));
} finally {
  await rm(temp, { recursive: true, force: true });
}
