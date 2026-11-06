#!/usr/bin/env node
/** Real Chromium user path for selected-text references and docked side chats. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-selection-reference-workflow-"));

function dependencyDirectory(name) {
  return dirname(require.resolve(`${name}/package.json`, {
    paths: [join(root, "apps/desktop"), root],
  }));
}

function resolveElectron() {
  try {
    return resolveElectronBinary(root).electronBinary;
  } catch {
    const packageDirectory = dependencyDirectory("electron");
    const relativeBinary = existsSync(join(packageDirectory, "path.txt"))
      ? readFileSync(join(packageDirectory, "path.txt"), "utf8").trim()
      : process.platform === "win32" ? "electron.exe" : "electron";
    return join(packageDirectory, "dist", relativeBinary);
  }
}

try {
  const styles = await Promise.all(
    ["tokens", "base", "ui-kit", "chat-shell", "composer", "messages", "work-panel"].map(
      (name) => readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8"),
    ),
  );
  await writeFile(join(temp, "style.css"), styles.join("\n"));

  await build({
    entryPoints: [join(root, "scripts/e2e/selection-reference-workflow.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"MODE":"production"}',
    },
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: dependencyDirectory("react"),
      "react-dom": dependencyDirectory("react-dom"),
      i18next: dependencyDirectory("i18next"),
      "react-i18next": dependencyDirectory("react-i18next"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules"), join(root, "node_modules")],
  });
  const electronBinary = resolveElectron();
  assert(existsSync(electronBinary), `Electron binary missing: ${electronBinary}`);

  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\' data:"><title>Selection reference workflow</title><link rel="stylesheet" href="style.css"><style>body{font:14px sans-serif}.selection-reference-fixture{position:relative;width:900px;padding:24px}.transcript-fixture [data-selection-message-id]{user-select:text;margin:12px 0}</style><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => process.stderr.write("SELECTION_REFERENCE_RENDERER " + event.message + "\\n"));
  window.webContents.on("render-process-gone", (_event, details) => process.stderr.write("SELECTION_REFERENCE_RENDER_GONE " + JSON.stringify(details) + "\\n"));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.selectionReferenceProbe()");
    process.stdout.write("SELECTION_REFERENCE_PROBE " + JSON.stringify(result) + "\\n", () => app.exit(0));
  } catch (error) {
    process.stderr.write("SELECTION_REFERENCE_ERROR " + (error?.stack || error) + "\\n");
    app.exit(1);
  }
});
`,
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timeout));
  const marker = output.split(/\r?\n/).find((line) => line.startsWith("SELECTION_REFERENCE_PROBE "));
  assert(marker, `Electron returned no workflow result (exit=${code}).\n${output.slice(-7000)}`);
  const result = JSON.parse(marker.slice("SELECTION_REFERENCE_PROBE ".length));
  console.log("SELECTION_REFERENCE_PROBE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-7000));
  assert.equal(result.ok, true, "selection/reference/side-chat user path failed");
} finally {
  await rm(temp, { recursive: true, force: true });
}
