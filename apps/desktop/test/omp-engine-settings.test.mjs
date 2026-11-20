import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manager = await readFile(new URL("../src/components/settings/OmpEngineManager.tsx", import.meta.url), "utf8");
const customPanel = await readFile(new URL("../src/components/settings/OmpCustomModelPanel.tsx", import.meta.url), "utf8");
const settingsPage = await readFile(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8");
const providerManager = await readFile(new URL("../src/components/settings/OmpProviderManager.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles/settings.css", import.meta.url), "utf8");

test("Agent engine settings report the current engine without duplicating the composer switch", () => {
  assert.match(manager, /settings\.agentEngines\.defaultEngineHint/);
  assert.match(manager, /settings-agent-engine-state/);
  assert.match(manager, /getAgentEngine\(reportedEngine\)/);
  assert.match(manager, /settings\.defaultAgentEngine \?\? settings\.agentEngine \?\? "pi"/);
  assert.doesNotMatch(manager, /saveSettings/);
  assert.doesNotMatch(manager, /role="group"/);
});

test("Agent engine settings emphasize native OMP behavior and managed version actions", () => {
  assert.doesNotMatch(manager, /settings-agent-engine-protocol-card/);
  assert.match(manager, /settings\.omp\.installed/);
  assert.match(manager, /settings\.omp\.latest/);
  assert.match(manager, /settings\.omp\.rollback/);
  assert.match(manager, /settings\.omp\.importLocal/);
  assert.match(manager, /settings\.omp\.refresh/);
  assert.match(manager, /role="alert"/);
});

test("OMP updates survive settings remounts, reuse verified cached releases, and expose cancel/manual-download controls", async () => {
  const engine = await readFile(new URL("../electron/main/omp/managed-engine.ts", import.meta.url), "utf8");
  const ipc = await readFile(new URL("../electron/main/ipc/settings-ipc.ts", import.meta.url), "utf8");
  const registration = await readFile(new URL("../electron/main/ipc/register.ts", import.meta.url), "utf8");
  const protocol = await readFile(new URL("../../../packages/shared/src/protocol.ts", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

  assert.match(engine, /private currentOperation: OmpEngineOperation \| null/);
  assert.match(engine, /operation: this\.getOperationSnapshot\(\)/);
  assert.match(engine, /isVerifiedInstalledVersion\(/);
  assert.match(engine, /sha256File\(binaryPath, signal\)/);
  assert.match(engine, /async cancelOperation\(/);
  assert.match(engine, /reader\.cancel\(signal\?\.reason\)/);
  assert.match(manager, /applyStatus\(await api\.getOmpEngineStatus\(\)\)/);
  assert.match(manager, /api\.cancelOmpEngineOperation\(\)/);
  assert.match(manager, /settings\.omp\.manualDownload/);
  assert.match(manager, /settings\.omp\.progress\.\$\{progress\.stage\}/);
  assert.match(ipc, /handle\(IPC\.invoke\.ompEngineCancel/);
  assert.match(ipc, /handle\(IPC\.invoke\.ompEngineOpenReleases/);
  assert.match(registration, /safeOpenExternal\("https:\/\/github\.com\/can1357\/oh-my-pi\/releases"\)/);
  assert.match(protocol, /ompEngineCancel:/);
  assert.match(protocol, /ompEngineOpenReleases:/);
  assert.match(api, /cancelOmpEngineOperation:/);
  assert.match(api, /openOmpReleases:/);
});

test("OMP settings open only the managed engine versions folder through a path-free IPC action", async () => {
  const engine = await readFile(new URL("../electron/main/omp/managed-engine.ts", import.meta.url), "utf8");
  const ipc = await readFile(new URL("../electron/main/ipc/settings-ipc.ts", import.meta.url), "utf8");
  const registration = await readFile(new URL("../electron/main/ipc/register.ts", import.meta.url), "utf8");
  const protocol = await readFile(new URL("../../../packages/shared/src/protocol.ts", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

  assert.match(manager, /settings\.omp\.openEngineFolder/);
  assert.match(manager, /api\.openOmpEngineStorageFolder\(\)/);
  assert.match(engine, /async ensureVersionsDirectory\(\)[\s\S]*join\(this\.deps\.rootDir, "versions"\)/);
  assert.match(ipc, /handle\(IPC\.invoke\.ompEngineOpenStorageFolder[\s\S]*openOmpEngineStorageFolder\(\)/);
  assert.match(registration, /ompEngine\.ensureVersionsDirectory\(\)/);
  assert.match(registration, /shell\.openPath\(directory\)/);
  assert.match(protocol, /ompEngineOpenStorageFolder:/);
  assert.match(api, /openOmpEngineStorageFolder: \(\) => invoke<\{ ok: boolean \}>\(IPC\.invoke\.ompEngineOpenStorageFolder\)/);
  assert.doesNotMatch(api, /openOmpEngineStorageFolder: \([^)]*path/);
});

test("Agent engine settings layout wraps cleanly on narrow panes and keeps visible focus affordance", () => {
  assert.match(styles, /\.settings-agent-engine-option\.is-selected/);
  assert.match(styles, /\.settings-agent-engine-option:focus-visible/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /\.settings-agent-engine-cards,\s*\.settings-agent-engine-version-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /\.settings-agent-engine-actions/);
});

test("Agent settings separate engine, provider/model, and custom API workflows into accessible tabs", () => {
  assert.match(settingsPage, /settings-agent-settings-tabs/);
  assert.match(settingsPage, /role="tablist"/);
  assert.match(settingsPage, /role="tabpanel"/);
  assert.match(settingsPage, /settings\.omp\.providersTitle/);
  assert.match(settingsPage, /settings\.omp\.customModelTitle/);
  assert.match(manager, /section === "customApi"/);
  assert.match(manager, /<OmpCustomModelPanel \/>/);
  assert.match(styles, /\.settings-agent-settings-panel \{ min-width: 0; \}/);
});

test("Settings content and custom API fields have bounded, responsive layout", () => {
  assert.match(styles, /\.settings-content-inner[\s\S]*max-width: 1440px/);
  assert.match(styles, /\.settings-omp-custom-grid[\s\S]*max-width: 920px/);
  // Nested scroll boxes clipped the last visible row in half; the settings
  // page owns scrolling instead.
  assert.doesNotMatch(styles, /\.settings-omp-(?:provider|model)-list\s*\{[^}]*overflow:\s*auto/);
  assert.match(styles, /\.settings-omp-custom-pair \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(customPanel, /<span>\{t\("settings\.omp\.customModelProtocol"\)\}<\/span>\s*<select/);
});

test("models carry per-model settings and the composer honors the stored defaults", async () => {
  const dialog = await readFile(new URL("../src/components/settings/OmpModelSettingsDialog.tsx", import.meta.url), "utf8");
  const picker = await readFile(new URL("../src/features/chat/composer/ComposerOmpModelPicker.tsx", import.meta.url), "utf8");
  // The row exposes a settings affordance and shows the aliased name.
  assert.match(providerManager, /settings-omp-model-configure/);
  assert.match(providerManager, /override\?\.displayName \?\? model\.name/);
  assert.match(dialog, /setOmpModelOverride/);
  // Only app-owned providers may push tuning into the engine.
  assert.match(dialog, /const engineEditable = model\.provider\.startsWith\("pi_custom_"\)/);
  assert.match(dialog, /settings\.omp\.modelContextManaged/);
  // The picker applies the model-level default thinking level after set_model.
  assert.match(picker, /defaultThinkingLevel/);
  assert.match(picker, /set_thinking_level/);
  assert.match(styles, /\.settings-omp-model-configure/);
});

test("OMP profile worktree exit settings require a UI confirmation for force cleanup", async () => {
  const profile = await readFile(new URL("../src/components/settings/OmpProfileSettings.tsx", import.meta.url), "utf8");
  const profileModule = await readFile(new URL("../electron/main/omp/profile-settings.mjs", import.meta.url), "utf8");
  const settingsIpc = await readFile(new URL("../electron/main/ipc/settings-ipc.ts", import.meta.url), "utf8");
  assert.doesNotMatch(profile, /electron\/main\/omp\/profile-settings/);
  assert.match(profile, /value === "force"/);
  assert.match(profile, /profileWorktreeForceWarning/);
  assert.match(profile, /profileWorktreeForceConfirm/);
  assert.match(profile, /profileWorktreeForceCancel/);
  assert.match(profileModule, /worktree:[\s\S]*?onExit:/);
  assert.match(profileModule, /atomicWrite\(configPath/);
  assert.match(settingsIpc, /worktreeOnExit/);
});

test("OMP thinking-level names and the composer label use separate locale keys", async () => {
  const picker = await readFile(new URL("../src/features/chat/composer/ComposerOmpModelPicker.tsx", import.meta.url), "utf8");
  const en = await readFile(new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url), "utf8");
  const zh = await readFile(new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url), "utf8");
  for (const locale of [en, zh]) {
    assert.match(locale, /thinking:\s*\{\s*auto:/);
    assert.match(locale, /thinkingEffort:/);
  }
  assert.doesNotMatch(en, /thinking:\s*"Thinking effort"/);
  assert.doesNotMatch(zh, /thinking:\s*"思考强度"/);
  assert.match(picker, /settings\.omp\.thinkingEffort/);
});

test("the engine child inherits the app proxy so OAuth token exchange is not geo-blocked", async () => {
  const runtime = await readFile(new URL("../electron/main/omp/rpc-runtime.ts", import.meta.url), "utf8");
  const proxy = await readFile(new URL("../electron/main/network-proxy.ts", import.meta.url), "utf8");
  assert.match(runtime, /applyProxyToChildEnv\(childEnv\)/);
  assert.match(proxy, /ensureSystemProxyRelay\(\)/);
  assert.match(proxy, /if \(applied\.mode === "direct"\) return;/);
  assert.match(proxy, /\[\.\.\.current, \.\.\.bypass, \.\.\.DIRECT_PROVIDER_HOSTS\]/);
  assert.match(proxy, /"bigmodel\.cn"/);
  // Geo-blocked logins must give an actionable message, not a raw JSON dump.
  assert.match(providerManager, /unsupported_country_region_territory/i);
  assert.match(providerManager, /loginRegionBlocked/);
});

test("provider-tab remounts share one OMP management-session lifecycle", () => {
  assert.match(providerManager, /const ompManagementSession = createOmpManagementSession/);
  assert.match(providerManager, /ompManagementSession\.run\(/);
  assert.doesNotMatch(providerManager, /finally\s*\{\s*await stopManagement\(\)/);
});

test("providers are previewed and models are grouped instead of one endless page", () => {
  // Providers and models became two views, so the model list is not buried.
  assert.match(providerManager, /SegmentedControl/);
  assert.match(providerManager, /tab === "providers"/);
  assert.match(providerManager, /tab === "models"/);
  // Only a short preview of providers renders until the user asks for more.
  assert.match(providerManager, /PROVIDER_PREVIEW_LIMIT/);
  assert.match(providerManager, /shownProviders/);
  assert.match(providerManager, /Number\(right\.authenticated\) - Number\(left\.authenticated\)/);
  // Models are grouped under their provider, with per-group visibility toggles.
  assert.match(providerManager, /const modelGroups = useMemo/);
  assert.match(providerManager, /setGroupVisible/);
  assert.match(styles, /\.settings-omp-model-group-head/);
});

test("OMP custom services reuse the native model picker and never re-display saved keys", () => {
  assert.match(customPanel, /customModelTitle/);
  assert.match(customPanel, /customModelProtocol/);
  assert.match(customPanel, /openai-completions/);
  assert.match(customPanel, /anthropic-messages/);
  assert.match(customPanel, /type="password"/);
  assert.match(customPanel, /customModelKeySaved/);
  assert.match(customPanel, /setDraft\(\(old\) => \(\{ \.\.\.old, apiKey: "" \}\)\)/);
  assert.match(customPanel, /saveOmpCustomModel/);
  assert.match(customPanel, /deleteOmpCustomModel/);
  assert.match(customPanel, /probeOmpCustomModels/);
  // One service, many models: the form renders the same panes as the native
  // AI-service dialog instead of a second hand-rolled model list.
  assert.match(customPanel, /<ModelSelectionPanes/);
  assert.match(customPanel, /useModelSelection\(/);
  assert.match(customPanel, /bindingsToPersist/);
  // Controls models.json cannot store are hidden rather than silently dropped.
  assert.match(customPanel, /hiddenAdvanced=\{\["thinkingProtocol", "documents", "subagents", "nativeWebSearch", "fastMode"\]\}/);
  assert.match(customPanel, /canReload/);
});

test("a provider or model change invalidates catalogs frozen in live chat sessions", async () => {
  const runtime = await readFile(new URL("../electron/main/omp/rpc-runtime.ts", import.meta.url), "utf8");
  const ipc = await readFile(new URL("../electron/main/ipc/register.ts", import.meta.url), "utf8");
  const settingsIpc = await readFile(new URL("../electron/main/ipc/settings-ipc.ts", import.meta.url), "utf8");
  const picker = await readFile(new URL("../src/features/chat/composer/ComposerOmpModelPicker.tsx", import.meta.url), "utf8");
  // OMP reads models.json and credentials once at boot, so the desktop has to
  // invalidate a running process instead of trusting its cached snapshot.
  assert.match(runtime, /if \(type === "get_available_models"\) await this\.reloadStaleCatalog\(sessionId\)/);
  assert.match(runtime, /markCatalogStale\(\): void/);
  assert.match(runtime, /if \(session\.busy \|\| session\.forking \|\| session\.mappingPrompt\) return;/);
  assert.match(ipc, /command === "login" \|\| command === "logout"\) ompRpcRuntime!\.markCatalogStale\(\)/);
  assert.match(ipc, /onOmpCatalogChanged: \(\) => ompRpcRuntime\?\.markCatalogStale\(\)/);
  assert.match(settingsIpc, /onOmpCatalogChanged\?\.\(\);/);
  // The catalog read may restart the child, so it cannot race other RPCs.
  assert.match(picker, /const result = await api\.ompRpcCommand\(\{ sessionId: rpcSessionId, command: "get_available_models" \}\)/);
});

test("the composer model chip paints persisted state before the engine cold-starts", async () => {
  const picker = await readFile(new URL("../src/features/chat/composer/ComposerOmpModelPicker.tsx", import.meta.url), "utf8");
  // A cold engine costs seconds (startup + online discovery), so the label and
  // the catalog must come from storage first and refresh invisibly after.
  assert.match(picker, /const CATALOG_STORAGE_KEY = "pi\.omp\.modelCatalog"/);
  assert.match(picker, /const storedModel = readStoredModel\(cacheKey\)/);
  assert.match(picker, /writeStoredCatalog\(nextModels, nextLevels\)/);
  assert.match(picker, /writeStoredModel\(cacheKey, candidate\)/);
  assert.match(picker, /const needsSpinner = !cached && !paintedRef\.current/);
  // Warm rows become clickable before attach finishes, so choosing waits for it.
  assert.match(picker, /await loadPromiseRef\.current\?\.catch\(\(\) => false\)/);
  // The "new task" page has no conversation yet, but preselecting a model is
  // still allowed: the settings session answers it and the choice is persisted.
  assert.match(picker, /const draft = !sessionId/);
  assert.match(picker, /const rpcSessionId = sessionId \?\? OMP_SETTINGS_RPC_SESSION_ID/);
  assert.match(picker, /disabled=\{controlsBlocked\}/);
});
