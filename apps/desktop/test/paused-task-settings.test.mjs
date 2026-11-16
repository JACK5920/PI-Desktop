import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const { searchSettings } = await import("../src/lib/settings-search.ts");
const { en } = await import("../../../packages/i18n/src/locales/en/index.ts");
const { zhCN } = await import("../../../packages/i18n/src/locales/zh-CN/index.ts");
const { flattenCatalog } = await import("../../../packages/i18n/src/locale-info.ts");
const host = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });

test("safe pause recovery defaults off and preserves its local checkpoint list", () => {
  const received = host.normalizeSettings({ defaultMode: "agent", theme: "light" });
  const displayed = renderer.normalizeSettings(received);
  assert.equal(displayed.autoResumePausedTasks, false);
  assert.deepEqual(displayed.pausedTaskSessionIds, []);

  const stored = { ...displayed, autoResumePausedTasks: true, pausedTaskSessionIds: ["local-a", "local-b"] };
  const written = host.validateSettingsWrite(renderer.validateSettingsWrite(stored));
  assert.equal(written.autoResumePausedTasks, true);
  assert.deepEqual(written.pausedTaskSessionIds, ["local-a", "local-b"]);
});

test("automatic recovery preference is searchable in General in English and Chinese", () => {
  for (const [catalog, query] of [[en, "safely paused tasks"], [zhCN, "安全暂停"]]) {
    const copy = flattenCatalog(catalog);
    const hits = searchSettings(query, (key) => copy[key] ?? key);
    assert.ok(hits.some((hit) => hit.tab === "general" && hit.rowKey === "settings.autoResumePausedTasks"));
  }
});

test("safe pause settings reject malformed values at both settings boundaries", () => {
  for (const validate of [renderer.validateSettingsWrite, host.validateSettingsWrite]) {
    assert.throws(() => validate({ autoResumePausedTasks: "yes" }), /autoResumePausedTasks is invalid/);
    assert.throws(() => validate({ pausedTaskSessionIds: ["ok", 4] }), /pausedTaskSessionIds is invalid/);
    assert.throws(() => validate({ pausedTaskSessionIds: ["x".repeat(257)] }), /pausedTaskSessionIds is invalid/);
  }
});
