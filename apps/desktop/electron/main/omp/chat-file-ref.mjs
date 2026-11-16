import { basename, sep } from "node:path";
import { stat } from "node:fs/promises";
import { parseChatRef } from "@pi-desktop/host-runtime";
import { resolveRealOpenablePath } from "@pi-desktop/host-runtime";

/**
 * Resolve an OMP-relative file from its verified native cwd when a conversation
 * has no project binding. This is deliberately exact-only: no home-directory
 * walk, basename guessing, or caller-supplied root is allowed.
 */
export async function resolveOmpCwdFileRef(ref, cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  const parsed = parseChatRef(ref);
  if (!parsed || parsed.absolute) return null;
  const relativePath = parsed.segments.join(sep);
  const absolutePath = await resolveRealOpenablePath(relativePath, cwd, []);
  if (!absolutePath) return null;
  try {
    if (!(await stat(absolutePath)).isFile()) return null;
  } catch {
    return null;
  }
  return {
    root: "scratch",
    relativePath: basename(absolutePath),
    absolutePath,
    matchedBy: "exact-relative",
  };
}
