import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectWorkspaceDiff } from "./workspace-diff.js";

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}

async function createRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await runGit(root, ["init", "--quiet", "--initial-branch=main"]);
  await runGit(root, ["config", "user.name", "Workspace diff test"]);
  await runGit(root, ["config", "user.email", "workspace-diff@example.invalid"]);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("collectWorkspaceDiff", () => {
  it("compares a selected branch base through committed and working-tree changes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-workspace-branch-review-"));
    tempDirs.push(tempRoot);
    const root = join(tempRoot, "repo");
    await createRepo(root);
    await writeFile(join(root, "src.ts"), "before\nold\nafter\n", "utf8");
    await runGit(root, ["add", "src.ts"]);
    await runGit(root, ["commit", "--quiet", "-m", "base"]);
    const baseCommit = (await execFile("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })).stdout.trim();

    await runGit(root, ["switch", "--quiet", "-c", "feature"]);
    await writeFile(join(root, "src.ts"), "before\ncommitted\nafter\n", "utf8");
    await runGit(root, ["add", "src.ts"]);
    await runGit(root, ["commit", "--quiet", "-m", "branch change"]);
    await writeFile(join(root, "src.ts"), "before\ncommitted\nafter\nworking\n", "utf8");
    await writeFile(join(root, "notes.md"), "new worktree file\n", "utf8");

    const diff = await collectWorkspaceDiff(root, {
      baseRef: "refs/heads/main",
      includeBases: true,
    });

    expect(diff.repo).toBe(true);
    expect(diff.currentBranch).toBe("feature");
    expect(diff.baseOptions).toEqual([
      { ref: "refs/heads/feature", name: "feature", commit: expect.any(String) },
      { ref: "refs/heads/main", name: "main", commit: baseCommit },
    ]);
    expect(diff.branchReview).toMatchObject({
      baseRef: "refs/heads/main",
      baseCommit,
      mergeBaseCommit: baseCommit,
      headCommit: expect.any(String),
    });
    const source = diff.files.find((file) => file.path === "src.ts");
    expect(source).toBeDefined();
    expect(source?.anchorRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(source?.hunks.flatMap((hunk) => hunk.lines).map((line) => [line.type, line.oldLine, line.newLine]))
      .toEqual([
        ["context", 1, 1],
        ["del", 2, undefined],
        ["add", undefined, 2],
        ["context", 3, 3],
        ["add", undefined, 4],
      ]);
    expect(diff.files.map((file) => file.path)).toEqual(["notes.md", "src.ts"]);
    expect(diff.files.find((file) => file.path === "notes.md")?.hunks[0]?.lines[0])
      .toMatchObject({ type: "add", newLine: 1 });

    const stable = await collectWorkspaceDiff(root, { baseRef: "refs/heads/main" });
    expect(stable.files.find((file) => file.path === "src.ts")?.anchorRevision)
      .toBe(source?.anchorRevision);
    await writeFile(join(root, "src.ts"), "before\ncommitted\nafter\nchanged\n", "utf8");
    const stale = await collectWorkspaceDiff(root, { baseRef: "refs/heads/main" });
    expect(stale.files.find((file) => file.path === "src.ts")?.anchorRevision)
      .not.toBe(source?.anchorRevision);
  });

  it("does not expose a diff when the selected base has no merge base", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-workspace-branch-unrelated-"));
    tempDirs.push(tempRoot);
    const root = join(tempRoot, "repo");
    await createRepo(root);
    await writeFile(join(root, "main.txt"), "main\n", "utf8");
    await runGit(root, ["add", "main.txt"]);
    await runGit(root, ["commit", "--quiet", "-m", "main root"]);
    await runGit(root, ["switch", "--quiet", "--orphan", "unrelated"]);
    await writeFile(join(root, "other.txt"), "other\n", "utf8");
    await runGit(root, ["add", "other.txt"]);
    await runGit(root, ["commit", "--quiet", "-m", "unrelated root"]);

    const diff = await collectWorkspaceDiff(root, { baseRef: "refs/heads/main" });

    expect(diff.branchReview).toBeUndefined();
    expect(diff.baseError).toBe("no_merge_base");
    expect(diff.files).toEqual([]);
  });

  it("rejects an unavailable base ref before computing a merge base", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-workspace-branch-review-invalid-base-"));
    tempDirs.push(tempRoot);
    const root = join(tempRoot, "repo");
    await createRepo(root);
    await writeFile(join(root, "tracked.txt"), "content\n", "utf8");
    await runGit(root, ["add", "tracked.txt"]);
    await runGit(root, ["commit", "--quiet", "-m", "initial"]);

    const diff = await collectWorkspaceDiff(root, {
      baseRef: "refs/heads/does-not-exist",
      includeBases: true,
    });

    expect(diff).toMatchObject({
      repo: true,
      baseError: "invalid_base",
      files: [],
      baseOptions: [{ ref: "refs/heads/main", name: "main" }],
    });
    expect(diff.branchReview).toBeUndefined();
  });

  it("does not execute a repository-configured fsmonitor command", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-workspace-diff-fsmonitor-"));
    tempDirs.push(tempRoot);
    const root = join(tempRoot, "repo");
    await mkdir(root);

    await runGit(root, ["init", "--quiet"]);
    await runGit(root, ["config", "user.name", "Workspace diff test"]);
    await runGit(root, ["config", "user.email", "workspace-diff@example.invalid"]);
    await writeFile(join(root, "tracked.txt"), "content\n", "utf8");
    await runGit(root, ["add", "tracked.txt"]);
    await runGit(root, ["commit", "--quiet", "-m", "initial"]);

    const marker = join(tempRoot, "fsmonitor-ran");
    const hook = join(tempRoot, "fsmonitor-hook.cjs");
    await writeFile(
      hook,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
      "utf8",
    );
    const command = `${shellQuote(process.execPath)} ${shellQuote(hook)}`;
    await runGit(root, ["config", "core.fsmonitor", command]);

    // Prove this Git build would execute the configured command without the
    // host runner's overrides, then clear the marker before testing the host.
    // Git may reject the helper's intentionally incomplete response afterward.
    await execFile("git", ["status", "--porcelain=v1", "-z"], {
      cwd: root,
      encoding: "utf8",
    }).catch(() => undefined);
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const diff = await collectWorkspaceDiff(root);

    expect(diff).toMatchObject({ repo: true, clean: true, files: [] });
    expect(existsSync(marker)).toBe(false);

    await runGit(root, ["config", "--unset", "core.fsmonitor"]);
    const injectedConfig = [
      ["GIT_CONFIG_COUNT", process.env.GIT_CONFIG_COUNT],
      ["GIT_CONFIG_KEY_0", process.env.GIT_CONFIG_KEY_0],
      ["GIT_CONFIG_VALUE_0", process.env.GIT_CONFIG_VALUE_0],
    ] as const;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
    process.env.GIT_CONFIG_VALUE_0 = command;
    try {
      const envDiff = await collectWorkspaceDiff(root);
      expect(envDiff).toMatchObject({ repo: true, clean: true, files: [] });
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const [key, value] of injectedConfig) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("does not execute repository-configured textconv commands", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-workspace-diff-textconv-"));
    tempDirs.push(tempRoot);
    const root = join(tempRoot, "repo");
    await mkdir(root);

    await runGit(root, ["init", "--quiet"]);
    await runGit(root, ["config", "user.name", "Workspace diff test"]);
    await runGit(root, ["config", "user.email", "workspace-diff@example.invalid"]);
    await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
    await runGit(root, ["add", "tracked.txt"]);
    await runGit(root, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(
      join(root, ".gitattributes"),
      "tracked.txt diff=probe\nuntracked.txt diff=probe\n",
      "utf8",
    );
    await runGit(root, ["add", ".gitattributes"]);
    await runGit(root, ["commit", "--quiet", "-m", "diff attributes"]);

    const marker = join(tempRoot, "textconv-ran");
    const command = join(tempRoot, "textconv.cjs");
    await writeFile(
      command,
      `const fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(marker)}, "ran\\n");\nprocess.stdout.write(fs.readFileSync(process.argv.at(-1)));\n`,
      "utf8",
    );
    const textconv = `${shellQuote(process.execPath)} ${shellQuote(command)}`;
    await runGit(root, ["config", "diff.probe.textconv", textconv]);
    await writeFile(join(root, "tracked.txt"), "changed\n", "utf8");
    await writeFile(join(root, "untracked.txt"), "new file\n", "utf8");

    // Prove the repository's textconv command is active before exercising the host.
    await execFile("git", ["diff", "--textconv", "--", "tracked.txt"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(existsSync(marker)).toBe(true);
    await rm(marker, { force: true });

    const diff = await collectWorkspaceDiff(root);

    expect(diff.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["tracked.txt", "untracked.txt"]),
    );
    expect(existsSync(marker)).toBe(false);
  });
});
