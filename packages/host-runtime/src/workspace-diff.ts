import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type {
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  WorkspaceDiff,
  WorkspaceDiffBaseOption,
  WorkspaceDiffRequestOptions,
} from "@pi-desktop/shared";

/**
 * Working-tree diff collection for Branch Review and legacy diagnostics.
 *
 * Everything textual is parsed by the pure functions below so they stay
 * unit-testable without a git checkout; only `collectWorkspaceDiff` talks
 * to the git CLI.
 */

export const MAX_DIFF_FILES = 100;
export const MAX_PATCH_BYTES = 200 * 1024;

export type WorkspaceDiffOptions = WorkspaceDiffRequestOptions;

type RunResult = { code: number; stdout: string; stderr: string };

const NULL_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

const REDIRECT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;

function runGit(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
    };
    for (const name of REDIRECT_ENV) delete env[name];

    const child = spawn(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${NULL_HOOKS_PATH}`,
        ...args,
      ],
      { cwd, env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) =>
      resolve({ code: 1, stdout: "", stderr: String(err) }),
    );
  });
}

export type StatusEntry = {
  path: string;
  /** Previous path for renames/copies. */
  oldPath?: string;
  untracked: boolean;
};

/**
 * Parse `git status --porcelain=v1 -z` output. Rename entries consume the
 * following NUL record (new path first, then original).
 */
export function parseStatusZ(raw: string): StatusEntry[] {
  const records = raw.split("\0").filter((r) => r.length > 0);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    if (xy === "!!") continue;
    if (xy.includes("R") || xy.includes("C")) {
      const oldPath = records[i + 1];
      i += 1;
      entries.push({ path, oldPath, untracked: false });
    } else {
      entries.push({ path, untracked: xy === "??" });
    }
  }
  return entries;
}

/** Split one `git diff` stream into per-file patch chunks. */
export function splitUnifiedDiff(raw: string): string[] {
  if (!raw.trim()) return [];
  const chunks: string[] = [];
  const lines = raw.split("\n");
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) chunks.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) chunks.push(current.join("\n"));
  return chunks;
}

/** Strip the a/ or b/ prefix git adds to diff header paths. */
function stripPathPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

function unquoteGitPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}

/**
 * Parse a single-file unified diff chunk into a DiffFile. `statusHint`
 * overrides the derived status (used to mark untracked files, which are
 * diffed via --no-index and would otherwise read as "added").
 */
export function parseFilePatch(
  chunk: string,
  statusHint?: DiffFileStatus,
): DiffFile | null {
  const lines = chunk.split("\n");
  if (!lines[0]?.startsWith("diff --git ")) return null;

  let path = "";
  let oldPath: string | undefined;
  let status: DiffFileStatus = statusHint ?? "modified";
  let binary = false;
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      const p = unquoteGitPath(line.slice(4).trim());
      if (p !== "/dev/null") oldPath = stripPathPrefix(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = unquoteGitPath(line.slice(4).trim());
      if (p !== "/dev/null") path = stripPathPrefix(p);
      continue;
    }
    if (line.startsWith("new file mode")) {
      if (!statusHint) status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      oldPath = unquoteGitPath(line.slice("rename from ".length).trim());
      status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      path = unquoteGitPath(line.slice("rename to ".length).trim());
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      additions += 1;
      current.lines.push({ type: "add", text: line.slice(1), newLine } satisfies DiffLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      current.lines.push({ type: "del", text: line.slice(1), oldLine } satisfies DiffLine);
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      current.lines.push({
        type: "context",
        text: line.slice(1),
        oldLine,
        newLine,
      } satisfies DiffLine);
      oldLine += 1;
      newLine += 1;
    }
    // "\ No newline at end of file" markers are dropped.
  }

  if (!path && oldPath) path = oldPath; // deletions have no +++ path
  if (!path) {
    // Binary patches carry no ---/+++ lines; recover the path from the
    // `diff --git a/<p> b/<p>` header (quoted paths included).
    const header = lines[0].slice("diff --git ".length).trim();
    const quoted = header.match(/"((?:[^"\\]|\\.)*)"\s*$/);
    const bPath = quoted
      ? unquoteGitPath(`"${quoted[1]}"`)
      : header.split(" b/").pop() ?? "";
    path = stripPathPrefix(bPath);
  }
  if (!path) return null;

  const tooLarge = chunk.length > MAX_PATCH_BYTES;
  return {
    path,
    oldPath: status === "renamed" ? oldPath : undefined,
    status,
    additions,
    deletions,
    binary: binary || undefined,
    tooLarge: tooLarge || undefined,
    hunks: binary || tooLarge ? [] : hunks,
  };
}

function branchName(ref: string): string {
  return ref.startsWith("refs/remotes/")
    ? ref.slice("refs/remotes/".length)
    : ref.startsWith("refs/heads/")
      ? ref.slice("refs/heads/".length)
      : ref;
}

function orderBaseOptions(
  options: WorkspaceDiffBaseOption[],
  currentRef: string | null,
): WorkspaceDiffBaseOption[] {
  const score = (option: WorkspaceDiffBaseOption) =>
    option.ref === currentRef ? 0
      : option.ref === "refs/remotes/origin/main" ? 1
        : option.ref === "refs/heads/main" ? 2
          : 3;
  return [...options].sort((left, right) =>
    score(left) - score(right) || left.name.localeCompare(right.name),
  );
}

function defaultBase(options: WorkspaceDiffBaseOption[]): WorkspaceDiffBaseOption | undefined {
  return options.find((option) => option.ref === "refs/remotes/origin/main")
    ?? options.find((option) => option.ref === "refs/heads/main")
    ?? options[0];
}

async function collectBranchWorkspaceDiff(
  cwd: string,
  options: WorkspaceDiffOptions,
): Promise<WorkspaceDiff> {
  const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (probe.code !== 0 || probe.stdout.trim() !== "true") {
    return { repo: false, clean: true, files: [] };
  }

  const [headResult, branchResult, refsResult, status] = await Promise.all([
    runGit(cwd, ["rev-parse", "--verify", "HEAD"]),
    runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(cwd, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads", "refs/remotes"]),
    runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  if (status.code !== 0) return { repo: false, clean: true, files: [] };

  const headCommit = headResult.code === 0 ? headResult.stdout.trim() : "";
  const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : "detached";
  const currentRef = branchResult.code === 0
    ? `refs/heads/${branchResult.stdout.trim()}`
    : null;
  const refs = refsResult.stdout.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("\t");
    if (separator <= 0) return [];
    const ref = line.slice(0, separator);
    const commit = line.slice(separator + 1).trim();
    if (!headCommit && !commit) return [];
    if (ref.endsWith("/HEAD")) return [];
    return [{ ref, name: branchName(ref), commit }];
  });
  const baseOptions = orderBaseOptions(refs, currentRef);
  const requestedBase = options.baseRef
    ? baseOptions.find((option) => option.ref === options.baseRef)
    : defaultBase(baseOptions);
  const baseFields = {
    currentBranch,
    ...(options.includeBases ? { baseOptions } : {}),
  };
  if (!headCommit) {
    return {
      repo: true,
      clean: true,
      files: [],
      ...baseFields,
      baseError: "no_head",
    };
  }
  if (options.baseRef && !requestedBase) {
    return {
      repo: true,
      clean: true,
      files: [],
      ...baseFields,
      baseError: "invalid_base",
    };
  }
  if (!requestedBase) {
    return { repo: true, clean: true, files: [], ...baseFields };
  }

  const mergeBase = await runGit(cwd, ["merge-base", requestedBase.commit, headCommit]);
  if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) {
    return {
      repo: true,
      clean: true,
      files: [],
      ...baseFields,
      baseError: "no_merge_base",
    };
  }
  const mergeBaseCommit = mergeBase.stdout.trim();
  const entries = parseStatusZ(status.stdout);
  const untrackedEntries = entries.filter((entry) => entry.untracked);
  const truncated = untrackedEntries.length > MAX_DIFF_FILES;
  const untracked = new Set(untrackedEntries.map((entry) => entry.path));
  const tracked = await runGit(cwd, [
    "diff",
    mergeBaseCommit,
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--unified=3",
  ]);
  const trackedChunks = splitUnifiedDiff(tracked.stdout);
  const files: DiffFile[] = [];
  const anchor = (file: DiffFile, patch: string) => {
    file.anchorRevision = createHash("sha256")
      .update(JSON.stringify([
        requestedBase.ref,
        requestedBase.commit,
        mergeBaseCommit,
        headCommit,
        file.path,
        patch,
      ]))
      .digest("hex");
    return file;
  };
  if (tracked.code === 0 || tracked.stdout) {
    for (const chunk of trackedChunks) {
      const file = parseFilePatch(chunk);
      if (file && !untracked.has(file.path)) files.push(anchor(file, chunk));
    }
  }

  for (const entry of untrackedEntries.slice(0, MAX_DIFF_FILES)) {
    const result = await runGit(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      "--no-index",
      "--",
      "/dev/null",
      entry.path,
    ]);
    const chunk = splitUnifiedDiff(result.stdout)[0];
    const file = chunk ? parseFilePatch(chunk, "untracked") : null;
    if (file) {
      files.push(anchor(file, chunk));
    } else {
      files.push(anchor({
        path: entry.path,
        status: "untracked",
        additions: 0,
        deletions: 0,
        hunks: [],
      }, `${entry.path}\0unreadable`));
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const wasTruncated = truncated || files.length > MAX_DIFF_FILES;
  return {
    repo: true,
    clean: files.length === 0,
    files: files.slice(0, MAX_DIFF_FILES),
    truncated: wasTruncated || undefined,
    ...baseFields,
    branchReview: {
      baseRef: requestedBase.ref,
      baseCommit: requestedBase.commit,
      mergeBaseCommit,
      headCommit,
    },
  };
}

export async function collectWorkspaceDiff(
  cwd: string,
  options: WorkspaceDiffOptions = {},
): Promise<WorkspaceDiff> {
  if (options.baseRef !== undefined || options.includeBases) {
    return collectBranchWorkspaceDiff(cwd, options);
  }
  const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (probe.code !== 0 || probe.stdout.trim() !== "true") {
    return { repo: false, clean: true, files: [] };
  }

  const status = await runGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.code !== 0) {
    return { repo: false, clean: true, files: [] };
  }
  const entries = parseStatusZ(status.stdout);
  if (entries.length === 0) {
    return { repo: true, clean: true, files: [] };
  }

  const truncated = entries.length > MAX_DIFF_FILES;
  const scoped = entries.slice(0, MAX_DIFF_FILES);
  const untrackedPaths = new Set(
    scoped.filter((e) => e.untracked).map((e) => e.path),
  );

  const files: DiffFile[] = [];

  // Tracked changes: one spawn covers staged + unstaged vs HEAD. A repo
  // without any commit yet has no HEAD; fall back to the empty tree so
  // freshly-initialized repos still diff.
  const head = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  const base =
    head.code === 0 ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const tracked = await runGit(cwd, [
    "diff",
    base,
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--unified=3",
  ]);
  if (tracked.code === 0 || tracked.stdout) {
    for (const chunk of splitUnifiedDiff(tracked.stdout)) {
      const file = parseFilePatch(chunk);
      if (file && !untrackedPaths.has(file.path)) files.push(file);
    }
  }

  // Untracked files: --no-index against /dev/null; exit code 1 means "differs".
  for (const entry of scoped) {
    if (!entry.untracked) continue;
    const res = await runGit(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      "--no-index",
      "--",
      "/dev/null",
      entry.path,
    ]);
    const chunk = splitUnifiedDiff(res.stdout)[0];
    const file = chunk ? parseFilePatch(chunk, "untracked") : null;
    if (file) {
      files.push(file);
    } else {
      // Unreadable or empty new file — still list it.
      files.push({
        path: entry.path,
        status: "untracked",
        additions: 0,
        deletions: 0,
        hunks: [],
      });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    repo: true,
    clean: files.length === 0,
    files,
    truncated: truncated || undefined,
  };
}
