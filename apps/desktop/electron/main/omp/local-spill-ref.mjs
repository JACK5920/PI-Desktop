import { lstat, open, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { win32 } from "node:path";

const WINDOWS_LOCAL_ROOT_MAX_CHARS = 180;
const MAX_SESSION_HEADER_BYTES = 16 * 1024;
const SPILL_SELECTOR = String.raw`(?::(?:raw:)?(?:\d+(?:-\d*)?|-\d+)(?:,:?(?:\d+(?:-\d*)?|-\d+))*)?`;
const SPILL_REF_RE = new RegExp(
  String.raw`^(?:local:\/\/(\d+)\.log|artifact:\/\/(\d+)(?:\.log)?)${SPILL_SELECTOR}$`,
  "i",
);

export function hasOmpLocalSpillScheme(value) {
  return typeof value === "string" && /^(?:local|artifact):\/\//i.test(value.trim());
}

/** Parse OMP 19 spill URLs and the legacy numeric artifact:// alias. */
export function parseOmpLocalSpillRef(value) {
  if (typeof value !== "string" || value.length > 256) return null;
  const match = SPILL_REF_RE.exec(value.trim());
  if (!match) return null;
  const id = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

function safeSessionId(value) {
  const safe = String(value ?? "session").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return safe && safe !== "." && safe !== ".." ? safe : "session";
}

/** Match OMP's path selection, including its long-Windows-path fallback. */
export function getOmpLocalRootPath({
  sessionFile,
  nativeSessionId,
  platform = process.platform,
  tempDirectory = tmpdir(),
}) {
  if (typeof sessionFile !== "string" || !sessionFile.toLowerCase().endsWith(".jsonl")) return null;
  const pathApi = platform === "win32" ? win32 : path;
  const artifactDirectory = sessionFile.slice(0, -".jsonl".length);
  const candidate = pathApi.resolve(artifactDirectory, "local");
  if (platform !== "win32" || candidate.length < WINDOWS_LOCAL_ROOT_MAX_CHARS) return candidate;
  if (typeof nativeSessionId !== "string" || !nativeSessionId.trim()) return null;
  return pathApi.join(tempDirectory, "omp-local", safeSessionId(nativeSessionId));
}

/** Read only the small first JSONL header; native transcripts may be very large. */
export async function readOmpNativeSessionId(sessionFile) {
  let handle;
  try {
    handle = await open(sessionFile, "r");
    const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(0x0a, 0);
    if (newline < 0 && bytesRead === buffer.length) return null;
    const line = buffer.subarray(0, newline < 0 ? bytesRead : newline).toString("utf8").trim();
    const header = JSON.parse(line);
    return header && typeof header.id === "string" && header.id.trim() ? header.id : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Return the canonical, existing, non-symlink local root for one OMP session. */
export async function resolveOmpLocalSpillRoot({ sessionFile, nativeSessionId }) {
  const requested = getOmpLocalRootPath({ sessionFile, nativeSessionId });
  if (!requested) return null;
  try {
    const rootStat = await lstat(requested);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const canonicalRoot = await realpath(requested);
    if (process.platform === "win32" && requested.includes(`${path.sep}omp-local${path.sep}`)) {
      const canonicalTemp = await realpath(tmpdir());
      if (canonicalRoot !== canonicalTemp && !isInside(canonicalTemp, canonicalRoot)) return null;
    }
    return canonicalRoot;
  } catch {
    return null;
  }
}

/** Resolve one numeric spill without following a file or root symlink. */
export async function resolveOmpLocalSpillFile({ sessionFile, nativeSessionId, ref }) {
  const id = parseOmpLocalSpillRef(ref);
  if (id === null) return null;
  const root = await resolveOmpLocalSpillRoot({ sessionFile, nativeSessionId });
  if (!root) return null;
  const requested = path.join(root, `${id}.log`);
  try {
    const entryStat = await lstat(requested);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) return null;
    const absolutePath = await realpath(requested);
    if (!isInside(root, absolutePath) || !(await stat(absolutePath)).isFile()) return null;
    return { root, absolutePath, relativePath: path.basename(absolutePath), id };
  } catch {
    return null;
  }
}
