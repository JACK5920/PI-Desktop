#!/usr/bin/env node
/// E2E: load local.pi-memory into a real Electron app through the host's
/// two-step permission-confirm path, then drive a real memory write through
/// the plugin panel and verify the full injection chain.
///
/// Run from a checkout with built JS + host-core binary:
///   node scripts/e2e-memory-plugin.mjs
/// From a worktree that reuses another checkout's build:
///   PI_DESKTOP_CHECKOUT_ROOT=<built-checkout> node scripts/e2e-memory-plugin.mjs
/// All profile/data/workspace state lives in a fresh temp dir; nothing touches
/// the user's real ~/.pi-desktop.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKOUT = resolve(process.env.PI_DESKTOP_CHECKOUT_ROOT || ROOT);
const PLUGIN = resolve(process.env.PI_DESKTOP_MEMORY_PLUGIN || join(ROOT, "examples", "plugins", "local.pi-memory"));
const APP = join(CHECKOUT, "apps/desktop");
const ELECTRON = join(APP, "node_modules/electron/dist/electron.exe");
const HOST = join(CHECKOUT, "target/release/pi-desktop-host-core.exe");
const PERMS = JSON.parse(readFileSync(join(PLUGIN, "manifest.json"), "utf8")).permissions;
const MARKER = "E2E memory entry: real Electron injection verified";

const run = mkdtempSync(join(tmpdir(), "pi-memory-e2e-"));
const data = join(run, "data");
const home = join(run, "home");
const profile = join(run, "profile");
const project = join(run, "project");
for (const dir of [data, home, profile, project]) mkdirSync(dir, { recursive: true });
writeFileSync(join(project, "README.md"), "memory plugin e2e workspace\n");
console.log("RUN_ROOT", run);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function until(fn, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = "falsy";
    } catch (error) {
      last = error?.message || String(error);
    }
    await sleep(250);
  }
  throw new Error(`timeout: ${label} (${last})`);
}

async function makeCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((done, reject) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data: raw }) => {
    const reply = JSON.parse(String(raw));
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    clearTimeout(waiter.timer);
    if (reply.error) waiter.reject(new Error(reply.error.message));
    else waiter.resolve(reply.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 20_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const reply = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) {
      throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    }
    return reply.result?.value;
  };
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  return { call, evaluate, close: () => socket.close() };
}

async function pageTargets(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return targets.filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
}

