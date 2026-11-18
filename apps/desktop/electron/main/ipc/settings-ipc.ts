import { IPC, type UpdatePreference } from "@pi-desktop/shared";
import { join } from "node:path";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import type { LiveCallService } from "../live-voice/call-service";
import type { AppSettings } from "@pi-desktop/shared";
import { currentSystemProxyRelayUrl } from "../network-proxy";
import type { OmpInstallProgress, OmpManagedEngine } from "../omp/managed-engine";
import type { PiManagedEngine, PiRuntimeProgress } from "../pi/managed-engine";
import { isOmpCustomModelApi, listOmpCustomModels, ompCustomModelSecretRef, readOmpSelectedModel, removeOmpCustomModel, saveOmpCustomModel, updateOmpCustomModelTuning, type OmpCustomModelInput } from "../omp/custom-model";
import { probeOmpCustomModels } from "../omp/custom-model-probe";
import { readOmpHiddenModels, writeOmpHiddenModels } from "../omp/model-visibility";
import { isAppOwnedProvider, readOmpModelOverrides, writeOmpModelOverride, type OmpModelOverrideInput } from "../omp/model-overrides";
import { readOmpProfileSettings, writeOmpProfileSettings } from "../omp/profile-settings.mjs";

export type SettingsIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  normalizeSettings: (settings: unknown) => unknown;
  validateSettingsWrite: (settings: unknown) => any;
  testNetworkProxy: (settings: unknown) => Promise<unknown>;
  applyNetworkProxyFromAppSettings: (settings: unknown) => Promise<unknown>;
  currentNetworkProxy: () => unknown;
  applyApplicationMenuSettings: (settings?: {
    language?: unknown;
    theme?: unknown;
    keybindings?: unknown;
    developerMode?: unknown;
    fontScale?: unknown;
  } | null) => void;
  applyDeveloperMode: (settings?: { developerMode?: unknown } | null) => void;
  applyPreventScreenSleep: (settings?: { preventScreenSleep?: unknown } | null) => void;
  applyKeepAwakeWhileRunning: (settings?: { keepAwakeWhileRunning?: unknown } | null) => void;
  applyUpdatePreference: (preference: UpdatePreference) => void;
  resolveEffectiveCommandShell: () => Promise<unknown>;
  liveCallService?: Pick<LiveCallService, "beginSettingsWrite" | "settingsWritten">;
  stopComputerUse?: () => Promise<void>;
  ompEngine?: OmpManagedEngine;
  emitOmpProgress?: (progress: OmpInstallProgress) => void;
  piEngine?: PiManagedEngine;
  emitPiProgress?: (progress: PiRuntimeProgress) => void;
  openPiReleases?: () => Promise<void>;
  openPiDependencyRepository?: () => Promise<void>;
  openOmpReleases?: () => Promise<void>;
  openOmpEngineStorageFolder?: () => Promise<void>;
  selectOmpBinary?: () => Promise<string | null>;
  isOmpManagementRunning?: () => boolean;
  /** Invalidate running chat sessions whose catalog predates a provider edit. */
  onOmpCatalogChanged?: () => void;
};

