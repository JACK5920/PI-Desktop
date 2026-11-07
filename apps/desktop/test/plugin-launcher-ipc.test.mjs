import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerPluginLauncherIpc } = await import(
  "../electron/main/ipc/plugin-launcher-ipc.ts"
);

function fixture() {
  const handlers = new Map();
  const launches = [];
  const localApps = {
    list: async () => [{
      id: "app:editor-opaque",
      name: "Editor",
      source: "start-menu",
      launchTarget: "C:\\private\\editor.exe",
    }],
    launch: async (id) => { launches.push(id); },
    isScanning: () => false,
    diagnostics: () => [],
  };
  registerPluginLauncherIpc({
    registrar: {
      handleWithEvent: (channel, handler) => handlers.set(channel, handler),
    },
    getHost: () => ({
      call: async (method) => {
        assert.equal(method, "plugins.list");
        return { plugins: [] };
      },
    }),
    getPluginLauncherWindow: () => ({
      isDestroyed: () => false,
      webContents: { id: 42 },
    }),
    plugins: { getLoaded: () => null },
    localApps,
    getLocale: () => "en",
  });
  return { handlers, launches };
}

test("only the launcher window can list installed apps or open an opaque app id", async () => {
  const { handlers, launches } = fixture();
  const catalog = handlers.get("pi-desktop/pluginLauncher/catalog");
  const openApp = handlers.get("pi-desktop/pluginLauncher/openApp");
  assert.ok(catalog);
  assert.ok(openApp);

  await assert.rejects(
    catalog({ sender: { id: 7 } }),
    (error) => error.errorCode === "PERMISSION_DENIED",
  );
  await assert.rejects(
    openApp({ sender: { id: 7 } }, { appId: "app:editor-opaque" }),
    (error) => error.errorCode === "PERMISSION_DENIED",
  );
  assert.deepEqual(launches, []);

  const result = await catalog({ sender: { id: 42 } });
  assert.equal(result.apps[0].id, "app:editor-opaque");
  assert.equal("launchTarget" in result.apps[0], false);
  await openApp({ sender: { id: 42 } }, { appId: "app:editor-opaque" });
  assert.deepEqual(launches, ["app:editor-opaque"]);
});
