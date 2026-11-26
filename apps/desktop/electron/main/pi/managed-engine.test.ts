import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiManagedEngine, type PiEnginePlatform, type PiRuntimeManifest } from "./managed-engine";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const PI_PACKAGES = {
  "@earendil-works/pi-agent-core": "1.5.2",
  "@earendil-works/pi-ai": "1.5.2",
  "@earendil-works/pi-coding-agent": "1.5.2",
} as const;
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

async function createRuntime(directory: string, desktopVersion: string, protocolVersion = 11) {
  await mkdir(join(directory, "chunks"), { recursive: true });
  const fileContents = new Map<string, Uint8Array>([
    ["sidecar.js", Buffer.from("process.stdout.write('pi-sidecar-smoke')")],
    ["package.json", Buffer.from('{"type":"module"}\n')],
    ["chunks/runtime.js", Buffer.from("export const runtime = true;\n")],
  ]);
  for (const [path, bytes] of fileContents) await writeFile(join(directory, path), bytes);
  const manifest: PiRuntimeManifest = {
    schemaVersion: 1,
    engine: "pi",
    desktopVersion,
    agentRuntimeVersion: "0.21.0",
    protocolVersion,
    piPackages: PI_PACKAGES,
    piPatchHashes: {
      "@earendil-works/pi-agent-core": "a".repeat(64),
      "@earendil-works/pi-ai": "b".repeat(64),
      "@earendil-works/pi-coding-agent": "c".repeat(64),
    },
    files: [...fileContents].map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: hash(bytes) })),
  };
  await writeFile(join(directory, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function createFixture(options: { latestDesktopVersion?: string; protocolVersion?: number; corruptArchive?: boolean; blockArchive?: boolean } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), `pi-engine-${randomUUID()}-`));
  roots.push(rootDir);
  const bundledDir = join(rootDir, "bundled");
  await createRuntime(bundledDir, "0.21.0");
  const buildDir = join(rootDir, "release-bundle");
  const remoteManifest = await createRuntime(buildDir, options.latestDesktopVersion ?? "0.22.0", options.protocolVersion ?? 11);
  const archivePath = join(rootDir, "remote.tar.gz");
  await execFileAsync("tar", ["-czf", archivePath, "-C", buildDir, "sidecar.js", "package.json", "runtime-manifest.json", "chunks"]);
  let archiveBytes = new Uint8Array(await readFile(archivePath));
  if (options.corruptArchive) archiveBytes = Uint8Array.from([...archiveBytes, 0x01]);
  const platform: PiEnginePlatform = "windows-x64";
  const archiveName = `pi-engine-runtime-${platform}.tar.gz`;
  const releaseTag = `v${remoteManifest.desktopVersion}`;
  const releaseManifest = {
    ...remoteManifest,
    releaseTag,
    archiveName,
    archiveSha256: hash(new Uint8Array(await readFile(archivePath))),
    runtimeManifestSize: (await readFile(join(buildDir, "runtime-manifest.json"))).byteLength,
  };
  const manifestBytes = Buffer.from(JSON.stringify(releaseManifest));
  const assets = [
    { name: `pi-engine-runtime-${platform}.manifest.json`, size: manifestBytes.byteLength, digest: `sha256:${hash(manifestBytes)}`, browser_download_url: `https://github.com/JACK5920/PI-Desktop/releases/download/${releaseTag}/pi-engine-runtime-${platform}.manifest.json` },
    { name: archiveName, size: archiveBytes.byteLength, digest: `sha256:${releaseManifest.archiveSha256}`, browser_download_url: `https://github.com/JACK5920/PI-Desktop/releases/download/${releaseTag}/${archiveName}` },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org")) {
      const encoded = url.split("/").at(-2)?.replace("%40", "@").replace("%2F", "/");
      return new Response(JSON.stringify({ name: encoded, version: "1.5.2" }), { status: 200 });
    }
    if (url.includes("api.github.com/repos/")) {
      return new Response(JSON.stringify({ tag_name: releaseTag, draft: false, prerelease: false, body: "PI runtime improvements", assets }), { status: 200 });
    }
    if (url.endsWith(`pi-engine-runtime-${platform}.manifest.json`)) return new Response(manifestBytes, { status: 200, headers: { "content-length": String(manifestBytes.byteLength) } });
    if (url.endsWith(archiveName) && options.blockArchive) {
      let finish!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(archiveBytes.slice(0, 4)); },
        pull() { return new Promise<void>((resolve) => { finish = resolve; }); },
        cancel() { finish?.(); },
      });
      init?.signal?.addEventListener("abort", () => { void body.cancel().catch(() => undefined); }, { once: true });
      return new Response(body, { status: 200, headers: { "content-length": String(archiveBytes.byteLength) } });
    }
    if (url.endsWith(archiveName)) return new Response(archiveBytes, { status: 200, headers: { "content-length": String(archiveBytes.byteLength) } });
    return new Response("not found", { status: 404 });
  });
  const manager = new PiManagedEngine({
    rootDir: join(rootDir, "managed"),
    bundledRuntimeDir: bundledDir,
    platform,
    protocolVersion: 11,
    fetch: fetchMock as typeof fetch,
    smokeTest: async () => undefined,
  });
  return { manager, rootDir, bundledDir, fetchMock, archiveBytes };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PiManagedEngine", () => {
  it("maps supported desktop platforms and rejects unsupported architectures", () => {
    expect(() => new PiManagedEngine({ rootDir: "x", bundledRuntimeDir: "x", platform: "windows-arm64", protocolVersion: 11 })).not.toThrow();
  });

  it("reports the exact embedded dependency versions and latest compatible release", async () => {
    const { manager } = await createFixture();
    const status = await manager.status();
    expect(status).toMatchObject({
      supported: true,
      runningManifest: { desktopVersion: "0.21.0", piPackages: PI_PACKAGES },
      installedManifest: { desktopVersion: "0.21.0" },
      latestManifest: { desktopVersion: "0.22.0" },
      latestReleaseTag: "v0.22.0",
      latestPackageVersions: PI_PACKAGES,
      updateAvailable: true,
      remoteError: null,
    });
  });

  it("downloads, verifies, smoke-checks, stages and atomically selects a compatible bundle without changing the running version", async () => {
    const { manager, rootDir } = await createFixture();
    const progress: string[] = [];
    const installed = await manager.installOrUpdate((item) => progress.push(item.stage));
    expect(installed).toMatchObject({
      runningManifest: { desktopVersion: "0.21.0" },
      installedManifest: { desktopVersion: "0.22.0" },
      restartRequired: true,
      operation: { state: "completed" },
    });
    expect(progress).toEqual(expect.arrayContaining(["check", "download", "verify", "extract", "smoke", "activate"]));
    const pointer = JSON.parse(await readFile(join(rootDir, "managed/active.json"), "utf8"));
    expect(pointer).toMatchObject({ previousVersion: "bundled" });
    expect(await readFile(join(rootDir, "managed/versions", pointer.version, "sidecar.js"), "utf8")).toContain("pi-sidecar-smoke");
  });

  it("does not activate when the remote archive digest is wrong", async () => {
    const { manager, rootDir } = await createFixture({ corruptArchive: true });
    await expect(manager.installOrUpdate()).rejects.toThrow("SHA-256");
    expect(await manager.status()).toMatchObject({ installedManifest: { desktopVersion: "0.21.0" }, canRollback: false });
    await expect(readFile(join(rootDir, "managed/active.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a bundle compiled for another Host protocol", async () => {
    const { manager } = await createFixture({ protocolVersion: 12 });
    await expect(manager.installOrUpdate()).rejects.toThrow("当前桌面协议不兼容");
    expect(await manager.status()).toMatchObject({ updateAvailable: false, installedManifest: { desktopVersion: "0.21.0" } });
  });

  it("can cancel a streamed download before activation and remove staging files", async () => {
    const { manager, rootDir } = await createFixture({ blockArchive: true });
    let signal!: () => void;
    const downloadStarted = new Promise<void>((resolve) => { signal = resolve; });
    const install = manager.installOrUpdate((item) => { if (item.stage === "download") signal(); });
    await downloadStarted;
    const cancellation = await manager.cancelOperation();
    await expect(install).rejects.toMatchObject({ name: "AbortError" });
    expect(cancellation).toMatchObject({ cancelled: true, operation: { state: "cancelled" } });
    expect(await manager.status()).toMatchObject({ installedManifest: { desktopVersion: "0.21.0" }, canRollback: false });
    await expect(readFile(join(rootDir, "managed/active.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back to the bundled runtime without deleting either version", async () => {
    const { manager, rootDir } = await createFixture();
    await manager.installOrUpdate();
    const active = JSON.parse(await readFile(join(rootDir, "managed/active.json"), "utf8"));
    const rolledBack = await manager.rollback();
    expect(rolledBack).toMatchObject({ installedManifest: { desktopVersion: "0.21.0" }, canRollback: true });
    expect(JSON.parse(await readFile(join(rootDir, "managed/active.json"), "utf8"))).toMatchObject({ version: "bundled", previousVersion: active.version });
    expect(await readFile(join(rootDir, "managed/versions", active.version, "sidecar.js"), "utf8")).toContain("pi-sidecar-smoke");
  });
});
