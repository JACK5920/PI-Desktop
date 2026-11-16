import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { PROTOCOL_VERSION } from "@pi-desktop/shared";

const OWNER = "vastsa";
const REPO = "PI-Desktop";
const RELEASE_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const PACKAGE_NAMES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
] as const;
const execFileAsync = promisify(execFile);

export type PiEnginePlatform = "windows-x64" | "windows-arm64" | "darwin-x64" | "darwin-arm64" | "linux-x64" | "linux-arm64";
export type PiPackageVersions = Record<(typeof PACKAGE_NAMES)[number], string>;
export type PiRuntimeFile = { path: string; size: number; sha256: string };
export type PiRuntimeManifest = {
  schemaVersion: 1;
  engine: "pi";
  desktopVersion: string;
  agentRuntimeVersion: string;
  protocolVersion: number;
  piPackages: PiPackageVersions;
  piPatchHashes: Record<(typeof PACKAGE_NAMES)[number], string>;
  files: PiRuntimeFile[];
};
export type PiRuntimeProgress = {
  stage: "check" | "download" | "verify" | "extract" | "smoke" | "activate";
  version?: string;
  assetName?: string;
  downloadedBytes?: number;
  totalBytes?: number;
};
export type PiRuntimeOperation = {
  state: "running" | "cancelling" | "completed" | "cancelled" | "failed";
  action: "install";
  progress: PiRuntimeProgress | null;
  error?: string;
  startedAt: number;
  updatedAt: number;
};
export type PiEngineStatus = {
  supported: boolean;
  runningManifest: PiRuntimeManifest | null;
  installedManifest: PiRuntimeManifest | null;
  latestManifest: PiRuntimeManifest | null;
  latestReleaseTag: string | null;
  latestPackageVersions: Partial<PiPackageVersions>;
  latestReleaseNotes: string | null;
  previousVersion: string | null;
  canRollback: boolean;
  restartRequired: boolean;
  updateAvailable: boolean;
  remoteError: string | null;
  operation: PiRuntimeOperation | null;
};

type ReleaseAsset = { name: string; size: number; digest?: string | null; browser_download_url: string };
type Release = { tag_name: string; draft: boolean; prerelease: boolean; body?: string; assets: ReleaseAsset[] };
type ReleaseManifest = PiRuntimeManifest & { releaseTag: string; archiveName: string; archiveSha256: string; runtimeManifestSize: number };
type ActivePointer = { version: string; previousVersion: string | null; updatedAt: number };
export type PiRuntimeManagerDependencies = {
  rootDir: string;
  bundledRuntimeDir: string;
  platform: PiEnginePlatform;
  fetch?: typeof fetch;
  protocolVersion?: number;
  /** Test seam; production uses the OS tar utility and Electron's Node mode. */
  runCommand?: (command: string, args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
  smokeTest?: (entryPath: string, signal?: AbortSignal) => Promise<void>;
};

export function currentPiEnginePlatform(platform = process.platform, arch = process.arch): PiEnginePlatform {
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return `windows-${arch}`;
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) return `darwin-${arch}`;
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) return `linux-${arch}`;
  throw new Error(`当前系统暂不支持 PI 引擎更新：${platform}/${arch}`);
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function validRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value) && value !== "." && value !== "..";
}

function digestFromAsset(asset: ReleaseAsset): string {
  const value = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1];
  if (!value) throw new Error(`GitHub 未提供可验证的 SHA-256：${asset.name}`);
  return value.toLowerCase();
}

