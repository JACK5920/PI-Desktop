import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const FILE_NAME = "pi-desktop-managed.yml";
const THINKING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const WORKTREE_EXIT_POLICIES = new Set(["keep", "ask", "remove", "force"]);
const HEADER = "# PI Desktop managed OMP profile overlay. Edit from the PI settings UI.\n";

function normalizeThinkingLevel(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
    throw new Error("Unsupported OMP default thinking level");
  }
  return value;
}

function normalizeWorktreeOnExit(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !WORKTREE_EXIT_POLICIES.has(value)) {
    throw new Error("Unsupported OMP worktree exit policy");
  }
  return value;
}

function profileConfigPath(profileDir) {
  return join(profileDir, FILE_NAME);
}

function documentFor(settings) {
  const lines = [HEADER.trimEnd()];
  if (settings.defaultThinkingLevel) lines.push(`defaultThinkingLevel: ${settings.defaultThinkingLevel}`);
  if (settings.worktreeOnExit) lines.push(`worktree:\n  onExit: ${settings.worktreeOnExit}`);
  return `${lines.join("\n")}\n`;
}

function parseOverlay(content) {
  let defaultThinkingLevel = null;
  let worktreeOnExit = null;
  let seenThinkingLevel = false;
  let seenWorktree = false;
  let seenWorktreeOnExit = false;
  let section = null;

  for (const row of content.split(/\r?\n/)) {
    const trimmed = row.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const thinking = /^defaultThinkingLevel:\s*([a-z]+)\s*$/.exec(row);
    if (thinking) {
      if (seenThinkingLevel) throw new Error("The PI-managed OMP profile overlay contains duplicate settings");
      seenThinkingLevel = true;
      section = null;
      defaultThinkingLevel = normalizeThinkingLevel(thinking[1]);
      continue;
    }

    if (/^worktree:\s*$/.test(row)) {
      if (seenWorktree) throw new Error("The PI-managed OMP profile overlay contains duplicate settings");
      seenWorktree = true;
      section = "worktree";
      continue;
    }

    const exitPolicy = /^  onExit:\s*([a-z]+)\s*$/.exec(row);
    if (exitPolicy && section === "worktree") {
      if (seenWorktreeOnExit) throw new Error("The PI-managed OMP profile overlay contains duplicate settings");
      seenWorktreeOnExit = true;
      worktreeOnExit = normalizeWorktreeOnExit(exitPolicy[1]);
      continue;
    }

    throw new Error("The PI-managed OMP profile overlay has an unknown or malformed setting");
  }

  return { defaultThinkingLevel, worktreeOnExit };
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
  return { ...parseOverlay(content), configPath };
}

export async function writeOmpProfileSettings(profileDir, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["defaultThinkingLevel", "worktreeOnExit"].includes(key))) {
    throw new Error("OMP profile settings contain unsupported fields");
  }
  // Never overwrite a file the user may have edited manually into an
  // unsupported shape; report it for review instead of deleting unknown data.
  const current = await readOmpProfileSettings(profileDir);
  const defaultThinkingLevel = Object.hasOwn(input, "defaultThinkingLevel")
    ? normalizeThinkingLevel(input.defaultThinkingLevel)
    : current.defaultThinkingLevel;
  const worktreeOnExit = Object.hasOwn(input, "worktreeOnExit")
    ? normalizeWorktreeOnExit(input.worktreeOnExit)
    : current.worktreeOnExit;
  const configPath = profileConfigPath(profileDir);
  await atomicWrite(configPath, documentFor({ defaultThinkingLevel, worktreeOnExit }));
  return { defaultThinkingLevel, worktreeOnExit, configPath };
}

export function ompProfileConfigPath(profileDir) {
  return profileConfigPath(profileDir);
}