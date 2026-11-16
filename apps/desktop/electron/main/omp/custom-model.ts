import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OMP_THINKING_LEVELS,
  readOmpModelOverrides,
  writeOmpModelOverride,
  type OmpThinkingLevel,
} from "./model-overrides.ts";

/** Legacy single-model identifiers; kept so existing profiles keep working. */
export const OMP_CUSTOM_MODEL_SECRET_REF = "omp.custom-model.api-key";
export const OMP_CUSTOM_MODEL_ENV = "PI_OMP_CUSTOM_MODEL_API_KEY";

const LEGACY_ID = "compatible";
const RECORDS_FILE = "pi-custom-models.json";
const LEGACY_RECORDS_FILE = "pi-custom-model.json";
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

export type OmpCustomModelApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/** One model of a custom service, as the settings form describes it. */
export type OmpCustomModelEntryInput = {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  thinkingLevels?: readonly string[];
  defaultThinkingLevel?: string;
  supportsReasoningEffort?: boolean;
};

export type OmpCustomModelInput = {
  providerName: string;
  baseUrl: string;
  api: OmpCustomModelApi;
  auth: "apiKey" | "none";
  models?: OmpCustomModelEntryInput[];
  apiKey?: string;
  /** Present when editing an existing entry; omitted when adding a new one. */
  id?: string;
  /** Legacy single-model fields; folded into `models` when present. */
  modelId?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
};

export type OmpCustomModelEntry = {
  id: string;
  displayName?: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  thinkingLevels: OmpThinkingLevel[];
  defaultThinkingLevel?: OmpThinkingLevel;
  supportsReasoningEffort?: boolean;
};

/** A saved service and everything the picker stored for it. */
export type OmpCustomModelState = {
  id: string;
  providerId: string;
  providerName: string;
  baseUrl: string;
  api: OmpCustomModelApi;
  auth: "apiKey" | "none";
  configured: boolean;
  models: OmpCustomModelEntry[];
};

type StoredProvider = Omit<OmpCustomModelState, "providerId" | "configured">;

type SecretStore = {
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
};

/**
 * OMP resolves a provider's `apiKey` from an exact environment-variable name,
 * so every custom entry needs its own variable. The legacy id keeps the
 * original name to avoid breaking profiles written by earlier builds.
 */
export function ompCustomModelEnvName(id: string): string {
  if (id === LEGACY_ID) return OMP_CUSTOM_MODEL_ENV;
  return `${OMP_CUSTOM_MODEL_ENV}_${id.replace(/-/g, "_").toUpperCase()}`;
}

export function ompCustomModelSecretRef(id: string): string {
  if (id === LEGACY_ID) return OMP_CUSTOM_MODEL_SECRET_REF;
  return `omp.custom-model.${id}.api-key`;
}

export function ompCustomModelProviderId(id: string): string {
  return `pi_custom_${id}`;
}

export function isOmpCustomModelApi(value: unknown): value is OmpCustomModelApi {
  return value === "openai-completions" || value === "openai-responses" || value === "anthropic-messages" || value === "google-generative-ai";
}

/** Shared by saving and by the model probe so both enforce the same address rules. */
export function normalizeOmpCustomModelBaseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("API 地址必须是有效的 http(s) URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("API 地址只支持 http 或 https");
  if (url.username || url.password || url.search || url.hash) throw new Error("API 地址不能包含账号密码、查询参数或片段");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) throw new Error("非本机服务必须使用 HTTPS");
  return url.toString().replace(/\/$/, "");
}

