import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const OWNER = "can1357";
const REPO = "oh-my-pi";
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases`;
const MAX_BINARY_BYTES = 400 * 1024 * 1024;
const MAX_LICENSE_BYTES = 64 * 1024;

type ReleaseAsset = {
  url?: string;
  name: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
};

type Release = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
};

export type OmpPlatform = "windows-x64" | "windows-arm64" | "darwin-x64" | "darwin-arm64" | "linux-x64" | "linux-arm64";

export type ManagedOmpStatus = {
  installedVersion: string | null;
  previousVersion: string | null;
  latestVersion: string | null;
  canRollback: boolean;
  /** Main-process snapshot; survives renderer/settings-page unmounts. */
  operation: OmpEngineOperation | null;
};

export type OmpInstallProgress = {
  stage: "check" | "download" | "verify" | "reuse" | "activate";
  version: string;
  assetName?: string;
  downloadedBytes?: number;
  totalBytes?: number;
};

export type OmpEngineOperation = {
  state: "running" | "cancelling" | "completed" | "cancelled" | "failed";
  action: "install" | "import";
  progress: OmpInstallProgress | null;
  error?: string;
  startedAt: number;
  updatedAt: number;
};

type ActivePointer = { version: string; previousVersion?: string };

export type OmpManagerDependencies = {
  rootDir: string;
  platform: OmpPlatform;
  fetch?: typeof fetch;
  runVersionCheck?: (binaryPath: string, signal?: AbortSignal) => Promise<string>;
};

export function currentOmpPlatform(platform = process.platform, arch = process.arch): OmpPlatform {
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "win32" && arch === "arm64") return "windows-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  throw new Error(`当前系统暂不支持 OMP：${platform}/${arch}`);
}

const execFileAsync = promisify(execFile);

export function createOmpManagedEngine(rootDir: string, options: { fetch?: typeof fetch } = {}): OmpManagedEngine {
  return new OmpManagedEngine({
    rootDir,
    platform: currentOmpPlatform(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    runVersionCheck: async (binaryPath, signal) => {
      const { stdout, stderr } = await execFileAsync(binaryPath, ["--version"], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      });
      const output = `${stdout}\n${stderr}`.trim();
      const version = output.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1];
      if (!version) throw new Error("无法从 OMP 二进制确认版本号");
      return version;
    },
  });
}

function safeVersion(tag: string): string {
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!match) throw new Error("上游版本号格式无效");
  return match[1];
}

function binaryName(platform: OmpPlatform): string {
  const names: Record<OmpPlatform, string> = {
    "windows-x64": "omp-windows-x64.exe",
    "windows-arm64": "omp-windows-arm64.exe",
    "darwin-x64": "omp-darwin-x64",
    "darwin-arm64": "omp-darwin-arm64",
    "linux-x64": "omp-linux-x64",
    "linux-arm64": "omp-linux-arm64",
  };
  return names[platform];
}

function assetDigest(asset: ReleaseAsset): string {
  const digest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1];
  if (!digest) throw new Error(`上游未提供可验证的 SHA-256：${asset.name}`);
  return digest.toLowerCase();
}

async function responseBytes(response: Response, maxBytes: number, onProgress?: (downloadedBytes: number, totalBytes: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("下载文件超过允许大小");
  if (!response.body) throw new Error("下载响应没有文件内容");
  const reader = response.body.getReader();
  const cancelReader = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("下载文件超过允许大小");
      }
      chunks.push(value);
      onProgress?.(total, declared || 0);
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  if (total === 0) throw new Error("下载文件大小无效");
  if (declared && total !== declared) throw new Error("下载文件长度校验失败");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  const abort = () => stream.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException("OMP operation cancelled", "AbortError"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      hash.update(chunk as Buffer);
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  return hash.digest("hex");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class OmpManagedEngine {
  private readonly fetchImpl: typeof fetch;
  private currentOperation: OmpEngineOperation | null = null;
  private operationController: AbortController | null = null;
  private operationSettled: Promise<void> | null = null;
  private settleOperation: (() => void) | null = null;

  constructor(private readonly deps: OmpManagerDependencies) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  private get pointerPath(): string { return join(this.deps.rootDir, "active.json"); }
  private versionDir(version: string): string { return join(this.deps.rootDir, "versions", version); }
  private executablePath(version: string): string { return join(this.versionDir(version), binaryName(this.deps.platform)); }

  /** Create and return only the managed binary versions directory, never the profile/config root. */
  async ensureVersionsDirectory(): Promise<string> {
    const directory = join(this.deps.rootDir, "versions");
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async readPointer(): Promise<ActivePointer | null> {
    try {
      const parsed = JSON.parse(await readFile(this.pointerPath, "utf8")) as ActivePointer;
      if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(parsed.version)) return null;
      return parsed;
    } catch { return null; }
  }

  async status(): Promise<ManagedOmpStatus> {
    const pointer = await this.readPointer();
    const operation = this.getOperationSnapshot();
    if (operation?.state === "running" || operation?.state === "cancelling") {
      return {
        installedVersion: pointer?.version ?? null,
        previousVersion: pointer?.previousVersion ?? null,
        latestVersion: operation.progress?.version || null,
        canRollback: !!pointer?.previousVersion,
        operation,
      };
    }
    const latest = await this.getLatestRelease().catch(() => null);
    return {
      installedVersion: pointer?.version ?? null,
      previousVersion: pointer?.previousVersion ?? null,
      latestVersion: latest?.version ?? null,
      canRollback: !!pointer?.previousVersion,
      operation,
    };
  }

  async installOrUpdate(onProgress?: (progress: OmpInstallProgress) => void): Promise<ManagedOmpStatus> {
    const controller = this.beginOperation("install");
    let staging: string | null = null;
    try {
      this.reportProgress({ stage: "check", version: "" }, onProgress);
      const release = await this.getLatestRelease(controller.signal);
      this.throwIfOperationCancelled(controller.signal);
      this.reportProgress({ stage: "check", version: release.version }, onProgress);
      const old = await this.readPointer();
      const binaryAsset = release.assets.find((asset) => asset.name === binaryName(this.deps.platform));
      const licenseAsset = release.assets.find((asset) => asset.name === "LICENSE");
      if (!binaryAsset || !licenseAsset) throw new Error(`上游未发布当前平台的 OMP 或 LICENSE：${this.deps.platform}`);
      if (binaryAsset.size <= 0 || licenseAsset.size <= 0 || binaryAsset.size > MAX_BINARY_BYTES || licenseAsset.size > MAX_LICENSE_BYTES) throw new Error("上游资产大小无效或超过允许大小");
      // Fail closed if the release does not publish digests, whether we reuse or download.
      assetDigest(binaryAsset);
      assetDigest(licenseAsset);
      this.reportProgress({ stage: "verify", version: release.version, totalBytes: binaryAsset.size + licenseAsset.size }, onProgress);
      const cached = await this.isVerifiedInstalledVersion(release.version, binaryAsset, licenseAsset, controller.signal);
      this.throwIfOperationCancelled(controller.signal);
      if (cached) {
        this.reportProgress({ stage: "reuse", version: release.version, downloadedBytes: binaryAsset.size + licenseAsset.size, totalBytes: binaryAsset.size + licenseAsset.size }, onProgress);
        if (old?.version !== release.version) await this.activateExistingVersion(release.version, old);
        this.finishOperation("completed");
        return this.status();
      }
      const stagedRelease = await this.findVerifiedStagedVersion(release.version, binaryAsset, licenseAsset, controller.signal);
      this.throwIfOperationCancelled(controller.signal);
      if (stagedRelease) {
        this.reportProgress({ stage: "reuse", version: release.version, downloadedBytes: binaryAsset.size + licenseAsset.size, totalBytes: binaryAsset.size + licenseAsset.size }, onProgress);
        this.reportProgress({ stage: "activate", version: release.version }, onProgress);
        await this.activateStagedVersion(stagedRelease, release.version, old);
        this.finishOperation("completed");
        return this.status();
      }
      if (!this.deps.runVersionCheck) throw new Error("缺少 OMP 二进制版本校验器，拒绝激活未经启动验证的版本");
      staging = join(this.deps.rootDir, "staging", `${release.version}-${Date.now()}`);
      await mkdir(staging, { recursive: true });
      const totalBytes = binaryAsset.size + licenseAsset.size;
      let downloadedBytes = 0;
      const reportDownload = (asset: ReleaseAsset, limit: number, byteOffset: number) => this.downloadVerified(asset, limit, (received) => {
        downloadedBytes = byteOffset + received;
        this.reportProgress({ stage: "download", version: release.version, assetName: asset.name, downloadedBytes, totalBytes }, onProgress);
      }, controller.signal);
      const binary = await reportDownload(binaryAsset, MAX_BINARY_BYTES, 0);
      const license = await reportDownload(licenseAsset, MAX_LICENSE_BYTES, binaryAsset.size);
      this.throwIfOperationCancelled(controller.signal);
      this.reportProgress({ stage: "verify", version: release.version, downloadedBytes: totalBytes, totalBytes }, onProgress);
      const binaryPath = join(staging, binaryName(this.deps.platform));
      await writeFile(binaryPath, binary, { flag: "wx" });
      await writeFile(join(staging, "LICENSE"), license, { flag: "wx" });
      if (!this.deps.platform.startsWith("windows-")) await chmod(binaryPath, 0o755);
      const reportedVersion = await this.deps.runVersionCheck(binaryPath, controller.signal);
      this.throwIfOperationCancelled(controller.signal);
      if (reportedVersion.replace(/^v/, "") !== release.version) throw new Error("OMP 二进制版本与下载的 Release 不一致");

      this.reportProgress({ stage: "activate", version: release.version }, onProgress);
      await this.activateStagedVersion(staging, release.version, old);
      staging = null;
      this.finishOperation("completed");
      return this.status();
    } catch (error) {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (controller.signal.aborted || isAbortError(error)) {
        this.finishOperation("cancelled");
        return this.status();
      }
      this.finishOperation("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async installLocalBinary(sourcePath: string, onProgress?: (progress: OmpInstallProgress) => void): Promise<ManagedOmpStatus> {
    const controller = this.beginOperation("import");
    let staging: string | null = null;
    try {
      if (!this.deps.runVersionCheck) throw new Error("缺少 OMP 二进制版本校验器，拒绝导入未经启动验证的文件");
      this.reportProgress({ stage: "check", version: "" }, onProgress);
      const info = await stat(sourcePath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_BINARY_BYTES) throw new Error("本地 OMP 文件大小无效");
      const version = safeVersion(await this.deps.runVersionCheck(sourcePath, controller.signal));
      this.throwIfOperationCancelled(controller.signal);
      const release = await this.getRelease(version, controller.signal);
      const asset = release.assets.find((item) => item.name === binaryName(this.deps.platform));
      const licenseAsset = release.assets.find((item) => item.name === "LICENSE");
      if (!asset || !licenseAsset || asset.size > MAX_BINARY_BYTES || licenseAsset.size > MAX_LICENSE_BYTES) {
        throw new Error(`上游没有找到 ${version} 对应的本平台 OMP 资产`);
      }
      const binary = await readFile(sourcePath);
      if (await sha256(binary) !== assetDigest(asset)) throw new Error("本地 OMP 文件与官方 SHA-256 不匹配");
      if (await this.isVerifiedInstalledVersion(version, asset, licenseAsset, controller.signal)) {
        this.reportProgress({ stage: "reuse", version, downloadedBytes: asset.size + licenseAsset.size, totalBytes: asset.size + licenseAsset.size }, onProgress);
        await this.activateExistingVersion(version, await this.readPointer());
        this.finishOperation("completed");
        return this.status();
      }
      const license = await this.downloadVerified(licenseAsset, MAX_LICENSE_BYTES, (downloadedBytes, totalBytes) => {
        this.reportProgress({ stage: "download", version, assetName: licenseAsset.name, downloadedBytes, totalBytes }, onProgress);
      }, controller.signal);
      this.throwIfOperationCancelled(controller.signal);
      const old = await this.readPointer();
      staging = join(this.deps.rootDir, "staging", `${version}-local-${Date.now()}`);
      await mkdir(staging, { recursive: true });
      const binaryPath = join(staging, binaryName(this.deps.platform));
      await writeFile(binaryPath, binary, { flag: "wx" });
      await writeFile(join(staging, "LICENSE"), license, { flag: "wx" });
      if (!this.deps.platform.startsWith("windows-")) await chmod(binaryPath, 0o755);
      this.reportProgress({ stage: "verify", version, downloadedBytes: info.size, totalBytes: info.size }, onProgress);
      this.throwIfOperationCancelled(controller.signal);
      this.reportProgress({ stage: "activate", version }, onProgress);
      await this.activateStagedVersion(staging, version, old);
      staging = null;
      this.finishOperation("completed");
      return this.status();
    } catch (error) {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (controller.signal.aborted || isAbortError(error)) {
        this.finishOperation("cancelled");
        return this.status();
      }
      this.finishOperation("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async cancelOperation(): Promise<{ cancelled: boolean; operation: OmpEngineOperation | null }> {
    const controller = this.operationController;
    if (!controller || !this.currentOperation || this.currentOperation.state !== "running" || this.currentOperation.progress?.stage === "activate") {
      return { cancelled: false, operation: this.getOperationSnapshot() };
    }
    const settled = this.operationSettled;
    controller.abort(new DOMException("OMP operation cancelled by user", "AbortError"));
    this.currentOperation = { ...this.currentOperation, state: "cancelling", updatedAt: Date.now() };
    await settled;
    return { cancelled: true, operation: this.getOperationSnapshot() };
  }

  private beginOperation(action: OmpEngineOperation["action"]): AbortController {
    if (this.operationController) throw new Error("已有 OMP 引擎操作正在进行");
    const controller = new AbortController();
    const now = Date.now();
    this.operationController = controller;
    this.currentOperation = { state: "running", action, progress: null, startedAt: now, updatedAt: now };
    this.operationSettled = new Promise<void>((resolve) => { this.settleOperation = resolve; });
    return controller;
  }

  private reportProgress(progress: OmpInstallProgress, onProgress?: (progress: OmpInstallProgress) => void): void {
    if (this.currentOperation) {
      this.currentOperation = { ...this.currentOperation, progress, updatedAt: Date.now() };
    }
    onProgress?.(progress);
  }

  private finishOperation(state: OmpEngineOperation["state"], error?: string): void {
    if (this.currentOperation) {
      this.currentOperation = { ...this.currentOperation, state, ...(error ? { error } : {}), updatedAt: Date.now() };
    }
    this.operationController = null;
    this.settleOperation?.();
    this.settleOperation = null;
    this.operationSettled = null;
  }

  private getOperationSnapshot(): OmpEngineOperation | null {
    return this.currentOperation ? { ...this.currentOperation, progress: this.currentOperation.progress ? { ...this.currentOperation.progress } : null } : null;
  }

  private throwIfOperationCancelled(signal: AbortSignal): void {
    signal.throwIfAborted();
  }

  private async isVerifiedInstalledVersion(version: string, binaryAsset: ReleaseAsset, licenseAsset: ReleaseAsset, signal: AbortSignal): Promise<boolean> {
    return this.isVerifiedVersionDirectory(version, this.versionDir(version), binaryAsset, licenseAsset, signal);
  }

  private async findVerifiedStagedVersion(version: string, binaryAsset: ReleaseAsset, licenseAsset: ReleaseAsset, signal: AbortSignal): Promise<string | null> {
    const stagingRoot = join(this.deps.rootDir, "staging");
    let entries;
    try {
      entries = await readdir(stagingRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const candidates = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${version}-`))
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of candidates) {
      this.throwIfOperationCancelled(signal);
      const candidate = join(stagingRoot, entry.name);
      if (await this.isVerifiedVersionDirectory(version, candidate, binaryAsset, licenseAsset, signal)) return candidate;
    }
    return null;
  }

  private async isVerifiedVersionDirectory(version: string, directory: string, binaryAsset: ReleaseAsset, licenseAsset: ReleaseAsset, signal: AbortSignal): Promise<boolean> {
    const binaryPath = join(directory, binaryName(this.deps.platform));
    const licensePath = join(directory, "LICENSE");
    try {
      const [binaryInfo, licenseInfo] = await Promise.all([lstat(binaryPath), lstat(licensePath)]);
      if (!binaryInfo.isFile() || binaryInfo.size !== binaryAsset.size || !licenseInfo.isFile() || licenseInfo.size !== licenseAsset.size) return false;
      if (await sha256File(binaryPath, signal) !== assetDigest(binaryAsset) || await sha256File(licensePath, signal) !== assetDigest(licenseAsset)) return false;
      this.throwIfOperationCancelled(signal);
      if (!this.deps.runVersionCheck) throw new Error("缺少 OMP 二进制版本校验器，无法复用本地版本");
      const reportedVersion = await this.deps.runVersionCheck(binaryPath, signal);
      this.throwIfOperationCancelled(signal);
      return reportedVersion.replace(/^v/, "") === version;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      return false;
    }
  }

  private async activateExistingVersion(version: string, old: ActivePointer | null): Promise<void> {
    const pointer: ActivePointer = {
      version,
      ...(old?.version && old.version !== version ? { previousVersion: old.version } : old?.previousVersion ? { previousVersion: old.previousVersion } : {}),
    };
    await this.writeActivePointer(pointer);
  }

  private async activateStagedVersion(staging: string, version: string, old: ActivePointer | null): Promise<void> {
    const target = this.versionDir(version);
    await mkdir(join(this.deps.rootDir, "versions"), { recursive: true });
    const displaced = `${target}.invalid-${Date.now()}`;
    let movedExisting = false;
    try {
      try {
        await rename(target, displaced);
        movedExisting = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(staging, target);
      const pointer: ActivePointer = {
        version,
        ...(old?.version && old.version !== version ? { previousVersion: old.version } : old?.previousVersion ? { previousVersion: old.previousVersion } : {}),
      };
      await this.writeActivePointer(pointer);
      if (movedExisting) await rm(displaced, { recursive: true, force: true });
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      if (movedExisting) await rename(displaced, target).catch(() => undefined);
      throw error;
    }
  }

  private async writeActivePointer(pointer: ActivePointer): Promise<void> {
    const pointerTemp = `${this.pointerPath}.tmp-${Date.now()}`;
    await writeFile(pointerTemp, `${JSON.stringify(pointer, null, 2)}\n`, { flag: "wx" });
    try {
      await rename(pointerTemp, this.pointerPath);
    } catch (error) {
      await rm(pointerTemp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async rollback(): Promise<ManagedOmpStatus> {
    const current = await this.readPointer();
    if (!current?.previousVersion || !(await this.isInstalled(current.previousVersion))) {
      throw new Error("没有可用的上一版本可回滚");
    }
    const next: ActivePointer = { version: current.previousVersion, previousVersion: current.version };
    const temp = `${this.pointerPath}.tmp-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    await rename(temp, this.pointerPath);
    return this.status();
  }

  async getExecutablePath(): Promise<string | null> {
    const pointer = await this.readPointer();
    if (!pointer || !(await this.isInstalled(pointer.version))) return null;
    return this.executablePath(pointer.version);
  }

  private async isInstalled(version: string): Promise<boolean> {
    try {
      const info = await lstat(this.executablePath(version));
      return info.isFile() && info.size > 0;
    } catch { return false; }
  }

  private async getLatestRelease(signal?: AbortSignal): Promise<{ version: string; assets: ReleaseAsset[] }> {
    const response = await this.fetchImpl(`${RELEASES_API}/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "PI-Desktop" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`读取 OMP 上游版本失败：HTTP ${response.status}`);
    const release = await response.json() as Release;
    if (release.draft || release.prerelease || !Array.isArray(release.assets)) throw new Error("OMP 上游 Release 无效或不是正式版");
    return { version: safeVersion(release.tag_name), assets: release.assets };
  }

  private async getRelease(version: string, signal?: AbortSignal): Promise<{ version: string; assets: ReleaseAsset[] }> {
    const tag = `v${version}`;
    const response = await this.fetchImpl(`${RELEASES_API}/tags/${encodeURIComponent(tag)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "PI-Desktop" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`读取 OMP ${tag} 官方发布信息失败：HTTP ${response.status}`);
    const release = await response.json() as Release;
    if (release.draft || release.prerelease || safeVersion(release.tag_name) !== version || !Array.isArray(release.assets)) {
      throw new Error("本地 OMP 版本与正式上游 Release 不匹配");
    }
    return { version, assets: release.assets };
  }

  private async downloadVerified(asset: ReleaseAsset, maxBytes: number, onProgress?: (downloadedBytes: number, totalBytes: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
    const expected = assetDigest(asset);
    const apiUrl = asset.url ? new URL(asset.url) : null;
    const browserUrl = new URL(asset.browser_download_url);
    const validApiUrl = apiUrl?.protocol === "https:" && apiUrl.hostname === "api.github.com" &&
      new RegExp(`^/repos/${OWNER}/${REPO}/releases/assets/\\d+$`).test(apiUrl.pathname);
    const validBrowserUrl = browserUrl.protocol === "https:" && browserUrl.hostname === "github.com" &&
      browserUrl.pathname.startsWith(`/${OWNER}/${REPO}/releases/download/`);
    if (!validApiUrl && !validBrowserUrl) {
      throw new Error(`拒绝非官方 OMP 下载地址：${asset.name}`);
    }
    // The official Releases API's octet-stream endpoint is more reliable than
    // browser_download_url on Windows TLS stacks and still redirects only to
    // GitHub's signed release object. Fall back only for older metadata with no
    // API asset URL; never follow an arbitrary mirror.
    const url = validApiUrl ? apiUrl! : browserUrl;
    const requestController = new AbortController();
    const forwardAbort = () => requestController.abort(signal?.reason ?? new DOMException("OMP download cancelled", "AbortError"));
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => requestController.abort(new DOMException("OMP download timed out", "TimeoutError")), 180_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          "user-agent": "PI-Desktop",
          ...(validApiUrl ? { accept: "application/octet-stream" } : {}),
        },
        signal: requestController.signal,
      });
      const finalUrl = response.url ? new URL(response.url) : url;
      if (finalUrl.protocol !== "https:" || !new Set([
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
        "github-releases.githubusercontent.com",
      ]).has(finalUrl.hostname)) {
        throw new Error(`OMP 下载被重定向到非官方地址：${asset.name}`);
      }
      const bytes = await responseBytes(response, maxBytes, onProgress, requestController.signal);
      if (await sha256(bytes) !== expected) throw new Error(`OMP 资产 SHA-256 校验失败：${asset.name}`);
      return bytes;
    } catch (error) {
      if (requestController.signal.aborted) throw requestController.signal.reason ?? error;
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }
}
