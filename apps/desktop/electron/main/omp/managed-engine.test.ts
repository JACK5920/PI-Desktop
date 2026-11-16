import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOmpManagedEngine, currentOmpPlatform, OmpManagedEngine, type OmpPlatform } from "./managed-engine";

const tempRoots: string[] = [];
const persistentInstallRoot = process.env.PI_OMP_INSTALL_ROOT;

async function makeManager(options: { version?: string; binary?: Uint8Array; platform?: OmpPlatform } = {}) {
  const version = options.version ?? "18.20.0";
  const binary = options.binary ?? new TextEncoder().encode(`omp-${version}`);
  const license = new TextEncoder().encode("MIT license");
  const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const assets = [
    { name: "omp-windows-x64.exe", size: binary.byteLength, digest: digest(binary), browser_download_url: `https://github.com/can1357/oh-my-pi/releases/download/v${version}/omp-windows-x64.exe` },
    { name: "LICENSE", size: license.byteLength, digest: digest(license), browser_download_url: `https://github.com/can1357/oh-my-pi/releases/download/v${version}/LICENSE` },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/releases/latest")) return new Response(JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false, assets }), { status: 200 });
    const body = url.endsWith("LICENSE") ? license : binary;
    return new Response(Buffer.from(body), { status: 200, headers: { "content-length": String(body.byteLength) } });
  });
  const rootDir = await mkdtemp(join(tmpdir(), `omp-test-${randomUUID()}-`));
  tempRoots.push(rootDir);
  const manager = new OmpManagedEngine({
    rootDir,
    platform: options.platform ?? "windows-x64",
    fetch: fetchMock as typeof fetch,
    runVersionCheck: async () => version,
  });
  return { manager, rootDir, fetchMock, assets, binary };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("OmpManagedEngine", () => {
  it("creates and returns only the managed binary versions directory", async () => {
    const { manager, rootDir } = await makeManager();
    const directory = await manager.ensureVersionsDirectory();
    expect(directory).toBe(join(rootDir, "versions"));
    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(await readdir(rootDir)).toEqual(["versions"]);
  });

  it("maps supported OS/architectures to upstream assets and rejects unknown targets", () => {
    expect(currentOmpPlatform("win32", "x64")).toBe("windows-x64");
    expect(currentOmpPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentOmpPlatform("linux", "x64")).toBe("linux-x64");
    expect(() => currentOmpPlatform("freebsd", "x64")).toThrow("暂不支持 OMP");
  });

  it("keeps local import and rollback status available when GitHub is offline", async () => {
    const { rootDir } = await makeManager();
    const offline = new OmpManagedEngine({
      rootDir,
      platform: "windows-x64",
      fetch: (async () => { throw new TypeError("network offline"); }) as typeof fetch,
    });
    await expect(offline.status()).resolves.toMatchObject({
      installedVersion: null, latestVersion: null, canRollback: false,
    });
  });

  it("installs official assets only after checksum validation and returns the managed executable", async () => {
    const { manager, rootDir, binary } = await makeManager();
    const progress: Array<{ stage: string; downloadedBytes?: number; totalBytes?: number }> = [];
    const status = await manager.installOrUpdate((next) => progress.push(next));
    expect(status).toMatchObject({ installedVersion: "18.20.0", previousVersion: null });
    expect(progress.some((item) => item.stage === "download" && (item.totalBytes ?? 0) > 0)).toBe(true);
    expect(progress.map((item) => item.stage)).toContain("verify");
    expect(progress.map((item) => item.stage)).toContain("activate");
    expect(await manager.getExecutablePath()).toBe(join(rootDir, "versions", "18.20.0", "omp-windows-x64.exe"));
    const executablePath = await manager.getExecutablePath();
    expect(executablePath).not.toBeNull();
    expect(await readFile(executablePath!)).toEqual(Buffer.from(binary));
  });

  it("reuses an inactive cached release only after checking both official hashes and its reported version", async () => {
    const current = await makeManager({ version: "18.20.0" });
    await current.manager.installOrUpdate();
    const latest = await makeManager({ version: "18.21.0" });
    const cachedDir = join(current.rootDir, "versions", "18.21.0");
    await mkdir(cachedDir, { recursive: true });
    await writeFile(join(cachedDir, "omp-windows-x64.exe"), latest.binary);
    await writeFile(join(cachedDir, "LICENSE"), "MIT license");
    const fetchLatestOnly = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("/releases/latest")) throw new Error("valid cached files must skip all asset downloads");
      return new Response(JSON.stringify({ tag_name: "v18.21.0", draft: false, prerelease: false, assets: latest.assets }), { status: 200 });
    });
    const updater = new OmpManagedEngine({
      rootDir: current.rootDir,
      platform: "windows-x64",
      fetch: fetchLatestOnly as typeof fetch,
      runVersionCheck: async () => "18.21.0",
    });

    const status = await updater.installOrUpdate();
    expect(status).toMatchObject({ installedVersion: "18.21.0", previousVersion: "18.20.0", operation: { state: "completed", progress: { stage: "reuse" } } });
    expect(fetchLatestOnly.mock.calls.some(([input]) => !String(input).includes("/releases/latest"))).toBe(false);
    expect(JSON.parse(await readFile(join(current.rootDir, "active.json"), "utf8"))).toEqual({ version: "18.21.0", previousVersion: "18.20.0" });
  });

  it("activates a fully downloaded and verified staging release instead of downloading the large executable again", async () => {
    const current = await makeManager({ version: "18.20.0" });
    await current.manager.installOrUpdate();
    const latest = await makeManager({ version: "18.21.0" });
    const stagedDir = join(current.rootDir, "staging", "18.21.0-1731600000000");
    await mkdir(stagedDir, { recursive: true });
    await writeFile(join(stagedDir, "omp-windows-x64.exe"), latest.binary);
    await writeFile(join(stagedDir, "LICENSE"), "MIT license");
    const fetchMetadataOnly = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("/releases/latest")) throw new Error("verified staging release must skip asset downloads");
      return new Response(JSON.stringify({ tag_name: "v18.21.0", draft: false, prerelease: false, assets: latest.assets }), { status: 200 });
    });
    const updater = new OmpManagedEngine({
      rootDir: current.rootDir,
      platform: "windows-x64",
      fetch: fetchMetadataOnly as typeof fetch,
      runVersionCheck: async () => "18.21.0",
    });

    const status = await updater.installOrUpdate();
    expect(status).toMatchObject({ installedVersion: "18.21.0", previousVersion: "18.20.0", operation: { state: "completed", progress: { stage: "activate" } } });
    expect(fetchMetadataOnly.mock.calls.some(([input]) => !String(input).includes("/releases/latest"))).toBe(false);
    expect(await readFile(join(current.rootDir, "versions", "18.21.0", "omp-windows-x64.exe"))).toEqual(Buffer.from(latest.binary));
    await expect(stat(stagedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-downloads a corrupt cached version and replaces it without disturbing the active version", async () => {
    const current = await makeManager({ version: "18.20.0" });
    await current.manager.installOrUpdate();
    const latest = await makeManager({ version: "18.21.0" });
    const cachedDir = join(current.rootDir, "versions", "18.21.0");
    await mkdir(cachedDir, { recursive: true });
    await writeFile(join(cachedDir, "omp-windows-x64.exe"), "corrupt executable");
    await writeFile(join(cachedDir, "LICENSE"), "wrong license");
    const updater = new OmpManagedEngine({
      rootDir: current.rootDir,
      platform: "windows-x64",
      fetch: latest.fetchMock as typeof fetch,
      runVersionCheck: async () => "18.21.0",
    });

    const status = await updater.installOrUpdate();
    expect(status.installedVersion).toBe("18.21.0");
    expect(await readFile(join(cachedDir, "omp-windows-x64.exe"))).toEqual(Buffer.from(latest.binary));
    expect(await readFile(join(cachedDir, "LICENSE"), "utf8")).toBe("MIT license");
    expect((await readdir(join(current.rootDir, "versions"))).some((name) => name.includes(".invalid-"))).toBe(false);
  });

  it("cancels a download, removes staging data, and keeps the currently active version", async () => {
    const current = await makeManager({ version: "18.20.0" });
    await current.manager.installOrUpdate();
    const next = await makeManager({ version: "18.21.0" });
    let signal: AbortSignal | undefined;
    let releaseProgress!: () => void;
    const progressSeen = new Promise<void>((resolve) => { releaseProgress = resolve; });
    const fetchWithBlockedAsset = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/releases/latest")) {
        return new Response(JSON.stringify({ tag_name: "v18.21.0", draft: false, prerelease: false, assets: next.assets }), { status: 200 });
      }
      signal = init?.signal as AbortSignal | undefined;
      let finishPull!: () => void;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(next.binary.slice(0, 4)); },
        pull() { return new Promise<void>((resolve) => { finishPull = resolve; }); },
        cancel() { finishPull?.(); },
      });
      return new Response(stream, { status: 200, headers: { "content-length": String(next.binary.byteLength) } });
    });
    const updater = new OmpManagedEngine({
      rootDir: current.rootDir,
      platform: "windows-x64",
      fetch: fetchWithBlockedAsset as typeof fetch,
      runVersionCheck: async () => "18.21.0",
    });
    const install = updater.installOrUpdate((progress) => { if (progress.stage === "download") releaseProgress(); });
    await progressSeen;
    expect(signal?.aborted).toBe(false);
    expect(await updater.status()).toMatchObject({
      installedVersion: "18.20.0",
      latestVersion: "18.21.0",
      operation: { state: "running", progress: { stage: "download", version: "18.21.0" } },
    });
    const cancellation = await updater.cancelOperation();
    const status = await install;

    expect(cancellation.cancelled).toBe(true);
    expect(cancellation.operation?.state).toBe("cancelled");
    expect(status).toMatchObject({ installedVersion: "18.20.0", operation: { state: "cancelled" } });
    expect(JSON.parse(await readFile(join(current.rootDir, "active.json"), "utf8")).version).toBe("18.20.0");
    expect(await readdir(join(current.rootDir, "staging"))).toEqual([]);
  });

  it("leaves the active version unchanged when the upstream checksum is wrong", async () => {
    const original = await makeManager({ version: "18.20.0" });
    await original.manager.installOrUpdate();
    const next = await makeManager({ version: "18.21.0" });
    // Reuse the same managed root and deliberately change the binary bytes after digest metadata is created.
    const altered = new TextEncoder().encode("altered payload");
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/releases/latest")) return new Response(JSON.stringify({ tag_name: "v18.21.0", draft: false, prerelease: false, assets: next.assets }), { status: 200 });
      return new Response(url.endsWith("LICENSE") ? new TextEncoder().encode("MIT license") : altered, { status: 200 });
    });
    const updater = new OmpManagedEngine({ rootDir: original.rootDir, platform: "windows-x64", fetch: fetch as typeof fetch, runVersionCheck: async () => "18.21.0" });
    await expect(updater.installOrUpdate()).rejects.toThrow("SHA-256 校验失败");
    expect((await original.manager.status()).installedVersion).toBe("18.20.0");
  });

  it("keeps a previous version and atomically switches back on rollback", async () => {
    const first = await makeManager({ version: "18.20.0" });
    await first.manager.installOrUpdate();
    const nextRelease = await makeManager({ version: "18.21.0" });
    const second = new OmpManagedEngine({
      rootDir: first.rootDir,
      platform: "windows-x64",
      fetch: nextRelease.fetchMock as typeof fetch,
      runVersionCheck: async () => "18.21.0",
    });
    await second.installOrUpdate();
    expect((await second.status()).previousVersion).toBe("18.20.0");
    expect((await second.rollback()).installedVersion).toBe("18.20.0");
    expect((await second.status()).previousVersion).toBe("18.21.0");
  });

  it("rejects releases that omit a verifiable SHA-256 digest", async () => {
    const { rootDir, assets } = await makeManager();
    const manager = new OmpManagedEngine({
      rootDir,
      platform: "windows-x64",
      fetch: (async (input: RequestInfo | URL) => String(input).includes("/releases/latest")
        ? new Response(JSON.stringify({ tag_name: "v18.20.0", draft: false, prerelease: false, assets: [{ ...assets[0], digest: null }, assets[1] ] }), { status: 200 })
        : new Response("unused")) as typeof fetch,
    });
    await expect(manager.installOrUpdate()).rejects.toThrow("SHA-256");
  });

  it("does not activate a binary whose reported version differs from the release tag", async () => {
    const { manager, rootDir, fetchMock } = await makeManager({ version: "18.20.0" });
    const firstInstall = new OmpManagedEngine({
      rootDir,
      platform: "windows-x64",
      fetch: fetchMock as typeof fetch,
      runVersionCheck: async () => "18.19.9",
    });
    await expect(firstInstall.installOrUpdate()).rejects.toThrow("版本与下载的 Release 不一致");
    expect((await manager.status()).installedVersion).toBeNull();
  });

  it("requires an explicit binary version verifier before activation", async () => {
    const { manager: source, rootDir, fetchMock } = await makeManager();
    const manager = new OmpManagedEngine({ rootDir, platform: "windows-x64", fetch: fetchMock as typeof fetch });
    await expect(manager.installOrUpdate()).rejects.toThrow("缺少 OMP 二进制版本校验器");
    expect(await source.getExecutablePath()).toBeNull();
  });