function isThinkingLevel(value: unknown): value is OmpThinkingLevel {
  return typeof value === "string" && (OMP_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Thinking levels double as the engine's provider-value map: a level the user
 * did not tick is written as `null` so the runtime hides it, while a ticked
 * standard level stays unmapped and keeps the provider's own effort value.
 * `xhigh` and `max` are opt-in on this wire, so they need a literal value.
 */
function thinkingLevelMap(levels: readonly OmpThinkingLevel[]): Record<string, string | null> | undefined {
  const enabled = new Set(levels);
  if (!levels.some((level) => level !== "off")) return undefined;
  const map: Record<string, string | null> = {};
  for (const level of OMP_THINKING_LEVELS) {
    // `off` is not a provider value: leaving it unmapped keeps "disable
    // thinking" available even when no other level was ticked.
    if (level === "off") continue;
    if (level === "xhigh" || level === "max") map[level] = enabled.has(level) ? level : null;
    else if (!enabled.has(level)) map[level] = null;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function validateEntry(raw: OmpCustomModelEntryInput | null | undefined): OmpCustomModelEntry {
  if (!raw || typeof raw !== "object") throw new Error("模型配置无效");
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || id.length > 160 || /[\r\n\0]/.test(id)) throw new Error("模型 ID 无效");
  const name = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (name.length > 120 || /[\r\n\0]/.test(name)) throw new Error("模型显示名称无效");
  const contextWindow = raw.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10_000_000) throw new Error(`模型 ${id}：上下文窗口必须为 1,024–10,000,000 的整数`);
  const maxTokens = raw.maxTokens ?? Math.min(DEFAULT_MAX_TOKENS, contextWindow);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error(`模型 ${id}：最大输出必须大于 0 且不超过上下文窗口`);
  const levels = Array.isArray(raw.thinkingLevels)
    ? OMP_THINKING_LEVELS.filter((level) => raw.thinkingLevels?.includes(level))
    : [];
  const defaultLevel = isThinkingLevel(raw.defaultThinkingLevel) && levels.includes(raw.defaultThinkingLevel)
    ? raw.defaultThinkingLevel
    : undefined;
  return {
    id,
    ...(name ? { displayName: name } : {}),
    contextWindow,
    maxTokens,
    supportsImages: raw.supportsImages === true,
    thinkingLevels: [...levels],
    ...(defaultLevel ? { defaultThinkingLevel: defaultLevel } : {}),
    ...(typeof raw.supportsReasoningEffort === "boolean" ? { supportsReasoningEffort: raw.supportsReasoningEffort } : {}),
  };
}

/** One service can carry many models; a flat legacy payload becomes one entry. */
function inputEntries(input: OmpCustomModelInput): OmpCustomModelEntry[] {
  const raw = Array.isArray(input.models) && input.models.length > 0
    ? input.models
    : typeof input.modelId === "string" && input.modelId.trim()
      ? [{ id: input.modelId, contextWindow: input.contextWindow, maxTokens: input.maxTokens, supportsImages: input.supportsImages }]
      : [];
  if (raw.length === 0) throw new Error("请至少选择一个模型");
  const entries = raw.map(validateEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.id.toLowerCase();
    if (seen.has(key)) throw new Error(`模型 ID 重复：${entry.id}`);
    seen.add(key);
  }
  return entries;
}

async function readJson(path: string): Promise<Record<string, any>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("OMP 配置文件损坏；未覆盖原文件，请先备份并修复配置文件");
  }
}

async function readJsonOrNull(path: string): Promise<Record<string, any> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("OMP 配置文件损坏；未覆盖原文件，请先备份并修复配置文件");
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

/**
 * Older profiles can contain a `models.yml` that the engine prefers over
 * `models.json`, so every service saved afterwards stayed invisible in the
 * catalog. Retire it — keeping a backup — only when it declares nothing the
 * JSON catalog does not already cover, so a hand-written YAML is never lost.
 */
async function retireStaleModelYaml(profileDir: string): Promise<void> {
  const yamlPath = join(profileDir, "models.yml");
  let text: string;
  try {
    text = await readFile(yamlPath, "utf8");
  } catch {
    return;
  }
  let root: Record<string, any> = {};
  try {
    root = await readJson(join(profileDir, "models.json"));
  } catch {
    // A corrupt models.json is reported elsewhere; leave the YAML untouched.
    return;
  }
  const known = root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)
    ? Object.keys(root.providers)
    : [];
  const declared = [...text.matchAll(/^ {2}([A-Za-z0-9_.-]+):\s*$/gm)].map((match) => match[1]);
  if (declared.length === 0 || declared.some((name) => !known.includes(name))) return;
  await rename(yamlPath, `${yamlPath}.${Date.now()}.bak`).catch(() => undefined);
}

function normalizeStoredEntry(value: unknown): OmpCustomModelEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim()
    ? record.id.trim()
    : typeof record.modelId === "string" ? record.modelId.trim() : "";
  if (!id || id.length > 160 || /[\r\n\0]/.test(id)) return null;
  const name = typeof record.displayName === "string" ? record.displayName.trim().slice(0, 120) : "";
  const contextWindow = Number.isSafeInteger(record.contextWindow) && Number(record.contextWindow) >= 1024
    ? Number(record.contextWindow)
    : DEFAULT_CONTEXT_WINDOW;
  const storedMax = Number.isSafeInteger(record.maxTokens) ? Number(record.maxTokens) : DEFAULT_MAX_TOKENS;
  const maxTokens = Math.min(Math.max(1, storedMax), contextWindow);
  const levels = Array.isArray(record.thinkingLevels)
    ? OMP_THINKING_LEVELS.filter((level) => (record.thinkingLevels as unknown[]).includes(level))
    : [];
  const defaultLevel = isThinkingLevel(record.defaultThinkingLevel) && levels.includes(record.defaultThinkingLevel)
    ? record.defaultThinkingLevel
    : undefined;
  return {
    id,
    ...(name ? { displayName: name } : {}),
    contextWindow,
    maxTokens,
    supportsImages: record.supportsImages === true,
    thinkingLevels: [...levels],
    ...(defaultLevel ? { defaultThinkingLevel: defaultLevel } : {}),
    ...(typeof record.supportsReasoningEffort === "boolean" ? { supportsReasoningEffort: record.supportsReasoningEffort } : {}),
  };
}

