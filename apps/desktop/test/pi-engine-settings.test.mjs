import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Agent engine settings expose a dedicated PI runtime management tab", async () => {
  const [settingsPage, manager, api, ipc, protocol, register, en, zhCN, zhTW] = await Promise.all([
    read("../src/features/settings/SettingsPage.tsx"),
    read("../src/components/settings/PiEngineManager.tsx"),
    read("../src/lib/api.ts"),
    read("../electron/main/ipc/settings-ipc.ts"),
    read("../../../packages/shared/src/protocol.ts"),
    read("../electron/main/ipc/register.ts"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
    read("../../../packages/i18n/src/locales/zh-TW/index.ts"),
  ]);
  assert.match(settingsPage, /value: "piRuntime", label: t\("settings\.piEngine\.title"\)/);
  assert.match(settingsPage, /agentSettingsSection === "piRuntime" && <PiEngineManager \/>/);
  assert.match(manager, /settings\.piEngine\.packageVersions/);
  assert.match(manager, /settings\.piEngine\.openPackageRepository/);
  assert.match(manager, /api\.openPiDependencyRepository\(\)/);
  assert.match(manager, /api\.installOrUpdatePiEngine\(\)/);
  assert.match(manager, /api\.cancelPiEngineOperation\(\)/);
  assert.match(manager, /api\.rollbackPiEngine\(\)/);
  assert.match(api, /getPiEngineStatus:/);
  assert.match(api, /openPiDependencyRepository:/);
  assert.match(api, /onPiEngineProgress:/);
  assert.match(ipc, /handle\(IPC\.invoke\.piEngineInstallOrUpdate/);
  assert.match(ipc, /handle\(IPC\.invoke\.piEngineRollback/);
  assert.match(protocol, /piEngineInstallOrUpdate:/);
  assert.match(protocol, /piEngineOpenDependencyRepository:/);
  assert.match(ipc, /piEngineOpenDependencyRepository/);
  assert.match(ipc, /openPiDependencyRepository/);
  assert.match(register, /openPiDependencyRepository:\s*\(\)\s*=>\s*safeOpenExternal\("https:\/\/github\.com\/earendil-works\/pi"\)/);
  for (const locale of [en, zhCN, zhTW]) {
    assert.match(locale, /openPackageRepository:/);
  }
  assert.match(protocol, /piEngineProgress:/);
});

test("PI runtime update artifacts are built and published per supported release architecture", async () => {
  const [packager, workflow, bundler, packageJson] = await Promise.all([
    read("../../../scripts/package-pi-engine-runtime.mjs"),
    read("../../../.github/workflows/release.yml"),
    read("../../../packages/agent-runtime/scripts/bundle.mjs"),
    read("../../../packages/agent-runtime/package.json"),
  ]);
  assert.match(packager, /const archiveName = `\$\{stem\}\.tar\.gz`/);
  assert.match(packager, /archiveSha256/);
  assert.match(workflow, /Package PI runtime update artifact/);
  assert.match(workflow, /release\/pi-engine-runtime-\*/);
  assert.match(bundler, /runtime-manifest\.json/);
  assert.match(packageJson, /--manifest dist/);
});
