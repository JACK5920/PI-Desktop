#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const platform = option("--platform", "");
const arch = option("--arch", "");
const releaseTag = option("--release-tag", "");
const outDir = resolve(option("--out", join(root, "apps/desktop/release")));
if (!["windows", "macos", "linux"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error("Usage: package-pi-engine-runtime.mjs --platform windows|macos|linux --arch x64|arm64 --release-tag vX.Y.Z [--out DIR]");
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseTag)) throw new Error("A stable semantic release tag is required");

const target = `${platform === "macos" ? "darwin" : platform}-${arch}`;
const bundleDir = join(root, "packages/agent-runtime/dist-bundle");
const runtimeManifestBytes = await readFile(join(bundleDir, "runtime-manifest.json"));
const runtimeManifest = JSON.parse(runtimeManifestBytes.toString("utf8"));
if (runtimeManifest.engine !== "pi" || runtimeManifest.schemaVersion !== 1 || runtimeManifest.desktopVersion !== releaseTag.slice(1)) {
  throw new Error("The PI runtime bundle is missing a valid manifest or its desktop version does not match the release tag");
}

await mkdir(outDir, { recursive: true });
const stem = `pi-engine-runtime-${target}`;
const archiveName = `${stem}.tar.gz`;
const archivePath = join(outDir, archiveName);
// Use a relative archive name from the destination directory. Git Bash's GNU
// tar treats a Windows drive-letter path in the archive operand (for example
// D:\\a\\...) as a remote host specifier and fails with "Cannot connect to D:".
await execFileAsync("tar", ["-czf", archiveName, "-C", bundleDir, "sidecar.js", "package.json", "runtime-manifest.json", "chunks"], { cwd: outDir, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
const hash = createHash("sha256");
for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
const archiveSha256 = hash.digest("hex");
const manifest = {
  ...runtimeManifest,
  releaseTag,
  archiveName,
  archiveSha256,
  runtimeManifestSize: runtimeManifestBytes.byteLength,
};
await writeFile(join(outDir, `${stem}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(outDir, `${archiveName}.sha256`), `${archiveSha256}  ${archiveName}\n`);
process.stdout.write(`Packaged ${target} PI runtime ${releaseTag}: ${archivePath}\nSHA-256 ${archiveSha256}\n`);