/** Reads both the current provider layout and the pre-multi-model flat one. */
function normalizeStoredProvider(value: unknown): StoredProvider | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!ID_PATTERN.test(id)) return null;
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl : "";
  if (!baseUrl) return null;
  const api = isOmpCustomModelApi(record.api) ? record.api : "openai-completions";
  const models = Array.isArray(record.models)
    ? record.models.map(normalizeStoredEntry).filter((entry): entry is OmpCustomModelEntry => entry !== null)
    : [normalizeStoredEntry({ ...record, id: record.modelId })].filter((entry): entry is OmpCustomModelEntry => entry !== null);
  if (models.length === 0) return null;
  const providerName = typeof record.providerName === "string" && record.providerName.trim()
    ? record.providerName.trim()
    : models[0].id;
  return { id, providerName, baseUrl, api, auth: record.auth === "none" ? "none" : "apiKey", models };
}

/** Read the service list, migrating the pre-multi-model profile on first touch. */
async function readStoredProviders(profileDir: string): Promise<StoredProvider[]> {
  // Runs before every engine spawn as well, so a stale YAML snapshot is out of
  // the way before the child reads its catalog.
  await retireStaleModelYaml(profileDir).catch(() => undefined);
  const current = await readJsonOrNull(join(profileDir, RECORDS_FILE));
  if (current) {
    const list = Array.isArray(current.providers)
      ? current.providers
      : Array.isArray(current.models) ? current.models : [];
    return list
      .map(normalizeStoredProvider)
      .filter((item): item is StoredProvider => item !== null);
  }
  const legacy = await readJsonOrNull(join(profileDir, LEGACY_RECORDS_FILE));
  if (!legacy || typeof legacy.modelId !== "string") return [];
  const migrated = normalizeStoredProvider({ ...legacy, id: LEGACY_ID });
  if (!migrated) return [];
  // Best effort: a read-only profile still lists the model, it just cannot
  // persist the new layout until the next successful save.
  await atomicJson(join(profileDir, RECORDS_FILE), { version: 3, providers: [migrated] }).catch(() => undefined);
  return [migrated];
}

function slugify(value: string): string {
  const slug = value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return slug || "model";
}

function uniqueId(providers: StoredProvider[], base: string): string {
  const used = new Set(providers.map((provider) => provider.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 32);
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 32);
}

function toState(provider: StoredProvider, configured: boolean): OmpCustomModelState {
  return {
    id: provider.id,
    providerId: ompCustomModelProviderId(provider.id),
    providerName: provider.providerName,
    baseUrl: provider.baseUrl,
    api: provider.api,
    auth: provider.auth,
    configured,
    models: provider.models.map((entry) => ({ ...entry, thinkingLevels: [...entry.thinkingLevels] })),
  };
}

function overrideKey(providerId: string, modelId: string): string {
  return `${encodeURIComponent(providerId)}::${encodeURIComponent(modelId)}`;
}

/**
 * Alias and default thinking level live in the app-side override file because
 * `models.json` has no field for them; limits and image support also mirror
 * there so the per-model dialog shows what the picker just saved.
 */
async function syncProviderOverrides(profileDir: string, providerId: string, entries: OmpCustomModelEntry[]): Promise<void> {
  const prefix = `${encodeURIComponent(providerId)}::`;
  const keep = new Set(entries.map((entry) => overrideKey(providerId, entry.id)));
  let existing: Record<string, unknown> = {};
  try {
    existing = await readOmpModelOverrides(profileDir);
  } catch {
    // A corrupt override file must not block saving the service itself.
    return;
  }
  for (const key of Object.keys(existing)) {
    if (!key.startsWith(prefix) || keep.has(key)) continue;
    await writeOmpModelOverride(profileDir, { key }).catch(() => undefined);
  }
  for (const entry of entries) {
    await writeOmpModelOverride(profileDir, {
      key: overrideKey(providerId, entry.id),
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      supportsImages: entry.supportsImages,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      ...(entry.defaultThinkingLevel ? { defaultThinkingLevel: entry.defaultThinkingLevel } : {}),
    }).catch(() => undefined);
  }
}