it.skipIf(!process.env.PI_OMP_TEST_BINARY)("imports the user's official binary without downloading the executable again", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "omp-local-import-"));
    try {
      const source = process.env.PI_OMP_TEST_BINARY!;
      const binary = await readFile(source);
      const license = Buffer.from("MIT License\n");
      const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const version = "18.20.0";
      const assets = [
        { name: "omp-windows-x64.exe", size: binary.byteLength, digest: digest(binary), browser_download_url: `https://github.com/can1357/oh-my-pi/releases/download/v${version}/omp-windows-x64.exe` },
        { name: "LICENSE", size: license.byteLength, digest: digest(license), browser_download_url: `https://github.com/can1357/oh-my-pi/releases/download/v${version}/LICENSE` },
      ];
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/releases/tags/") || url.includes("/releases/latest")) {
          return new Response(JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false, assets }), { status: 200 });
        }
        return new Response(license, { status: 200, headers: { "content-length": String(license.byteLength) } });
      });
      const manager = createOmpManagedEngine(join(rootDir, "managed"), { fetch: fetchMock as typeof fetch });
      const status = await manager.installLocalBinary(source);
      expect(status.installedVersion).toBe("18.20.0");
      const executablePath = await manager.getExecutablePath();
      expect(executablePath).not.toBeNull();
      expect((await stat(executablePath!)).size).toBe(251_502_592);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!process.env.PI_OMP_TEST_BINARY || !persistentInstallRoot)("imports the downloaded official binary into the explicitly selected PI data root", async () => {
    const manager = createOmpManagedEngine(persistentInstallRoot!);
    const status = await manager.installLocalBinary(process.env.PI_OMP_TEST_BINARY!);
    expect(status.installedVersion).toBe("18.20.0");
    const path = await manager.getExecutablePath();
    expect(path).toBe(join(persistentInstallRoot!, "versions", "18.20.0", "omp-windows-x64.exe"));
    expect((await stat(path!)).size).toBe(251_502_592);
  }, 60_000);
});
