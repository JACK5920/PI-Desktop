import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

test("the bundled File Manager validates names and returns entries for local create/rename", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bundled-file-manager-mutations-"));
  const root = join(directory, "workspace");
  const data = join(directory, "data");
  await mkdir(root);
  await mkdir(data);
  const previousData = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = data;

  const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
  const runtime = new PluginRuntime({
    hostEntry: fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess({ entry }) {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
    getWorkspacePath: () => root,
    getWorkspaceInfo: () => ({
      path: root,
      name: "Local fixture",
      projectId: "file-manager-mutations-regression",
      roots: [{ path: root, name: "Local fixture", primary: true }],
    }),
  });

  t.after(async () => {
    try {
      await runtime.unload("pi.file-manager");
    } finally {
      await rm(directory, { recursive: true, force: true });
      if (previousData === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
      else process.env.PI_DESKTOP_DATA_DIR = previousData;
    }
  });

  await runtime.loadFromPath(fileURLToPath(new URL("../resources/plugins/pi.file-manager", import.meta.url)));
  const invoke = (channel, payload) => runtime.invokePanelBridge("pi.file-manager", channel, payload);

  for (const name of ["", ".", "..", "CON", "name/with-separator", "trailing."]) {
    const result = await invoke("fm.create", { name });
    assert.equal(result.ok, false, `expected ${JSON.stringify(name)} to be rejected`);
    assert.equal(result.code, "INVALID_NAME");
  }
  assert.deepEqual(await readdir(root), []);

  const created = await invoke("fm.create", { name: "notes.txt" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.entry.name, "notes.txt");
  assert.equal(created.entry.path, "notes.txt");
  assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "");

  const renamed = await invoke("fm.rename", { path: "notes.txt", newName: "notes-v2.txt" });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(renamed.entry.name, "notes-v2.txt");
  assert.equal(renamed.entry.path, "notes-v2.txt");
  assert.equal(await readFile(join(root, "notes-v2.txt"), "utf8"), "");
});