async function clearProviderOverrides(profileDir: string, providerId: string): Promise<void> {
  const prefix = `${encodeURIComponent(providerId)}::`;
  let existing: Record<string, unknown> = {};
  try {
    existing = await readOmpModelOverrides(profileDir);
  } catch {
    return;
  }
  for (const key of Object.keys(existing)) {
    if (!key.startsWith(prefix)) continue;
    await writeOmpModelOverride(profileDir, { key }).catch(() => undefined);
  }
}

export async function listOmpCustomModels(
  profileDir: string,
  hasSecret: (id: string) => Promise<boolean>,
): Promise<OmpCustomModelState[]> {
  const providers = await readStoredProviders(profileDir);
  return Promise.all(providers.map(async (provider) => toState(provider, provider.auth === "none" || await hasSecret(provider.id))));
}

/** Environment handed to the OMP child so every configured provider can authenticate. */
export async function readOmpCustomModelKeys(
  profileDir: string,
  getSecret: (id: string) => Promise<string | null>,
): Promise<Record<string, string>> {
  const providers = await readStoredProviders(profileDir);
  const entries = await Promise.all(providers.map(async (provider) => {
    if (provider.auth !== "apiKey") return null;
    const value = await getSecret(provider.id);
    return value ? [ompCustomModelEnvName(provider.id), value] as const : null;
  }));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null));
}

/** Merge only the app-owned provider rows, preserving every other OMP provider. */
export async function saveOmpCustomModel(
  profileDir: string,
  input: OmpCustomModelInput,
  secrets: SecretStore,
): Promise<OmpCustomModelState> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("OMP 自定义模型配置无效");
  if (!isOmpCustomModelApi(input.api)) throw new Error("不支持的 API 兼容协议");
  if (input.auth !== "apiKey" && input.auth !== "none") throw new Error("不支持的认证方式");
  const providerName = typeof input.providerName === "string" ? input.providerName.trim() : "";
  if (!providerName || providerName.length > 80) throw new Error("服务名称长度必须为 1–80 个字符");
  const baseUrl = normalizeOmpCustomModelBaseUrl(typeof input.baseUrl === "string" ? input.baseUrl : "");
  const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
  if (apiKey.length > 16_384 || /\0/.test(apiKey)) throw new Error("API Key 无效");
  const entries = inputEntries(input);

  const providers = await readStoredProviders(profileDir);
  let id: string;
  if (typeof input.id === "string" && input.id.length > 0) {
    if (!ID_PATTERN.test(input.id)) throw new Error("自定义模型标识无效");
    id = input.id;
  } else {
    id = uniqueId(providers, slugify(entries[0].id || providerName));
  }
  const providerId = ompCustomModelProviderId(id);
  const root = await readJson(join(profileDir, "models.json"));
  const rows = root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)
    ? root.providers
    : {};
  const keyProvided = apiKey.length > 0;
  if (input.auth === "none") await secrets.delete(id);
  else if (keyProvided) await secrets.set(id, apiKey);
  const configured = input.auth === "none" || keyProvided || await secrets.has(id);
  if (!configured) throw new Error("请填写 API Key，或将认证方式切换为“无需 API Key”");

  rows[providerId] = {
    baseUrl,
    api: input.api,
    auth: input.auth,
    ...(input.auth === "apiKey" ? { apiKey: ompCustomModelEnvName(id), authHeader: true } : {}),
    models: entries.map((entry) => {
      const map = thinkingLevelMap(entry.thinkingLevels);
      return {
        id: entry.id,
        ...(entry.displayName ? { name: entry.displayName } : {}),
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxTokens,
        input: entry.supportsImages ? ["text", "image"] : ["text"],
        supportsTools: true,
        reasoning: entry.thinkingLevels.some((level) => level !== "off"),
        ...(map ? { thinkingLevelMap: map } : {}),
        ...(typeof entry.supportsReasoningEffort === "boolean"
          ? { compat: { supportsReasoningEffort: entry.supportsReasoningEffort } }
          : {}),
      };
    }),
  };
  await mkdir(profileDir, { recursive: true });
  await atomicJson(join(profileDir, "models.json"), { ...root, providers: rows });

  const stored: StoredProvider = {
    id,
    providerName,
    baseUrl,
    api: input.api,
    auth: input.auth,
    models: entries,
  };
  const existingIndex = providers.findIndex((provider) => provider.id === id);
  const next = existingIndex >= 0
    ? providers.map((provider) => (provider.id === id ? stored : provider))
    : [...providers, stored];
  await atomicJson(join(profileDir, RECORDS_FILE), { version: 3, providers: next });
  await syncProviderOverrides(profileDir, providerId, entries);
  return toState(stored, configured);
}

