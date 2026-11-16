import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { release } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");

function runGit(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true }).trimEnd();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function listFilesRecursively(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listFilesRecursively(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function workingTreeFingerprint(repoRoot) {
  const patch = runGit(repoRoot, ["diff", "--binary", "HEAD"]);
  const untracked = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const untrackedRecords = untracked.map((path) => {
    const absolute = resolve(repoRoot, path);
    const info = statSync(absolute);
    const digest = info.isDirectory()
      ? listFilesRecursively(absolute)
          .sort()
          .map((file) => `${relative(repoRoot, file).replaceAll("\\", "/")}\0${sha256(readFileSync(file))}`)
          .join("\n")
      : sha256(readFileSync(absolute));
    return `${path}\0${digest}`;
  });
  return {
    dirty: runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).length > 0,
    trackedDiffSha256: sha256(Buffer.from(patch, "utf8")),
    untracked: untrackedRecords,
    fingerprintSha256: sha256(Buffer.from(`${patch}\n${untrackedRecords.join("\n")}`, "utf8")),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function optionalJson(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function hostCoreInfo(repoRoot) {
  const candidates = [
    join(repoRoot, "target", "release", "pi-desktop-host-core.exe"),
    join(repoRoot, "target", "debug", "pi-desktop-host-core.exe"),
    join(repoRoot, "target", "release", "pi-desktop-host-core"),
    join(repoRoot, "target", "debug", "pi-desktop-host-core"),
  ];
  const path = candidates.find(existsSync);
  if (!path) return null;
  const bytes = readFileSync(path);
  return { path: relative(repoRoot, path).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256(bytes) };
}

/** Capture reproducibility metadata and hashes for a stress run. */
export function captureStressTestEvidence({ repoRoot = REPO_ROOT, artifactPaths = [], capturedAt = new Date() } = {}) {
  const root = resolve(repoRoot);
  const appPackage = readJson(join(root, "apps", "desktop", "package.json"));
  const electronPackage = optionalJson(join(root, "apps", "desktop", "node_modules", "electron", "package.json"));
  const artifacts = artifactPaths.map((item) => {
    const path = isAbsolute(item) ? resolve(item) : resolve(root, item);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`evidence artifact is missing or not a file: ${item}`);
    const bytes = readFileSync(path);
    return {
      path: isAbsolute(item) ? path : relative(root, path).replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const workingTree = workingTreeFingerprint(root);
  return {
    format: "pi-stress-test-evidence-v1",
    capturedAt: capturedAt.toISOString(),
    source: {
      repoRoot: root,
      gitBranch: runGit(root, ["branch", "--show-current"]),
      gitCommit: runGit(root, ["rev-parse", "HEAD"]),
      workingTree,
    },
    build: {
      appVersion: appPackage.version,
      electronVersion: electronPackage?.version ?? null,
      electronDependencyRange: appPackage.devDependencies?.electron ?? appPackage.dependencies?.electron ?? null,
      hostCore: hostCoreInfo(root),
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      osRelease: release(),
    },
    artifacts,
    note: "Include raw logs/CSV as --artifact inputs. A dirty-tree fingerprint identifies local state but does not replace a commit or source archive.",
  };
}

export function writeStressTestEvidence(outputPath, options = {}) {
  const output = isAbsolute(outputPath) ? outputPath : resolve(options.repoRoot ?? REPO_ROOT, outputPath);
  const document = captureStressTestEvidence(options);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { output, document };
}

function parseArgs(argv) {
  let output;
  const artifacts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") output = argv[++index];
    else if (arg === "--artifact") artifacts.push(argv[++index]);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/stress-test-evidence.mjs --out <manifest.json> [--artifact <raw-log-or-csv>]...");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!output) throw new Error("--out is required");
  return { output, artifacts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { output, document } = writeStressTestEvidence(args.output, { artifactPaths: args.artifacts });
    console.log(JSON.stringify({ output, gitCommit: document.source.gitCommit, sourceFingerprint: document.source.workingTree.fingerprintSha256, artifacts: document.artifacts.length }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
