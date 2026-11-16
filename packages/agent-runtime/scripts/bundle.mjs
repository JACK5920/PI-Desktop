import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDir = join(packageRoot, "dist-bundle");
const repoRoot = join(packageRoot, "../..");

async function collectRuntimeFiles(directory, relative = "") {
  const entries = await readdir(join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`PI runtime bundle must not contain symbolic links: ${path}`);
    if (entry.isDirectory()) files.push(...await collectRuntimeFiles(directory, path));
    else if (entry.isFile() && path !== "runtime-manifest.json") files.push(path);
  }
  return files;
}

async function writeRuntimeManifest(directory) {
  const agent = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const desktop = JSON.parse(await readFile(join(repoRoot, "apps/desktop/package.json"), "utf8"));
  const sharedSource = await readFile(join(repoRoot, "packages/shared/src/protocol.ts"), "utf8");
  const protocolVersion = Number(sharedSource.match(/export const PROTOCOL_VERSION = (\d+)/)?.[1]);
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) throw new Error("Could not determine the PI runtime protocol version");
  const piPackages = {
    "@earendil-works/pi-agent-core": agent.dependencies?.["@earendil-works/pi-agent-core"],
    "@earendil-works/pi-ai": agent.dependencies?.["@earendil-works/pi-ai"],
    "@earendil-works/pi-coding-agent": agent.dependencies?.["@earendil-works/pi-coding-agent"],
  };
  if (Object.values(piPackages).some((version) => typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))) {
    throw new Error("PI runtime package pins are incomplete or invalid");
  }
  const piPatchHashes = {};
  for (const [name, packageName] of [
    ["@earendil-works/pi-agent-core", "pi-agent-core"],
    ["@earendil-works/pi-ai", "pi-ai"],
    ["@earendil-works/pi-coding-agent", "pi-coding-agent"],
  ]) {
    const patchPath = join(repoRoot, "patches", `@earendil-works__${packageName}@${piPackages[name]}.patch`);
    const patchBytes = await readFile(patchPath).catch(() => null);
    if (!patchBytes) throw new Error(`PI runtime compatibility patch is missing: ${packageName}@${piPackages[name]}`);
    piPatchHashes[name] = createHash("sha256").update(patchBytes).digest("hex");
  }
  const files = [];
  for (const path of await collectRuntimeFiles(directory)) {
    const bytes = await readFile(join(directory, path));
    files.push({ path, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = {
    schemaVersion: 1,
    engine: "pi",
    desktopVersion: desktop.version,
    agentRuntimeVersion: agent.version,
    protocolVersion,
    piPackages,
    piPatchHashes,
    files,
  };
  await writeFile(join(directory, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

const resizeWorkerBanner = [
  "import { createRequire as __piCreateRequire } from 'node:module';",
  "import { fileURLToPath as __piFileURLToPath } from 'node:url';",
  "import { dirname as __piDirname } from 'node:path';",
  "const require = __piCreateRequire(import.meta.url);",
  "const __dirname = __piDirname(__piFileURLToPath(import.meta.url));",
].join(" ");
const banner = "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);";

async function bundleImageResizeAssets(directory) {
  const codingAgentEntry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const codingAgentRequire = createRequire(codingAgentEntry);
  const photonEntry = codingAgentRequire.resolve("@silvia-odwyer/photon-node");
  const chunksDirectory = join(directory, "chunks");
  await mkdir(chunksDirectory, { recursive: true });
  await build({
    entryPoints: [join(dirname(codingAgentEntry), "utils/image-resize-worker.js")],
    bundle: true,
    platform: "node",
    format: "esm",
    minify: true,
    outfile: join(chunksDirectory, "image-resize-worker.js"),
    banner: { js: resizeWorkerBanner },
  });
  await copyFile(
    join(dirname(photonEntry), "photon_rs_bg.wasm"),
    join(chunksDirectory, "photon_rs_bg.wasm"),
  );
}

export async function writeBundlePackageManifest(directory) {
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  );
}

export async function bundleAgentRuntime(outputDir = join(packageRoot, "dist-bundle")) {
  await mkdir(dirname(outputDir), { recursive: true });
  const stagingDir = await mkdtemp(join(dirname(outputDir), ".dist-bundle-stage-"));
  const backupDir = join(dirname(outputDir), `.dist-bundle-backup-${randomUUID()}`);
  let previousOutputMoved = false;

  try {
    await build({
      entryPoints: [join(packageRoot, "src/sidecar.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      minify: true,
      splitting: true,
      outdir: stagingDir,
      entryNames: "sidecar",
      chunkNames: "chunks/[name]-[hash]",
      define: { PI_BUNDLED_NODE: "true" },
      banner: { js: banner },
    });

    await bundleImageResizeAssets(stagingDir);
    await writeBundlePackageManifest(stagingDir);
    await writeRuntimeManifest(stagingDir);

    try {
      await rename(outputDir, backupDir);
      previousOutputMoved = true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        // A first build has no previous output to preserve.
      } else {
        throw error;
      }
    }

    try {
      await rename(stagingDir, outputDir);
    } catch (error) {
      if (previousOutputMoved) {
        try {
          await rename(backupDir, outputDir);
          previousOutputMoved = false;
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Could not install the new sidecar bundle or restore the previous bundle",
          );
        }
      }
      throw error;
    }

    if (previousOutputMoved) {
      await rm(backupDir, { recursive: true });
      previousOutputMoved = false;
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    if (!previousOutputMoved) await rm(backupDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestIndex = process.argv.indexOf("--manifest");
  if (manifestIndex >= 0) {
    const target = resolve(process.argv[manifestIndex + 1] ?? "dist");
    await mkdir(target, { recursive: true });
    await writeBundlePackageManifest(target);
    await writeRuntimeManifest(target);
  } else {
    await bundleAgentRuntime();
  }
}