function assertOfficialAssetUrl(asset: ReleaseAsset, releaseTag: string): void {
  let url: URL;
  try { url = new URL(asset.browser_download_url); }
  catch { throw new Error(`PI 引擎资产下载地址无效：${asset.name}`); }
  const expectedPath = `/vastsa/PI-Desktop/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(asset.name)}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath || url.username || url.password) {
    throw new Error(`PI 引擎资产不是来自固定的官方 GitHub 发布地址：${asset.name}`);
  }
}

function safeManifest(value: unknown, protocolVersion: number): value is PiRuntimeManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<PiRuntimeManifest>;
  if (manifest.schemaVersion !== 1 || manifest.engine !== "pi" || !validVersion(manifest.desktopVersion) ||
      !validVersion(manifest.agentRuntimeVersion) || manifest.protocolVersion !== protocolVersion ||
      !manifest.piPackages || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 2048) return false;
  if (!PACKAGE_NAMES.every((name) => validVersion(manifest.piPackages?.[name]))) return false;
  if (!PACKAGE_NAMES.every((name) => typeof manifest.piPatchHashes?.[name] === "string" && /^[a-f0-9]{64}$/.test(manifest.piPatchHashes[name]))) return false;
  let total = 0;
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || file.path.length > 1024 || file.path.includes("\\") ||
        file.path.startsWith("/") || file.path.split("/").some((part) => !part || part === "." || part === "..") ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || paths.has(file.path)) return false;
    total += file.size;
    if (total > MAX_ARCHIVE_BYTES) return false;
    paths.add(file.path);
  }
  return paths.has("sidecar.js") && paths.has("package.json");
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  const abort = () => stream.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException("PI engine update cancelled", "AbortError"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) { signal?.throwIfAborted(); hash.update(chunk as Buffer); }
    signal?.throwIfAborted();
  } finally { signal?.removeEventListener("abort", abort); }
  return hash.digest("hex");
}

async function readManifest(directory: string, protocolVersion: number): Promise<PiRuntimeManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, "runtime-manifest.json"), "utf8"));
    return safeManifest(parsed, protocolVersion) ? parsed : null;
  } catch { return null; }
}

function parseLatestVersion(value: unknown): string | null {
  const version = typeof value === "string" ? value : "";
  return validVersion(version) ? version : null;
}

export class PiManagedEngine {
  private readonly fetchImpl: typeof fetch;
  private readonly protocolVersion: number;
  private operation: PiRuntimeOperation | null = null;
  private controller: AbortController | null = null;
  private operationPromise: Promise<void> | null = null;
  private settleOperation: (() => void) | null = null;
  private latestBundle: { release: Release; manifest: ReleaseManifest; archive: ReleaseAsset } | null = null;
  private latestPackageVersions: Partial<PiPackageVersions> = {};
  private remoteError: string | null = null;
  private readonly startupVersion: string;

  constructor(private readonly deps: PiRuntimeManagerDependencies) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.protocolVersion = deps.protocolVersion ?? PROTOCOL_VERSION;
    this.startupVersion = this.readPointerSync()?.version ?? "bundled";
  }

  private get pointerPath(): string { return join(this.deps.rootDir, "active.json"); }
  private versionDir(version: string): string { return join(this.deps.rootDir, "versions", version); }

  private readPointerSync(): ActivePointer | null {
    try {
      const value = JSON.parse(readFileSync(this.pointerPath, "utf8")) as Partial<ActivePointer>;
      if (!validRuntimeId(value.version) || (value.previousVersion !== null && value.previousVersion !== undefined && !validRuntimeId(value.previousVersion))) return null;
      return { version: value.version, previousVersion: value.previousVersion ?? null, updatedAt: Number(value.updatedAt) || 0 };
    } catch { return null; }
  }

  private async readPointer(): Promise<ActivePointer | null> {
    try {
      const value = JSON.parse(await readFile(this.pointerPath, "utf8")) as Partial<ActivePointer>;
      if (!validRuntimeId(value.version) || (value.previousVersion !== null && value.previousVersion !== undefined && !validRuntimeId(value.previousVersion))) return null;
      return { version: value.version, previousVersion: value.previousVersion ?? null, updatedAt: Number(value.updatedAt) || 0 };
    } catch { return null; }
  }

  private async manifestFor(version: string): Promise<PiRuntimeManifest | null> {
    if (version === "bundled") return readManifest(this.deps.bundledRuntimeDir, this.protocolVersion);
    return readManifest(this.versionDir(version), this.protocolVersion);
  }

  private async loadRemote(signal?: AbortSignal): Promise<void> {
    this.latestBundle = null;
    this.latestPackageVersions = {};
    const packageResults = await Promise.all(PACKAGE_NAMES.map(async (name) => {
      const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
      const response = await this.fetchImpl(url, { signal, headers: { accept: "application/vnd.npm.install-v1+json" } });
      if (!response.ok) throw new Error(`npm 查询失败（${response.status}）`);
      const data = await response.json() as { name?: string; version?: unknown };
      if (data.name !== name || !validVersion(data.version)) throw new Error(`npm 返回的 ${name} 版本信息无效`);
      return [name, data.version] as const;
    }));
    this.latestPackageVersions = Object.fromEntries(packageResults) as Partial<PiPackageVersions>;

    const response = await this.fetchImpl(RELEASE_API, {
      signal,
      headers: { accept: "application/vnd.github+json", "user-agent": "PI-Desktop-PI-Engine-Manager" },
    });
    if (!response.ok) throw new Error(`PI-Desktop 发布检查失败（GitHub HTTP ${response.status}）`);
    const release = await response.json() as Release;
    if (release.draft || release.prerelease || typeof release.tag_name !== "string") throw new Error("PI-Desktop 最新稳定发布信息无效");
    const platform = this.deps.platform;
    const manifestAsset = release.assets.find((asset) => asset.name === `pi-engine-runtime-${platform}.manifest.json`);
    const archive = release.assets.find((asset) => asset.name === `pi-engine-runtime-${platform}.tar.gz`);
    if (!manifestAsset || !archive) {
      this.remoteError = `最新桌面发布 ${release.tag_name} 尚未包含当前平台的 PI 引擎更新包`;
      return;
    }
    if (manifestAsset.size <= 0 || manifestAsset.size > 1024 * 1024 || archive.size <= 0 || archive.size > MAX_ARCHIVE_BYTES) {
      throw new Error("PI 引擎更新包大小无效");
    }
    assertOfficialAssetUrl(manifestAsset, release.tag_name);
    assertOfficialAssetUrl(archive, release.tag_name);
    digestFromAsset(manifestAsset);
    const manifestBytes = await this.downloadBytes(manifestAsset, 1024 * 1024, undefined, signal);
    const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
    if (manifestDigest !== digestFromAsset(manifestAsset)) throw new Error("PI 引擎版本清单 SHA-256 校验失败");
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ReleaseManifest;
    if (!safeManifest(manifest, this.protocolVersion)) {
      this.remoteError = "最新 PI 引擎包与当前桌面协议不兼容，已阻止安装";
      return;
    }
    if (manifest.releaseTag !== release.tag_name || manifest.archiveName !== archive.name ||
        !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) || manifest.archiveSha256 !== digestFromAsset(archive) ||
        !Number.isSafeInteger(manifest.runtimeManifestSize) || manifest.runtimeManifestSize <= 0 || manifest.runtimeManifestSize > 1024 * 1024) {
      throw new Error("PI 引擎发布清单与 GitHub 资产不匹配");
    }
    this.latestBundle = { release, manifest, archive };
    this.remoteError = null;
  }

  private async downloadBytes(asset: ReleaseAsset, maxBytes: number, progress?: (received: number, total: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
    digestFromAsset(asset);
    const response = await this.fetchImpl(asset.browser_download_url, { signal, headers: { "user-agent": "PI-Desktop-PI-Engine-Manager" } });
    if (!response.ok || !response.body) throw new Error(`下载 PI 引擎资产失败（HTTP ${response.status}）`);
    const declared = Number(response.headers.get("content-length") ?? asset.size);
    if (declared > maxBytes || asset.size > maxBytes) throw new Error("PI 引擎下载超过大小限制");
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    const cancelReader = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
    signal?.addEventListener("abort", cancelReader, { once: true });
    let size = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("PI 引擎下载超过大小限制");
        chunks.push(value);
        progress?.(size, declared || asset.size);
      }
    } finally {
      signal?.removeEventListener("abort", cancelReader);
      reader.releaseLock();
    }
    signal?.throwIfAborted();
    if (!size || (declared && size !== declared)) throw new Error("PI 引擎下载长度校验失败");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  private getOperationSnapshot(): PiRuntimeOperation | null {
    return this.operation ? structuredClone(this.operation) : null;
  }

  private updateOperation(patch: Partial<PiRuntimeOperation>): void {
    if (!this.operation) return;
    this.operation = { ...this.operation, ...patch, updatedAt: Date.now() };
  }

  private report(progress: PiRuntimeProgress, callback?: (progress: PiRuntimeProgress) => void): void {
    this.updateOperation({ progress });
    callback?.(progress);
  }

  private beginOperation(): AbortController {
    if (this.operationPromise) throw new Error("PI 引擎操作正在进行");
    const controller = new AbortController();
    const now = Date.now();
    this.operation = { state: "running", action: "install", progress: null, startedAt: now, updatedAt: now };
    this.controller = controller;
    this.operationPromise = new Promise<void>((resolve) => { this.settleOperation = resolve; });
    return controller;
  }

  private finishOperation(state: PiRuntimeOperation["state"], error?: string): void {
    this.updateOperation({ state, ...(error ? { error } : {}) });
    this.controller = null;
    this.operationPromise = null;
    this.settleOperation?.();
    this.settleOperation = null;
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("PI engine update cancelled", "AbortError");
  }

  async status(): Promise<PiEngineStatus> {
    const pointer = await this.readPointer();
    const installedVersion = pointer?.version ?? "bundled";
    const runningManifest = await this.manifestFor(this.startupVersion);
    const installedManifest = await this.manifestFor(installedVersion);
    const isActive = this.operation?.state === "running" || this.operation?.state === "cancelling";
    let remoteError = this.remoteError;
    if (!isActive) {
      try { await this.loadRemote(); remoteError = this.remoteError; }
      catch (error) { remoteError = error instanceof Error ? error.message : String(error); }
    }
    const latestManifest = this.latestBundle?.manifest ?? null;
    const latestTag = this.latestBundle?.release.tag_name ?? null;
    const updateAvailable = !!latestManifest && !!installedManifest && compareVersions(latestManifest.desktopVersion, installedManifest.desktopVersion) > 0;
    return {
      supported: true,
      runningManifest,
      installedManifest,
      latestManifest,
      latestReleaseTag: latestTag,
      latestPackageVersions: this.latestPackageVersions,
      latestReleaseNotes: this.latestBundle?.release.body?.slice(0, 12000) ?? null,
      previousVersion: pointer?.previousVersion ?? null,
      canRollback: !!pointer?.previousVersion && !!await this.manifestFor(pointer.previousVersion),
      restartRequired: installedVersion !== this.startupVersion,
      updateAvailable,
      remoteError,
      operation: this.getOperationSnapshot(),
    };
  }

  async installOrUpdate(onProgress?: (progress: PiRuntimeProgress) => void): Promise<PiEngineStatus> {
    const controller = this.beginOperation();
    let stageDir: string | null = null;
    try {
      this.report({ stage: "check" }, onProgress);
      await this.loadRemote(controller.signal);
      this.throwIfCancelled(controller.signal);
      const bundle = this.latestBundle;
      if (!bundle) throw new Error(this.remoteError ?? "没有可用于当前平台的 PI 引擎更新包");
      const oldPointer = await this.readPointer();
      const oldVersion = oldPointer?.version ?? "bundled";
      const runningManifest = await this.manifestFor(this.startupVersion);
      if (!runningManifest) throw new Error("当前内置 PI 引擎版本清单不可用，拒绝替换");
      if (compareVersions(bundle.manifest.desktopVersion, runningManifest.desktopVersion) <= 0) {
        throw new Error("当前 PI 引擎已是最新兼容构建");
      }
      stageDir = join(this.deps.rootDir, "staging", `${bundle.manifest.desktopVersion}-${Date.now()}-${randomUUID()}`);
      await mkdir(stageDir, { recursive: true });
      const archivePath = join(stageDir, bundle.archive.name);
      const archiveBytes = await this.downloadBytes(bundle.archive, MAX_ARCHIVE_BYTES, (received, total) => {
        this.report({ stage: "download", version: bundle.manifest.desktopVersion, assetName: bundle.archive.name, downloadedBytes: received, totalBytes: total }, onProgress);
      }, controller.signal);
      this.throwIfCancelled(controller.signal);
      const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
      if (archiveHash !== bundle.manifest.archiveSha256 || archiveHash !== digestFromAsset(bundle.archive)) throw new Error("PI 引擎包 SHA-256 校验失败");
      await writeFile(archivePath, archiveBytes, { flag: "wx" });

      this.report({ stage: "verify", version: bundle.manifest.desktopVersion, downloadedBytes: archiveBytes.byteLength, totalBytes: bundle.archive.size }, onProgress);
      const listing = await this.runCommand("tar", ["-tzf", archivePath], controller.signal);
      const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
      const expectedFiles = new Map(bundle.manifest.files.map((file) => [file.path, file.size]));
      expectedFiles.set("runtime-manifest.json", bundle.manifest.runtimeManifestSize);
      const listedFiles = new Set<string>();
      for (const entry of entries) {
        const isDirectory = entry.endsWith("/");
        const normalized = entry.replace(/^\.\//, "").replace(/\/$/, "");
        if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || normalized.includes(":") || normalized.split("/").some((part) => part === "..") || !/^[A-Za-z0-9._/-]+$/.test(normalized)) {
          throw new Error("PI 引擎压缩包包含不安全路径");
        }
        if (isDirectory) {
          if (![...expectedFiles.keys()].some((path) => path.startsWith(`${normalized}/`))) throw new Error(`PI 引擎包包含未声明目录：${normalized}`);
        } else {
          if (!expectedFiles.has(normalized) || listedFiles.has(normalized)) throw new Error(`PI 引擎包包含未声明或重复文件：${normalized}`);
          listedFiles.add(normalized);
        }
      }
      if (listedFiles.size !== expectedFiles.size || [...expectedFiles.keys()].some((path) => !listedFiles.has(path))) throw new Error("PI 引擎压缩包与官方文件清单不一致");
      const verbose = await this.runCommand("tar", ["-tvzf", archivePath], controller.signal);
      const verboseLines = verbose.stdout.split(/\r?\n/).filter(Boolean);
      if (verboseLines.length !== entries.length) throw new Error("PI 引擎压缩包目录清单校验失败");
      for (const line of verboseLines) {
        const mode = line[0] ?? "";
        if (mode !== "-" && mode !== "d") throw new Error("PI 引擎压缩包不允许包含链接或特殊文件");
      }
      for (const [path, expectedSize] of expectedFiles) {
        const line = verboseLines.find((candidate) => candidate.endsWith(` ${path}`));
        if (!line || line[0] !== "-") throw new Error(`PI 引擎压缩包缺少普通文件：${path}`);
        const sizeTokens: string[] = line.slice(0, -path.length).match(/\d+/g) ?? [];
        if (!sizeTokens.includes(String(expectedSize))) throw new Error(`PI 引擎压缩包中的文件大小与清单不符：${path}`);
      }
      this.throwIfCancelled(controller.signal);
      const extractedDir = join(stageDir, "bundle");
      await mkdir(extractedDir, { recursive: true });
      this.report({ stage: "extract", version: bundle.manifest.desktopVersion }, onProgress);
      await this.runCommand("tar", ["-xzf", archivePath, "-C", extractedDir, "--no-same-owner", "--no-same-permissions"], controller.signal);
      this.throwIfCancelled(controller.signal);
      const innerManifest = await readManifest(extractedDir, this.protocolVersion);
      if (!innerManifest || innerManifest.desktopVersion !== bundle.manifest.desktopVersion ||
          JSON.stringify(innerManifest.piPackages) !== JSON.stringify(bundle.manifest.piPackages) ||
          JSON.stringify(innerManifest.files) !== JSON.stringify(bundle.manifest.files)) throw new Error("PI 引擎包内版本清单与官方清单不一致");
      await this.verifyExtractedFiles(extractedDir, innerManifest, controller.signal);

      this.report({ stage: "smoke", version: bundle.manifest.desktopVersion }, onProgress);
      await (this.deps.smokeTest ?? ((entry, signal) => this.smokeTest(entry, signal)))(join(extractedDir, "sidecar.js"), controller.signal);
      this.throwIfCancelled(controller.signal);
      const runtimeId = `${bundle.manifest.desktopVersion}-${bundle.manifest.archiveSha256.slice(0, 16)}`;
      const versionDir = this.versionDir(runtimeId);
      await mkdir(join(this.deps.rootDir, "versions"), { recursive: true });
      try { await rename(extractedDir, versionDir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        const existing = await readManifest(versionDir, this.protocolVersion);
        if (!existing || existing.desktopVersion !== bundle.manifest.desktopVersion) throw error;
      }
      this.report({ stage: "activate", version: bundle.manifest.desktopVersion }, onProgress);
      this.throwIfCancelled(controller.signal);
      await this.writePointer({ version: runtimeId, previousVersion: oldVersion, updatedAt: Date.now() });
      await rm(stageDir, { recursive: true, force: true });
      stageDir = null;
      this.finishOperation("completed");
      return this.status();
    } catch (error) {
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      this.finishOperation(cancelled ? "cancelled" : "failed", cancelled ? undefined : error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async verifyExtractedFiles(directory: string, manifest: PiRuntimeManifest, signal: AbortSignal): Promise<void> {
    const expected = new Set([...manifest.files.map((file) => file.path), "runtime-manifest.json"]);
    const seen = new Set<string>();
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        signal.throwIfAborted();
        const absolute = join(current, entry.name);
        const path = relative(directory, absolute).split(sep).join("/");
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new Error("PI 引擎包包含符号链接");
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) {
          if (!expected.has(path)) throw new Error(`PI 引擎包包含未声明文件：${path}`);
          seen.add(path);
        } else throw new Error("PI 引擎包包含特殊文件");
      }
    };
    await walk(directory);
    if (seen.size !== expected.size || [...expected].some((path) => !seen.has(path))) throw new Error("PI 引擎包文件清单不完整");
    for (const file of manifest.files) {
      const path = join(directory, ...file.path.split("/"));
      const info = await lstat(path);
      if (info.size !== file.size || await sha256File(path, signal) !== file.sha256) throw new Error(`PI 引擎文件校验失败：${file.path}`);
    }
  }

  private async runCommand(command: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    if (this.deps.runCommand) return this.deps.runCommand(command, args, signal);
    return execFileAsync(command, args, {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
  }

  private async smokeTest(entryPath: string, signal?: AbortSignal): Promise<void> {
    await execFileAsync(process.execPath, ["--check", entryPath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      ...(signal ? { signal } : {}),
    });
  }

  private async writePointer(pointer: ActivePointer): Promise<void> {
    await mkdir(this.deps.rootDir, { recursive: true });
    const temporary = join(this.deps.rootDir, `active.${randomUUID()}.tmp`);
    const backup = join(this.deps.rootDir, `active.${randomUUID()}.bak`);
    await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { flag: "wx" });
    try { await rename(temporary, this.pointerPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      let movedOld = false;
      try {
        await rename(this.pointerPath, backup);
        movedOld = true;
        await rename(temporary, this.pointerPath);
      } catch (replaceError) {
        if (movedOld) await rename(backup, this.pointerPath).catch(() => undefined);
        throw replaceError;
      } finally {
        await rm(backup, { force: true }).catch(() => undefined);
      }
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async cancelOperation(): Promise<{ cancelled: boolean; operation: PiRuntimeOperation | null }> {
    if (!this.controller || !this.operationPromise || !this.operation) return { cancelled: false, operation: this.getOperationSnapshot() };
    if (this.operation.progress?.stage === "activate") return { cancelled: false, operation: this.getOperationSnapshot() };
    this.updateOperation({ state: "cancelling" });
    this.controller.abort(new DOMException("PI engine update cancelled", "AbortError"));
    await this.operationPromise;
    return { cancelled: this.operation?.state === "cancelled", operation: this.getOperationSnapshot() };
  }

  async rollback(): Promise<PiEngineStatus> {
    if (this.operationPromise) throw new Error("PI 引擎正在更新，暂时不能回滚");
    const pointer = await this.readPointer();
    if (!pointer?.previousVersion) throw new Error("没有可回滚的 PI 引擎版本");
    if (!await this.manifestFor(pointer.previousVersion)) throw new Error("上一个 PI 引擎版本不存在或与当前协议不兼容");
    await this.writePointer({ version: pointer.previousVersion, previousVersion: pointer.version, updatedAt: Date.now() });
    return this.status();
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.replace(/^v/, "").split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] ?? 0; const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "number") return av < bv ? -1 : 1;
    if (typeof av === "number") return 1;
    if (typeof bv === "number") return -1;
    return String(av).localeCompare(String(bv));
  }
  return 0;
}

export function createPiManagedEngine(rootDir: string, bundledRuntimeDir: string, options: { fetch?: typeof fetch } = {}): PiManagedEngine {
  return new PiManagedEngine({
    rootDir,
    bundledRuntimeDir,
    platform: currentPiEnginePlatform(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