/** Register app settings and command-shell channels. */
export function registerSettingsIpc({
  registrar,
  getHost,
  getSidecar,
  dataDir,
  normalizeSettings,
  validateSettingsWrite,
  testNetworkProxy,
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  applyApplicationMenuSettings,
  applyDeveloperMode,
  applyPreventScreenSleep,
  applyKeepAwakeWhileRunning,
  applyUpdatePreference,
  resolveEffectiveCommandShell,
  liveCallService,
  stopComputerUse,
  ompEngine,
  emitOmpProgress,
  piEngine,
  emitPiProgress,
  openPiReleases,
  openPiDependencyRepository,
  openOmpReleases,
  openOmpEngineStorageFolder,
  selectOmpBinary,
  isOmpManagementRunning,
  onOmpCatalogChanged,
}: SettingsIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      return fn(...args);
    });
  };

  handle(IPC.invoke.settingsGet, async () => {
    if (!host) throw new Error("host unavailable");
    const settings = await host.call("settings.get");
    return normalizeSettings(settings);
  });

  handle(IPC.invoke.networkProxyTest, async (settings: unknown) => {
    return testNetworkProxy(settings);
  });

  handle(IPC.invoke.settingsSet, async (settings: unknown) => {
    if (!host) throw new Error("host unavailable");
    const validatedSettings = validateSettingsWrite(settings);
    const currentSettings = await host.call<AppSettings>("settings.get");
    const prospectiveSettings = validatedSettings && typeof validatedSettings === "object" && !Array.isArray(validatedSettings)
      ? { ...currentSettings, ...(validatedSettings as Partial<AppSettings>) }
      : currentSettings;
    if (currentSettings.computerUse?.enabled && !prospectiveSettings.computerUse?.enabled) {
      await stopComputerUse?.();
    }
    const releaseSettingsWrite = liveCallService?.beginSettingsWrite(prospectiveSettings);
    let result: AppSettings;
    try {
      result = await host.call<AppSettings>("settings.set", validatedSettings);
      await liveCallService?.settingsWritten(result);
    } finally {
      releaseSettingsWrite?.();
    }
    const updatePreference = (validatedSettings as { updatePreference?: unknown })
      .updatePreference;
    if (updatePreference === "automatic" || updatePreference === "manual") {
      applyUpdatePreference(updatePreference);
    }
    if (typeof (validatedSettings as { keepAwakeWhileRunning?: unknown })
      .keepAwakeWhileRunning === "boolean") {
      applyKeepAwakeWhileRunning(validatedSettings as { keepAwakeWhileRunning: boolean });
    }
    if (typeof (validatedSettings as { preventScreenSleep?: unknown })
      .preventScreenSleep === "boolean") {
      applyPreventScreenSleep(validatedSettings as { preventScreenSleep: boolean });
    }
    await applyNetworkProxyFromAppSettings(validatedSettings);
    if (sidecar) {
      try {
        await sidecar.call("sidecar.configure", {
          hostBinary: host.binaryPath,
          dataDir,
          networkProxy: currentNetworkProxy(),
          systemProxyRelayUrl: currentSystemProxyRelayUrl(),
        });
      } catch {
        // Sidecar will pick up PI_DESKTOP_PROXY_JSON on the next spawn.
      }
    }
    applyApplicationMenuSettings(
      validatedSettings as {
        language?: unknown;
        theme?: unknown;
        keybindings?: unknown;
        developerMode?: unknown;
        // A docked plugin view follows the saved type scale (D343), so the
        // Appearance write has to carry it to the host's view zoom.
        fontScale?: unknown;
      } | null,
    );
    applyDeveloperMode(validatedSettings as { developerMode?: unknown } | null);
    return result;
  });

  handle(IPC.invoke.commandShellList, async () => resolveEffectiveCommandShell());

  handle(IPC.invoke.ompEngineStatus, async () => {
    if (!ompEngine) return { supported: false };
    return { supported: true, ...(await ompEngine.status()) };
  });
  handle(IPC.invoke.ompEngineInstallOrUpdate, async () => {
    if (!ompEngine) throw new Error("当前平台不支持 OMP 引擎");
    if (isOmpManagementRunning?.()) throw new Error("请先完成或取消 OMP 供应商登录，再更新引擎。");
    const result = await ompEngine.installOrUpdate(emitOmpProgress);
    // A live chat keeps the old executable until it is restarted; defer that to
    // the next idle catalog read instead of killing an in-flight answer.
    onOmpCatalogChanged?.();
    return result;
  });
  handle(IPC.invoke.ompEngineCancel, async () => {
    if (!ompEngine) throw new Error("当前平台不支持 OMP 引擎");
    return ompEngine.cancelOperation();
  });
  handle(IPC.invoke.ompEngineOpenReleases, async () => {
    if (!openOmpReleases) throw new Error("无法打开 OMP 官方发布页");
    await openOmpReleases();
    return { ok: true };
  });
  handle(IPC.invoke.ompEngineOpenStorageFolder, async () => {
    if (!ompEngine || !openOmpEngineStorageFolder) throw new Error("无法打开 OMP 引擎存放目录");
    await openOmpEngineStorageFolder();
    return { ok: true };
  });
  handle(IPC.invoke.ompEngineImportLocal, async () => {
    if (!ompEngine || !selectOmpBinary) throw new Error("当前平台不支持导入 OMP 二进制");
    if (isOmpManagementRunning?.()) throw new Error("请先完成或取消 OMP 供应商登录，再替换引擎。");
    const selectedPath = await selectOmpBinary();
    if (!selectedPath) return { cancelled: true };
    const result = await ompEngine.installLocalBinary(selectedPath, emitOmpProgress);
    onOmpCatalogChanged?.();
    return { cancelled: false, ...result };
  });
  handle(IPC.invoke.ompEngineRollback, async () => {
    if (!ompEngine) throw new Error("当前平台不支持 OMP 引擎");
    if (isOmpManagementRunning?.()) throw new Error("请先完成或取消 OMP 供应商登录，再回滚引擎。");
    const result = await ompEngine.rollback();
    onOmpCatalogChanged?.();
    return result;
  });
  handle(IPC.invoke.piEngineStatus, async () => {
    if (!piEngine) return { supported: false };
    return await piEngine.status();
  });
  handle(IPC.invoke.piEngineInstallOrUpdate, async () => {
    if (!piEngine) throw new Error("当前平台不支持 PI 引擎更新");
    return piEngine.installOrUpdate(emitPiProgress);
  });
  handle(IPC.invoke.piEngineCancel, async () => {
    if (!piEngine) throw new Error("当前平台不支持 PI 引擎更新");
    return piEngine.cancelOperation();
  });
  handle(IPC.invoke.piEngineOpenReleases, async () => {
    if (!openPiReleases) throw new Error("无法打开 PI-Desktop 官方发布页");
    await openPiReleases();
    return { ok: true };
  });
  handle(IPC.invoke.piEngineOpenDependencyRepository, async () => {
    if (!openPiDependencyRepository) throw new Error("无法打开 PI 依赖上游仓库");
    await openPiDependencyRepository();
    return { ok: true };
  });
  handle(IPC.invoke.piEngineRollback, async () => {
    if (!piEngine) throw new Error("当前平台不支持 PI 引擎回滚");
    return piEngine.rollback();
  });
  const ompProfileDir = join(dataDir, "managed-engines", "oh-my-pi", "runtime", "profile");
  handle(IPC.invoke.ompProfileSettingsGet, async () => readOmpProfileSettings(ompProfileDir));
  handle(IPC.invoke.ompProfileSettingsSet, async (input: { defaultThinkingLevel?: unknown; worktreeOnExit?: unknown }) => {
    return writeOmpProfileSettings(ompProfileDir, input);
  });
  // One encrypted secret per custom model, keyed by the entry id, so adding a
  // second endpoint never overwrites the first one's credential.
  const ompSecretStore = {
    get: async (id: string) => {
      if (!host) throw new Error("Host 不可用");
      const result = await host.call<{ value?: string | null }>("secrets.getForRuntime", { secretRef: ompCustomModelSecretRef(id) });
      return typeof result.value === "string" ? result.value : null;
    },
    has: async (id: string) => Boolean(await ompSecretStore.get(id)),
    set: async (id: string, value: string) => {
      if (!host) throw new Error("Host 不可用");
      await host.call("secrets.set", { secretRef: ompCustomModelSecretRef(id), value });
    },
    delete: async (id: string) => {
      if (!host) throw new Error("Host 不可用");
      await host.call("secrets.delete", { secretRef: ompCustomModelSecretRef(id) });
    },
  };
  handle(IPC.invoke.ompCustomModelGet, async () => ({
    // One row per service now, each carrying its own models; the renderer reads
    // `providers` and would see an empty list under the old `models` key.
    providers: await listOmpCustomModels(ompProfileDir, ompSecretStore.has),
  }));
  handle(IPC.invoke.ompCustomModelSave, async (input: OmpCustomModelInput) => {
    if (!ompEngine) throw new Error("当前平台不支持 OMP 引擎");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("OMP 自定义模型配置无效");
    const state = await saveOmpCustomModel(ompProfileDir, input, ompSecretStore);
    // models.json only reaches the engine at process start, so a running chat
    // session would otherwise never list the model the user just added.
    onOmpCatalogChanged?.();
    return state;
  });
  handle(IPC.invoke.ompCustomModelDelete, async (input: { id?: unknown }) => {
    const id = typeof input?.id === "string" ? input.id : "";
    if (!id) throw new Error("缺少要删除的自定义模型");
    await removeOmpCustomModel(ompProfileDir, id, ompSecretStore.delete);
    // Drop the removed provider from catalogs the engine already computed.
    onOmpCatalogChanged?.();
    return { ok: true };
  });
  handle(IPC.invoke.ompCustomModelProbe, async (input: {
    baseUrl?: unknown; api?: unknown; auth?: unknown; apiKey?: unknown; id?: unknown;
  }) => {
    if (!input || typeof input !== "object") throw new Error("OMP 自定义模型配置无效");
    const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : "";
    const api = input.api;
    if (!isOmpCustomModelApi(api)) throw new Error("不支持的 API 兼容协议");
    const auth = input.auth === "none" ? "none" : "apiKey";
    let apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey : null;
    // Editing an entry usually leaves the key field blank; reuse the stored
    // credential so probing does not force a re-typed secret.
    if (!apiKey && auth === "apiKey" && typeof input.id === "string" && input.id) {
      apiKey = await ompSecretStore.get(input.id);
    }
    return { models: await probeOmpCustomModels({ baseUrl, api, auth, apiKey }) };
  });
  // The draft composer has no conversation yet, so it shows the model the
  // engine last used instead of the settings session's bootstrap model.
  handle(IPC.invoke.ompSelectedModelGet, async () => readOmpSelectedModel(ompProfileDir));
  handle(IPC.invoke.ompModelVisibilityGet, async () => ({ hiddenModels: await readOmpHiddenModels(ompProfileDir) }));
  handle(IPC.invoke.ompModelVisibilitySet, async (input: { hiddenModels?: unknown }) => ({
    hiddenModels: await writeOmpHiddenModels(ompProfileDir, input?.hiddenModels),
  }));
  handle(IPC.invoke.ompModelOverrideGet, async () => ({ overrides: await readOmpModelOverrides(ompProfileDir) }));
  handle(IPC.invoke.ompModelOverrideSet, async (input: OmpModelOverrideInput) => {
    if (!input || typeof input !== "object") throw new Error("OMP 模型设置无效");
    const [rawProvider, rawModel] = input.key.split("::");
    let provider = "";
    let modelId = "";
    try {
      provider = decodeURIComponent(rawProvider ?? "");
      modelId = decodeURIComponent(rawModel ?? "");
    } catch {
      throw new Error("模型标识无效");
    }
    // App-owned providers accept real engine tuning; catalog-owned ones keep
    // the values app-side because models.json rejects partial overrides.
    if (isAppOwnedProvider(provider)) {
      await updateOmpCustomModelTuning(ompProfileDir, provider, {
        modelId,
        contextWindow: input.contextWindow,
        maxTokens: input.maxTokens,
        supportsImages: input.supportsImages,
      });
      // Context window and image support are read from models.json at boot; a
      // running session keeps the old limits until it is restarted.
      onOmpCatalogChanged?.();
    }
    return { overrides: await writeOmpModelOverride(ompProfileDir, input) };
  });
}
