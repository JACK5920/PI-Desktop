import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OVERRIDES_FILE = "pi-model-overrides.json";
const MAX_ENTRIES = 5000;

export const OMP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type OmpThinkingLevel = (typeof OMP_THINKING_LEVELS)[number];

export type OmpModelOverride = {
  displayName?: string;
  defaultThinkingLevel?: OmpThinkingLevel;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
};

export type OmpModelOverrideInput = OmpModelOverride & {
  /** Encoded `provider::modelId` key, identical to the visibility key. */
  key: string;
};

export function ompModelOverrideKey(provider: string, modelId: string): string {
  return `${encodeURIComponent(provider)}::${encodeURIComponent(modelId)}`;
}

function isThinkingLevel(value: unknown): value is OmpThinkingLevel {
  return typeof value === "string" && (OMP_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * The same validation runs on read and write so a hand-edited file cannot
 * smuggle values the renderer would never produce.
 */
export function normalizeOverride(value: unknown): OmpModelOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OMP 模型设置无效");
  const record = value as Record<string, unknown>;
  const next: OmpModelOverride = {};
  if (record.displayName !== undefined && record.displayName !== null) {
    if (typeof record.displayName !== "string") throw new Error("模型显示名称无效");
    const name = record.displayName.trim();
    if (name.length > 120 || /[\r\n\0]/.test(name)) throw new Error("模型显示名称无效");
    if (name) next.displayName = name;
  }
  if (record.defaultThinkingLevel !== undefined && record.defaultThinkingLevel !== null) {
    if (!isThinkingLevel(record.defaultThinkingLevel)) throw new Error("默认思考等级无效");
    next.defaultThinkingLevel = record.defaultThinkingLevel;
  }
  if (record.contextWindow !== undefined && record.contextWindow !== null) {
    if (!Number.isSafeInteger(record.contextWindow) || (record.contextWindow as number) < 1024 || (record.contextWindow as number) > 10_000_000) {
      throw new Error("上下文窗口必须为 1,024–10,000,000 的整数");
    }
    next.contextWindow = record.contextWindow as number;
  }
  if (record.maxTokens !== undefined && record.maxTokens !== null) {
    if (!Number.isSafeInteger(record.maxTokens) || (record.maxTokens as number) < 1 || (record.maxTokens as number) > 10_000_000) {
      throw new Error("最大输出必须为 1–10,000,000 的整数");
    }
    next.maxTokens = record.maxTokens as number;
  }
  if (next.contextWindow !== undefined && next.maxTokens !== undefined && next.maxTokens > next.contextWindow) {
    throw new Error("最大输出不能超过上下文窗口");
  }
  if (record.supportsImages !== undefined && record.supportsImages !== null) {
    if (typeof record.supportsImages !== "boolean") throw new Error("图片输入开关无效");
    next.supportsImages = record.supportsImages;
  }
  return next;
}

function validateKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 800 || !key.includes("::")) throw new Error("模型标识无效");
  return key;
}

export async function readOmpModelOverrides(profileDir: string): Promise<Record<string, OmpModelOverride>> {
  let raw: string;
  try {
    raw = await readFile(join(profileDir, OVERRIDES_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OMP 模型设置文件损坏；未覆盖原设置");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OMP 模型设置文件损坏；未覆盖原设置");
  const entries = (parsed as { overrides?: unknown }).overrides;
  if (entries === undefined) return {};
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("OMP 模型设置文件损坏；未覆盖原设置");
  const result: Record<string, OmpModelOverride> = {};
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    const normalized = normalizeOverride(value);
    // All-empty entries are dropped instead of kept as noise.
    if (Object.keys(normalized).length > 0) result[validateKey(key)] = normalized;
  }
  return result;
}

export async function writeOmpModelOverride(
  profileDir: string,
  input: OmpModelOverrideInput,
): Promise<Record<string, OmpModelOverride>> {
  const key = validateKey(input?.key);
  const normalized = normalizeOverride(input);
  const current = await readOmpModelOverrides(profileDir);
  if (Object.keys(normalized).length > 0) current[key] = normalized;
  else delete current[key];
  if (Object.keys(current).length > MAX_ENTRIES) throw new Error("OMP 模型设置条目过多");
  await mkdir(profileDir, { recursive: true });
  const path = join(profileDir, OVERRIDES_FILE);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, overrides: current }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return current;
}

/** Models owned by the app are the only ones whose engine metadata can change. */
export function isAppOwnedProvider(provider: string): boolean {
  return typeof provider === "string" && provider.startsWith("pi_custom_");
}