/**
 * Tuning for app-owned providers can be pushed into models.json, so the engine
 * actually honors the new context window and image support. Returns false for
 * catalog-owned providers, whose metadata the engine will not accept.
 */
export async function updateOmpCustomModelTuning(
  profileDir: string,
  providerId: string,
  patch: { modelId?: string; contextWindow?: number; maxTokens?: number; supportsImages?: boolean },
): Promise<boolean> {
  if (!providerId.startsWith("pi_custom_")) return false;
  const id = providerId.slice("pi_custom_".length);
  if (!ID_PATTERN.test(id)) return false;
  const providers = await readStoredProviders(profileDir);
  const providerIndex = providers.findIndex((provider) => provider.id === id);
  if (providerIndex < 0) return false;
  const provider = providers[providerIndex];
  // A legacy single-model row has an unambiguous target; a multi-model row
  // needs the id from the override key.
  const entryIndex = typeof patch.modelId === "string" && patch.modelId
    ? provider.models.findIndex((entry) => entry.id === patch.modelId)
    : provider.models.length === 1 ? 0 : -1;
  if (entryIndex < 0) return false;
  const current = provider.models[entryIndex];
  const contextWindow = patch.contextWindow ?? current.contextWindow;
  const maxTokens = patch.maxTokens ?? current.maxTokens;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10_000_000) throw new Error("上下文窗口必须为 1,024–10,000,000 的整数");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error("最大输出必须大于 0 且不超过上下文窗口");
  const supportsImages = patch.supportsImages ?? current.supportsImages;
  const nextEntry: OmpCustomModelEntry = { ...current, contextWindow, maxTokens, supportsImages };

  const path = join(profileDir, "models.json");
  const root = await readJson(path);
  const rows = root.providers && typeof root.providers === "object" && !Array.isArray(root.providers) ? root.providers : null;
  const row = rows?.[providerId];
  if (row && typeof row === "object" && Array.isArray(row.models)) {
    row.models = row.models.map((model: Record<string, unknown>) =>
      model && typeof model === "object" && model.id === nextEntry.id
        ? { ...model, contextWindow, maxTokens, input: supportsImages ? ["text", "image"] : ["text"] }
        : model,
    );
    await atomicJson(path, { ...root, providers: rows });
  }
  const nextProvider: StoredProvider = {
    ...provider,
    models: provider.models.map((entry, index) => (index === entryIndex ? nextEntry : entry)),
  };
  await atomicJson(join(profileDir, RECORDS_FILE), {
    version: 3,
    providers: providers.map((entry, index) => (index === providerIndex ? nextProvider : entry)),
  });
  return true;
}

export async function removeOmpCustomModel(
  profileDir: string,
  id: string,
  deleteSecret: (id: string) => Promise<void>,
): Promise<void> {
  if (!ID_PATTERN.test(id)) throw new Error("自定义模型标识无效");
  const providers = await readStoredProviders(profileDir);
  const providerId = ompCustomModelProviderId(id);
  const path = join(profileDir, "models.json");
  const current = await readJson(path);
  if (current.providers && typeof current.providers === "object") {
    const rows = { ...current.providers };
    delete rows[providerId];
    await atomicJson(path, { ...current, providers: rows });
  }
  const selectedPath = join(profileDir, "pi-selected-model.json");
  const selected = await readJson(selectedPath);
  if (selected.provider === providerId) {
    try { await unlink(selectedPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await deleteSecret(id);
  await clearProviderOverrides(profileDir, providerId);
  await atomicJson(join(profileDir, RECORDS_FILE), { version: 3, providers: providers.filter((provider) => provider.id !== id) });
  if (id === LEGACY_ID) await atomicJson(join(profileDir, LEGACY_RECORDS_FILE), {});
}

/** The model the engine used last; a fresh conversation starts from it. */
export async function readOmpSelectedModel(
  profileDir: string,
): Promise<{ provider: string; modelId: string } | null> {
  const value = await readJsonOrNull(join(profileDir, "pi-selected-model.json"));
  if (!value) return null;
  return typeof value.provider === "string" && typeof value.modelId === "string"
    ? { provider: value.provider, modelId: value.modelId }
    : null;
}
