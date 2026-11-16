import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const VISIBILITY_FILE = "pi-visible-models.json";

export function ompModelVisibilityKey(provider: string, modelId: string): string {
  return `${encodeURIComponent(provider)}::${encodeURIComponent(modelId)}`;
}

function validKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20_000 || value.some((key) => typeof key !== "string" || key.length === 0 || key.length > 800)) {
    throw new Error("OMP 模型显示列表无效");
  }
  return [...new Set(value as string[])].sort();
}

export async function readOmpHiddenModels(profileDir: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(profileDir, VISIBILITY_FILE), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid shape");
    return validKeys((parsed as { hiddenModels?: unknown }).hiddenModels ?? []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("OMP 模型显示设置损坏；未覆盖原设置");
  }
}

export async function writeOmpHiddenModels(profileDir: string, hiddenModels: unknown): Promise<string[]> {
  const normalized = validKeys(hiddenModels);
  await mkdir(profileDir, { recursive: true });
  const path = join(profileDir, VISIBILITY_FILE);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ hiddenModels: normalized }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return normalized;
}
