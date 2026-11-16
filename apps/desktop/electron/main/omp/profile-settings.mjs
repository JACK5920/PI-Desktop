import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const FILE_NAME = "pi-desktop-managed.yml";
const THINKING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const HEADER = "# PI Desktop managed OMP profile overlay. Edit from the PI settings UI.\n";

function normalizeThinkingLevel(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
    throw new Error("Unsupported OMP default thinking level");
  }
  return value;
}

function profileConfigPath(profileDir) {
  return join(profileDir, FILE_NAME);
}

function documentFor(value) {
  const level = normalizeThinkingLevel(value);
  return HEADER + (level ? `defaultThinkingLevel: ${level}\n` : "");
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readOmpProfileSettings(profileDir) {
  await mkdir(profileDir, { recursive: true });
  const configPath = profileConfigPath(profileDir);
  let content;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    content = HEADER;
    await atomicWrite(configPath, content);
  }
  const rows = content.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  let defaultThinkingLevel = null;
  for (const row of rows) {
    const match = /^defaultThinkingLevel:\s*([a-z]+)\s*$/.exec(row);
    if (!match) throw new Error("The PI-managed OMP profile overlay has an unknown or malformed setting");
    if (defaultThinkingLevel !== null) throw new Error("The PI-managed OMP profile overlay contains duplicate settings");
    defaultThinkingLevel = normalizeThinkingLevel(match[1]);
  }
  return { defaultThinkingLevel, configPath };
}

export async function writeOmpProfileSettings(profileDir, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "defaultThinkingLevel")) {
    throw new Error("OMP profile settings contain unsupported fields");
  }
  const defaultThinkingLevel = normalizeThinkingLevel(input.defaultThinkingLevel);
  // Never overwrite a file the user may have edited manually into an
  // unsupported shape; report it for review instead of deleting unknown data.
  await readOmpProfileSettings(profileDir);
  await mkdir(profileDir, { recursive: true });
  const configPath = profileConfigPath(profileDir);
  await atomicWrite(configPath, documentFor(defaultThinkingLevel));
  return { defaultThinkingLevel, configPath };
}

export function ompProfileConfigPath(profileDir) {
  return profileConfigPath(profileDir);
}