const cdpPort = await freePort();
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  PI_DESKTOP_DATA_DIR: data,
  PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
  PI_DESKTOP_HOST_BIN: HOST,
  ELECTRON_RENDERER_URL: "",
  PI_DESKTOP_START_MAXIMIZED: "0",
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  ELECTRON,
  [`--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "."],
  { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-16_000); });
}

async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((done) => child.once("close", done));
  try { spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }); }
  catch { child.kill(); }
  await Promise.race([closed, sleep(4_000)]);
}

const sockets = [];
try {
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Electron exited early:\n${output}`);
    return (await pageTargets(cdpPort)).length > 0;
  }, "CDP renderer target", 90_000);
  check("electron booted with isolated profile", true, `cdp=${cdpPort}`);

  const mainTarget = (await pageTargets(cdpPort))[0];
  const main = await makeCdp(mainTarget.webSocketDebuggerUrl);
  sockets.push(main);
  await until(() => main.evaluate(`typeof window.piDesktop?.invoke === "function"`), "preload bridge", 60_000);
  check("preload IPC bridge ready", true);

  // host-core rejects every RPC before app.handshake; project/set would fail
  // with UNAUTHORIZED and leave the plugin without a workspace root.
  await until(async () => {
    const value = await main.evaluate(`window.piDesktop.invoke('pi-desktop/settings/get')`);
    return value?.ok === true ? value : null;
  }, "host handshake complete", 60_000);
  check("host handshake complete", true);

  const setResult = await main.evaluate(
    `window.piDesktop.invoke('pi-desktop/project/set', ${JSON.stringify(project)})`,
  );
  check("active project bound", setResult?.ok === true, JSON.stringify(setResult).slice(0, 200));

  const loadResult = await main.evaluate(
    `window.piDesktop.invoke('pi-desktop/plugin/loadDevConfirm', {path: ${JSON.stringify(PLUGIN)}, grantedPermissions: ${JSON.stringify(PERMS)}})`,
  );
  check("loadDevConfirm accepted", loadResult?.ok === true, JSON.stringify(loadResult).slice(0, 180));

  await until(async () => {
    const value = await main.evaluate(`window.piDesktop.invoke('pi-desktop/plugin/list')`);
    return JSON.stringify(value).includes("local.pi-memory") ? value : null;
  }, "plugin appears in plugins.list", 30_000);
  check("plugin registered in host registry", true);

  const appendPath = join(project, ".pi", "APPEND_SYSTEM.md");
  const memoryDir = join(project, ".pi", "memory");
  const storeFile = join(memoryDir, "store.jsonl");
  await until(() => existsSync(appendPath), "tier-1 controlled block written", 30_000);
  const first = readFileSync(appendPath, "utf8");
  const begins = first.split("<!-- pi-memory:tier1:begin -->").length - 1;
  const ends = first.split("<!-- pi-memory:tier1:end -->").length - 1;
  check("tier-1 injected into APPEND_SYSTEM.md", begins === 1 && ends === 1, `begin=${begins} end=${ends} bytes=${first.length}`);
  check("memory store directory created", existsSync(memoryDir));
  check("TIER1.md projection written", existsSync(join(memoryDir, "TIER1.md")));
  check("empty store does not create store.jsonl (by design)", !existsSync(storeFile));
  check("plugin private data dir provisioned", existsSync(join(data, "plugins", "data", "local.pi-memory")));

  const openPanel = await main.evaluate(
    `window.piDesktop.invoke('pi-desktop/plugin/openPanel', 'local.pi-memory')`,
  );
  check("plugin panel opened", openPanel?.ok !== false, JSON.stringify(openPanel).slice(0, 160));

  const panelTarget = await until(async () => {
    const targets = await pageTargets(cdpPort);
    return targets.find((entry) => entry.webSocketDebuggerUrl !== mainTarget.webSocketDebuggerUrl) || null;
  }, "panel CDP target", 30_000);
  const panel = await makeCdp(panelTarget.webSocketDebuggerUrl);
  sockets.push(panel);
  await until(() => panel.evaluate(`typeof window.pluginBridge?.invoke === "function"`), "panel bridge", 30_000);
  check("panel bridge ready", true);

  const now = Date.now();
  const entry = {
    id: "m_e2e_1", schema: 1, type: "decision", scope: "project",
    key: "e2e smoke", content: MARKER, tags: ["e2e"], trust: "user-explicit",
    confidence: 1, createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0,
    supersedes: null, supersededBy: null, contradicts: [], quarantined: false,
    source: { kind: "panel" }, expiresAt: null,
  };
  const imported = await panel.evaluate(
    `window.pluginBridge.invoke('memory.import', {payload: ${JSON.stringify({ schema: 1, entries: [entry] })}})`,
  );
  check("panel memory.import accepted", imported && imported.error === undefined, JSON.stringify(imported).slice(0, 200));

  await until(() => existsSync(storeFile), "store.jsonl created after write", 20_000);
  const storeText = readFileSync(storeFile, "utf8");
  check("store.jsonl contains the memory", storeText.includes(MARKER), `bytes=${storeText.length}`);
  await until(() => readFileSync(appendPath, "utf8").includes(MARKER), "tier-1 refreshed with new memory", 20_000);
  const after = readFileSync(appendPath, "utf8");
  check("tier-1 still has exactly one controlled block", after.split("<!-- pi-memory:tier1:begin -->").length - 1 === 1 && after.split("<!-- pi-memory:tier1:end -->").length - 1 === 1, `bytes=${after.length}`);

  const status = await panel.evaluate(`window.pluginBridge.invoke('memory.status', {})`);
  check("panel memory.status reports the entry", JSON.stringify(status).includes('"total":1'), JSON.stringify(status).slice(0, 240));
  const found = await panel.evaluate(`window.pluginBridge.invoke('memory.search', {query: "Electron injection"})`);
  check("panel memory.search finds the entry", JSON.stringify(found).includes(MARKER), JSON.stringify(found).slice(0, 200));

  const EDITED = "E2E edited memory: manual edit keeps history";
  const edited = await panel.evaluate(
    `window.pluginBridge.invoke('memory.update', {id: 'm_e2e_1', content: ${JSON.stringify(EDITED)}})`,
  );
  check("panel memory.update accepted", edited?.action === "updated" && edited?.history === 1, JSON.stringify(edited).slice(0, 180));
  const editedStore = readFileSync(storeFile, "utf8");
  check("edit keeps previous text in history", editedStore.includes(MARKER) && editedStore.includes(EDITED), `bytes=${editedStore.length}`);
  const afterEdit = readFileSync(appendPath, "utf8");
  check("tier-1 refreshed after edit", afterEdit.includes(EDITED) && !afterEdit.includes(MARKER));

  const retired = await panel.evaluate(
    `window.pluginBridge.invoke('memory.retire', {id: 'm_e2e_1'})`,
  );
  check("panel memory.retire accepted", retired?.action === "retired", JSON.stringify(retired).slice(0, 160));
  const listAfterRetire = await panel.evaluate(`window.pluginBridge.invoke('memory.list', {})`);
  check("retired entry hidden from list", !JSON.stringify(listAfterRetire).includes("m_e2e_1"));
  const exported = await panel.evaluate(`window.pluginBridge.invoke('memory.export', {})`);
  check("retired entry still in export", JSON.stringify(exported).includes("m_e2e_1"), "history preserved for recovery");
  const afterRetire = readFileSync(appendPath, "utf8");
  check("tier-1 no longer contains retired memory", !afterRetire.includes(EDITED));

  const reload = await main.evaluate(`window.piDesktop.invoke('pi-desktop/plugin/reload', 'local.pi-memory')`);
  check("plugin hot reload", reload?.ok !== false);
} catch (error) {
  check("e2e run", false, error?.message || String(error));
  console.log("--- electron log tail ---");
  console.log(output.slice(-5000));
} finally {
  for (const socket of sockets) { try { socket.close(); } catch {} }
  await stop();
  console.log("SUMMARY", JSON.stringify(results));
  console.log("ARTIFACTS", run);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
