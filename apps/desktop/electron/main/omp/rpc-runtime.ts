import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { applyProxyToChildEnv } from "../network-proxy";
import { normalizeOmpHostToolRequest, workspacePathFromOmpUri } from "./host-bridge.mjs";
import { normalizeOmpTranscriptSnapshot } from "../../../src/lib/omp-transcript-sync.mjs";
import { OMP_TASK_TOOLS_GUARD_EXTENSION } from "./task-tools-guard.mjs";
import { readOmpProfileSettings } from "./profile-settings.mjs";
import {
  buildModelUnavailableError,
  buildProviderUnavailableError,
  catalogProviders,
  extractRestoreModelFailure,
  isRestoreModelFailure,
  restoreMappedSessionFile,
  selectModelCandidates,
  type OmpModelRef,
} from "./session-model-recovery";

const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024;
const MAX_LOGICAL_FRAME_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
// Provider OAuth may intentionally wait up to five minutes for a browser
// callback/manual code. Do not time out the enclosing login RPC at 60s.
const LOGIN_TIMEOUT_MS = 6 * 60_000;
const NATIVE_AUDIO_TIMEOUT_MS = 10 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const READ_ONLY_DURING_FORK = new Set([
  "get_state", "get_messages", "get_messages_page", "get_entries", "get_tree", "get_branch_messages",
  "get_last_assistant_text", "get_session_stats", "get_available_commands", "get_available_models",
  "get_available_thinking_levels", "get_login_providers", "get_logout_accounts", "get_subagents",
  "get_subagent_messages", "get_btw_history", "get_session_lease",
]);

export type OmpRpcFrame = Record<string, unknown> & { type: string };
export type OmpRpcSessionEvent = { sessionId: string; runId: string; frame: OmpRpcFrame };

type Pending = { resolve: (value: OmpRpcFrame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type RpcSession = {
  sessionId: string;
  runId: string;
  child: ChildProcessWithoutNullStreams;
  stderrBuffer: string;
  bootstrapModelAttempt: boolean;
  bootstrapFallbackRequested: boolean;
  decoder: StringDecoder;
  stdoutBuffer: string;
  pending: Map<string, Pending>;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  nextId: number;
  chunks: { chunkId: string; count: number; byteLength: number; nextIndex: number; data: Buffer[] } | null;
  closing: boolean;
  /** Working directory kept so a stale catalog can be reloaded in place. */
  cwd: string;
  /** Project root is present only for a conversation attached to a local project. */
  workspaceRoot: string | null;
  /** True between `agent_start` and the frame that settles the turn. */
  busy: boolean;
  /** Serializes native session-file switching during a PI-mapped fork. */
  forking: boolean;
  /** Per-process features explicitly advertised by the native RPC ready frame. */
  supportsBashExcludeFromContext: boolean;
  cancelledHostRequestIds: Set<string>;
  hostRequestControllers: Map<string, { controller: AbortController; toolCallId: string }>;
};

export type OmpForkTranscriptSync = {
  parentSessionId: string;
  childSessionId: string;
  /** Exact pre-fork native file, needed if the process dies before paired mapping commit. */
  parentSessionFile?: string;
  createdAt: number;
};

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

function sameNativePath(left: string, right: string): boolean {
  const normalize = (value: string) => resolve(value).replace(/[\\/]+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function frameError(frame: OmpRpcFrame): Error {
  return new Error(typeof frame.error === "string" ? frame.error : `OMP RPC command failed: ${String(frame.command ?? frame.type)}`);
}

function normalizeHostToolResult(value: unknown): {
  ok: boolean;
  error: string;
  text: string;
  result: Record<string, unknown>;
} {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawContent = raw.content;
  const contentObject = rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)
    ? rawContent as Record<string, unknown>
    : null;
  const blocks = Array.isArray(contentObject?.content)
    ? contentObject.content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object" && !Array.isArray(block))
    : Array.isArray(rawContent)
      ? rawContent.filter((block): block is Record<string, unknown> => !!block && typeof block === "object" && !Array.isArray(block))
      : typeof rawContent === "string"
        ? [{ type: "text", text: rawContent }]
        : [];
  const text = blocks.flatMap((block) => typeof block.text === "string" ? [block.text] : []).join("\n");
  const ok = raw.ok !== false && raw.denied !== true && raw.isError !== true;
  const error = text || (typeof raw.error === "string" ? raw.error : "Host tool request failed");
  const result: Record<string, unknown> = {
    content: blocks.length ? blocks : [{ type: "text", text: ok ? "Host tool completed" : error }],
    ...(contentObject && Object.prototype.hasOwnProperty.call(contentObject, "details") ? { details: contentObject.details } : {}),
    ...(typeof contentObject?.isError === "boolean" ? { isError: contentObject.isError } : {}),
  };
  return { ok, error, text, result };
}

/**
 * Owns one official OMP RPC-UI process per PI conversation. OMP remains the
 * execution and persistence authority; this class only transports frames.
 */
export class OmpRpcRuntime {
  private readonly sessions = new Map<string, RpcSession>();
  private readonly starting = new Map<string, Promise<RpcSession>>();
  /** Serializes whole reopen transactions so two picks cannot race the child. */
  private readonly reopening = new Map<string, Promise<void>>();
  /** Desired per-session subagent event level survives OMP RPC process restarts. */
  private readonly subagentSubscriptions = new Map<string, "off" | "events" | "messages">();
  private stopping = false;
  /** Sessions whose model catalog predates a provider/model config change. */
  private readonly staleCatalogs = new Set<string>();
  private mappingWrites: Promise<void> = Promise.resolve();
  private forkSyncWrites: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    rootDir: string;
    manager: { getExecutablePath(): Promise<string | null> };
    emit: (event: OmpRpcSessionEvent) => void;
    log?: (level: "info" | "warn", message: string, data?: unknown) => void;
    spawnProcess?: typeof spawn;
    getCustomModelApiKeys?: () => Promise<Record<string, string>>;
    settingsSessionId?: string;
    executeHostTool?: (input: {
      sessionId: string;
      cwd: string;
      workspaceRoot: string | null;
      requestId: string;
      toolCallId: string;
      toolName: "Read" | "Write" | "Edit";
      args: Record<string, unknown>;
      signal: AbortSignal;
    }) => Promise<unknown>;
  }) {}

  /**
   * Ensure a persisted OMP chat session is connected before a GUI control
   * issues a command. Restored conversations may not have sent a prompt in
   * this Electron lifetime, so renderer-side state reads cannot assume that
   * the per-session RPC child was started by the prompt path.
   */
  async connect(input: { sessionId: string; cwd: string; workspaceRoot?: string }): Promise<void> {
    await this.ensureSession(input);
  }

  /** Reopen a conversation on an explicitly chosen model after a restore failure. */
  async openSessionWithModel(
    input: { sessionId: string; cwd: string; workspaceRoot?: string },
    provider: string,
    modelId: string,
  ): Promise<void> {
    const cleanProvider = provider.trim();
    const cleanModelId = modelId.trim();
    if (!cleanProvider || !cleanModelId || cleanProvider.length > 200 || cleanModelId.length > 512) {
      throw new Error("OMP model override is invalid");
    }
    // The live child pinned the old model at startup; only a fresh process can
    // apply an explicit model to the native session file. The whole sequence
    // (wait for a start, stop, start with the explicit pair) is serialized per
    // session: overlapping picks would otherwise share one `starting` promise
    // and one of them would silently lose.
    const previous = this.reopening.get(input.sessionId);
    const operation = (async () => {
      if (previous) await previous.catch(() => undefined);
      const inFlight = this.starting.get(input.sessionId);
      if (inFlight) await inFlight.catch(() => undefined);
      await this.stop(input.sessionId);
      this.staleCatalogs.delete(input.sessionId);
      await this.ensureSession(input, { provider: cleanProvider, modelId: cleanModelId });
      // Keep the remembered default aligned with the explicit pick so restarting
      // the app reopens this conversation on the model the user chose.
      const profileDir = join(this.options.rootDir, "runtime", "profile");
      await mkdir(profileDir, { recursive: true });
      await writeFile(join(profileDir, "pi-selected-model.json"), JSON.stringify({
        provider: cleanProvider,
        modelId: cleanModelId,
      }), { encoding: "utf8", mode: 0o600 });
    })();
    this.reopening.set(input.sessionId, operation);
    try {
      await operation;
    } finally {
      if (this.reopening.get(input.sessionId) === operation) this.reopening.delete(input.sessionId);
    }
  }

  async attach(input: { sessionId: string; cwd: string; workspaceRoot?: string }, options: { includeMessages?: boolean } = {}): Promise<{ runId: string; state: OmpRpcFrame["data"]; messages: OmpRpcFrame["data"] }> {
    const session = await this.ensureSession(input);
    if (options.includeMessages === false) {
      const state = await this.command(input.sessionId, "get_state");
      return { runId: session.runId, state: state.data, messages: [] };
    }
    const [state, messages] = await Promise.all([
      this.command(input.sessionId, "get_state"),
      this.command(input.sessionId, "get_messages"),
    ]);
    return { runId: session.runId, state: state.data, messages: messages.data };
  }

  async command(sessionId: string, type: string, fields: Record<string, unknown> = {}, timeoutMs = type === "login" ? LOGIN_TIMEOUT_MS : type === "dictation_start" || type === "dictation_stop" ? NATIVE_AUDIO_TIMEOUT_MS : type === "live_start" || type === "live_connect" ? 2 * 60_000 : type === "predict_word" ? 155_000 : REQUEST_TIMEOUT_MS, internalForkCommand = false): Promise<OmpRpcFrame> {
    let session = this.sessions.get(sessionId);
    if (!session || session.closing) throw new Error("OMP 会话尚未连接");
    if (session.forking && !internalForkCommand && !READ_ONLY_DURING_FORK.has(type)) {
      throw new Error("OMP conversation is being forked; try again after it completes");
    }
    // The engine snapshots provider availability when its process starts and
    // never watches models.json or credentials, so a read after a login or a new
    // custom model would otherwise return the pre-change catalog forever.
    if (type === "get_available_models") await this.reloadStaleCatalog(sessionId);
    session = this.sessions.get(sessionId);
    if (!session || session.closing) throw new Error("OMP 会话尚未连接");
    const id = `pi-${session.nextId++}`;
    const response = new Promise<OmpRpcFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`OMP RPC 请求超时：${type}`));
      }, timeoutMs);
      session.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.write(session, { ...fields, id, type });
    } catch (error) {
      const pending = session.pending.get(id);
      if (pending) clearTimeout(pending.timer);
      session.pending.delete(id);
      throw error;
    }
    let frame: OmpRpcFrame;
    try {
      frame = await response;
    } catch (cause) {
      if (type === "login") this.emitLoginFailure(session, cause);
      throw cause;
    }
    if (frame.success === false) {
      const error = frameError(frame);
      if (type === "login") this.emitLoginFailure(session, error);
      throw error;
    }
    if (type === "get_state" && frame.data && typeof frame.data === "object" && !Array.isArray(frame.data)) {
      frame = {
        ...frame,
        data: {
          ...(frame.data as Record<string, unknown>),
          desktopRpcCapabilities: { supportsBashExcludeFromContext: session.supportsBashExcludeFromContext },
        },
      };
    }
    if (type === "set_model" && typeof fields.provider === "string" && typeof fields.modelId === "string") {
      await writeFile(join(this.options.rootDir, "runtime", "profile", "pi-selected-model.json"), JSON.stringify({
        provider: fields.provider,
        modelId: fields.modelId,
      }), { encoding: "utf8", mode: 0o600 });
    }
    if (type === "set_subagent_subscription" &&
        (fields.level === "off" || fields.level === "events" || fields.level === "messages")) {
      this.subagentSubscriptions.set(sessionId, fields.level);
    }
    return frame;
  }

  private sessionMappingsPath(): string {
    return join(this.options.rootDir, "runtime", "session-mappings.json");
  }

  private forkTranscriptSyncPath(): string {
    return join(this.options.rootDir, "runtime", "fork-transcript-sync.json");
  }

  private async readForkTranscriptSyncs(): Promise<OmpForkTranscriptSync[]> {
    try {
      const raw = JSON.parse(await readFile(this.forkTranscriptSyncPath(), "utf8"));
      if (!raw || raw.version !== 1 || !Array.isArray(raw.pending)) throw new Error("OMP fork sync journal has an unsupported format");
      return raw.pending.filter((item: any) => item && typeof item.parentSessionId === "string" && typeof item.childSessionId === "string" && Number.isFinite(item.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeForkTranscriptSyncs(pending: OmpForkTranscriptSync[]): Promise<void> {
    const destination = this.forkTranscriptSyncPath();
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, pending }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async updateForkTranscriptSyncs(update: (pending: OmpForkTranscriptSync[]) => OmpForkTranscriptSync[]): Promise<void> {
    const operation = this.forkSyncWrites.then(async () => this.writeForkTranscriptSyncs(update(await this.readForkTranscriptSyncs())));
    this.forkSyncWrites = operation.catch(() => undefined);
    await operation;
  }

  async beginForkTranscriptSync(parentSessionId: string, childSessionId: string, parentSessionFile?: string): Promise<void> {
    await this.updateForkTranscriptSyncs((pending) => [
      ...pending.filter((item) => item.parentSessionId !== parentSessionId && item.childSessionId !== childSessionId),
      { parentSessionId, childSessionId, ...(parentSessionFile ? { parentSessionFile } : {}), createdAt: Date.now() },
    ]);
  }

  async pendingForkTranscriptSync(sessionId: string): Promise<OmpForkTranscriptSync | null> {
    return (await this.readForkTranscriptSyncs()).find((item) => item.parentSessionId === sessionId || item.childSessionId === sessionId) ?? null;
  }

  async completeForkTranscriptSync(parentSessionId: string, childSessionId: string): Promise<void> {
    await this.updateForkTranscriptSyncs((pending) => pending.filter((item) => item.parentSessionId !== parentSessionId || item.childSessionId !== childSessionId));
  }

  async hasMappedSession(sessionId: string): Promise<boolean> {
    return Boolean(await this.readSessionMapping(sessionId));
  }

  async restoreForkParentMapping(sessionId: string, parentSessionFile: string): Promise<void> {
    await this.updateSessionMappings({ [sessionId]: parentSessionFile });
  }

  private async readSessionMappings(): Promise<Record<string, string>> {
    try {
      const raw = JSON.parse(await readFile(this.sessionMappingsPath(), "utf8"));
      if (!raw || raw.version !== 1 || !raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions)) {
        throw new Error("OMP session mapping file has an unsupported format");
      }
      const mappings: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.sessions)) {
        if (/^[a-f0-9]{32}$/.test(key) && typeof value === "string") mappings[key] = value;
      }
      return mappings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async readSessionMapping(sessionId: string): Promise<string | null> {
    const mappings = await this.readSessionMappings();
    const path = mappings[sessionKey(sessionId)];
    return path ? this.validateMappedSessionFile(path) : null;
  }

  private async validateMappedSessionFile(value: string): Promise<string> {
    if (!isAbsolute(value) || !value.toLowerCase().endsWith(".jsonl")) throw new Error("OMP mapped session path is invalid");
    const sessionsRoot = join(this.options.rootDir, "runtime", "sessions");
    await mkdir(sessionsRoot, { recursive: true });
    const root = await realpath(sessionsRoot);
    const file = await realpath(value);
    const rel = relative(root, file);
    if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error("OMP mapped session escaped its managed session store");
    }
    if (!(await stat(file)).isFile()) throw new Error("OMP mapped session is not a regular file");
    return file;
  }

  private async resolveSessionFile(value: unknown, expectedSessionDir: string): Promise<string> {
    if (typeof value !== "string" || !isAbsolute(value)) throw new Error("OMP did not report a valid native session file");
    const file = await this.validateMappedSessionFile(value);
    const directory = await realpath(expectedSessionDir);
    if (dirname(file).toLowerCase() !== directory.toLowerCase()) throw new Error("OMP native session file is outside the current PI session folder");
    return file;
  }

  private async updateSessionMappings(updates: Record<string, string | null>): Promise<void> {
    const operation = this.mappingWrites.then(async () => {
      const mappings = await this.readSessionMappings();
      for (const [id, path] of Object.entries(updates)) {
        const key = sessionKey(id);
        if (path === null) delete mappings[key];
        else mappings[key] = await this.validateMappedSessionFile(path);
      }
      const destination = this.sessionMappingsPath();
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, sessions: mappings }), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.mappingWrites = operation.catch(() => undefined);
    await operation;
  }

  /**
   * Move the live RPC child back onto the mapped parent file and optionally
   * read the parent transcript from that restored session. The plain switch
   * runs first; the explicit model is only sent when the saved one is proven
   * unrestorable, so a healthy conversation never rewrites its history model.
   */
  private restoreMappedSession(
    sessionId: string,
    sessionFile: string,
    model: OmpModelRef | null = null,
    options: { readMessages?: boolean } = {},
  ): Promise<unknown[]> {
    return restoreMappedSessionFile(
      (type, fields) => type === "switch_session"
        ? this.command(sessionId, "switch_session", fields ?? {}, REQUEST_TIMEOUT_MS, true)
        : this.command(sessionId, type, fields ?? {}),
      sessionFile,
      model,
      options,
      async (state) => sameNativePath(
        await this.resolveSessionFile(
          (state as Record<string, unknown> | undefined)?.sessionFile,
          dirname(sessionFile),
        ),
        sessionFile,
      ),
    );
  }

  private emitLoginFailure(session: RpcSession, cause: unknown): void {
    this.options.emit({
      sessionId: session.sessionId,
      runId: session.runId,
      frame: { type: "login_failed", message: asError(cause).message },
    });
  }

  async prompt(input: { sessionId: string; cwd: string; workspaceRoot?: string; message: string; images?: Array<{ data: string; mimeType: string }>; streamingBehavior?: "steer" | "followUp" }): Promise<{ accepted: boolean; turnId: string }> {
    const session = await this.ensureSession({ sessionId: input.sessionId, cwd: input.cwd, ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}) });
    const images = input.images?.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
    await this.command(input.sessionId, "prompt", {
      message: input.message,
      ...(images?.length ? { images } : {}),
      ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}),
    });
    return { accepted: true, turnId: session.runId };
  }

  async abort(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) return;
    await this.command(sessionId, "abort");
  }

  /**
   * Fork an OMP message into a separate durable PI conversation. OMP's fork
   * command switches the current RPC process to a new session file, so pin
   * both PI ids to their exact native files before restoring the parent. The
   * mapping survives restart and prevents `open_session(sessionDir)` from
   * silently attaching the parent PI chat to the newest forked file.
   */
  async forkToSession(input: { sessionId: string; targetSessionId: string; cwd: string; workspaceRoot?: string; entryId: string }): Promise<{ messages: unknown[]; parentMessages: unknown[] }> {
    const sourceId = input.sessionId;
    const targetId = input.targetSessionId;
    const entryId = input.entryId.trim();
    if (!sourceId || !targetId || sourceId === targetId || !entryId || entryId.length > 512) {
      throw new Error("Invalid OMP fork request");
    }
    const source = await this.ensureSession({ sessionId: sourceId, cwd: input.cwd, ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}) });
    if (source.forking) throw new Error("OMP conversation is already being forked");
    source.forking = true;
    let childFile: string | null = null;
    let originalFile: string | null = null;
    let sourceSessionDir: string | null = null;
    let forkAttempted = false;
    let mappingsPinned = false;
    // The model the conversation is already running on, captured before `fork`
    // moves the process to the child. It is the only safe explicit pair for any
    // later switch back to the parent file.
    let liveModel: OmpModelRef | null = null;
    try {
      if (source.busy || source.pending.size > 0) throw new Error("OMP 会话仍在运行，暂不能分叉");
      const before = await this.command(sourceId, "get_state");
      const beforeData = before.data as Record<string, unknown> | undefined;
      if (beforeData?.isStreaming === true || beforeData?.isCompacting === true || beforeData?.hasPendingAsyncWork === true) {
        throw new Error("OMP 会话仍有未完成工作，暂不能分叉");
      }
      const sourceMapping = await this.readSessionMapping(sourceId);
      sourceSessionDir = sourceMapping
        ? dirname(sourceMapping)
        : join(this.options.rootDir, "runtime", "sessions", sessionKey(sourceId));
      await mkdir(sourceSessionDir, { recursive: true });
      originalFile = await this.resolveSessionFile(beforeData?.sessionFile, sourceSessionDir);
      const hadTargetMapping = await this.readSessionMapping(targetId);
      if (hadTargetMapping) throw new Error("目标 PI 会话已经绑定 OMP 原生历史");

      const liveModelInfo = beforeData?.model as { provider?: unknown; id?: unknown } | undefined;
      liveModel = typeof liveModelInfo?.provider === "string" && typeof liveModelInfo?.id === "string"
        ? { provider: liveModelInfo.provider, modelId: liveModelInfo.id }
        : null;

      await this.beginForkTranscriptSync(sourceId, targetId, originalFile);
      forkAttempted = true;
      const fork = await this.command(sourceId, "fork", { entryId }, REQUEST_TIMEOUT_MS, true);
      const forkData = fork.data as Record<string, unknown> | undefined;
      if (forkData?.cancelled === true) throw new Error("OMP 已取消本次分叉");
      const forkState = await this.command(sourceId, "get_state");
      const forkStateData = forkState.data as Record<string, unknown> | undefined;
      childFile = await this.resolveSessionFile(forkStateData?.sessionFile, sourceSessionDir);
      if (sameNativePath(childFile, originalFile)) throw new Error("OMP 分叉没有生成独立会话文件");
      const childSnapshot = await this.command(sourceId, "get_messages");
      const normalizedChild = normalizeOmpTranscriptSnapshot(childSnapshot.data);
      if (!normalizedChild.ok) throw new Error(`OMP 分叉内容无法安全同步到 PI：${normalizedChild.reason}`);

      // Persist both sides in one atomic map update before reconnecting. The
      // fork file and its session-scoped artifact directory stay together in
      // OMP's own session folder; global content-addressed blobs are unchanged.
      await this.updateSessionMappings({
        [sourceId]: originalFile,
        [targetId]: childFile,
      });
      mappingsPinned = true;
      // Read the parent after switching back: `fork` flushes before it splits,
      // so a pre-fork copy could miss the last flushed writes or a hook edit.
      const parentMessages = await this.restoreMappedSession(sourceId, originalFile, liveModel);
      return { messages: normalizedChild.messages, parentMessages };
    } catch (error) {
      if (mappingsPinned && originalFile) {
        await this.updateSessionMappings({ [sourceId]: originalFile, [targetId]: null }).catch(() => undefined);
      } else if (forkAttempted && originalFile) {
        // Even if writing the paired mapping failed, pin the existing PI
        // conversation back to its original file; otherwise startup might
        // select the newly-created sibling by modification time.
        await this.updateSessionMappings({ [sourceId]: originalFile, [targetId]: null }).catch(() => undefined);
      }
      if (forkAttempted && originalFile && sourceSessionDir && this.sessions.get(sourceId) && !this.sessions.get(sourceId)!.closing) {
        try {
          await this.restoreMappedSession(sourceId, originalFile, liveModel, { readMessages: false });
        } catch {
          // A fresh process reads the persisted parent mapping and repairs an
          // in-memory fork switch without touching either native file. Reopen
          // on the captured live model so a renamed saved model cannot block
          // the rollback either.
          try {
            const cwd = source.cwd;
            await this.stop(sourceId);
            await this.ensureSession({ sessionId: sourceId, cwd }, liveModel ?? undefined);
            const state = await this.command(sourceId, "get_state");
            const stateData = state.data as Record<string, unknown> | undefined;
            if (!sameNativePath(await this.resolveSessionFile(stateData?.sessionFile, sourceSessionDir), originalFile)) throw new Error("restart restored wrong parent");
          } catch (recoveryError) {
            throw new Error(`OMP 分叉失败，且无法自动恢复原会话：${String(recoveryError)}`, { cause: error });
          }
        }
      }
      await this.completeForkTranscriptSync(sourceId, targetId).catch(() => undefined);
      throw error;
    } finally {
      source.forking = false;
    }
  }

  async discardSessionMapping(sessionId: string): Promise<void> {
    if (sessionId) await this.updateSessionMappings({ [sessionId]: null });
  }

  respondExtensionUi(sessionId: string, response: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) throw new Error("OMP RPC 会话尚未连接");
    if (response.type !== "extension_ui_response" || typeof response.id !== "string") {
      throw new Error("Invalid OMP extension UI response");
    }
    this.write(session, response);
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Invalidate every live session's model catalog after provider login,
   * logout, or a custom-model edit. The next `get_available_models` restarts
   * that process instead of returning the catalog it computed at boot.
   *
   * The settings session is included: the "new task" composer reads its
   * catalog, and skipping it made a freshly saved custom service invisible
   * until the app restarted.
   */
  markCatalogStale(): void {
    for (const sessionId of this.sessions.keys()) this.staleCatalogs.add(sessionId);
  }

  private async reloadStaleCatalog(sessionId: string): Promise<void> {
    if (!this.staleCatalogs.has(sessionId)) return;
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) {
      // Nothing live to refresh: the next attach starts with current config.
      this.staleCatalogs.delete(sessionId);
      return;
    }
    // Restarting mid-turn would abort the answer the user is waiting for; keep
    // the marker so the next idle catalog read refreshes.
    if (session.busy || session.forking) return;
    // Provider login/logout holds an in-flight request on the settings session;
    // restarting now would kill the flow the user is in the middle of.
    if (sessionId === this.options.settingsSessionId && session.pending.size > 0) return;
    this.staleCatalogs.delete(sessionId);
    const { cwd, workspaceRoot } = session;
    await this.stop(sessionId);
    await this.ensureSession({ sessionId, cwd, ...(workspaceRoot ? { workspaceRoot } : {}) });
  }

  async stop(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.closing = true;
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("OMP RPC session closed"));
    }
    session.pending.clear();
    session.child.stdin.end();
    await new Promise<void>((resolve) => {
      if (session.child.exitCode !== null) return resolve();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // `child.killed` only means a signal was sent, not that the process
        // exited. Wait for the actual exit after escalation.
        session.child.kill();
        const forceTimer = setTimeout(() => {
          session.child.kill("SIGKILL");
          finish();
        }, SHUTDOWN_TIMEOUT_MS);
        session.child.once("exit", () => { clearTimeout(forceTimer); finish(); });
      }, SHUTDOWN_TIMEOUT_MS);
      session.child.once("exit", finish);
    });
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    return true;
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.starting.values()].map((pending) => pending
      .then((session) => this.stop(session.sessionId))
      .catch(() => undefined)));
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.stop(sessionId)));
  }

  private async ensureSession(
    input: { sessionId: string; cwd: string; workspaceRoot?: string },
    explicitModel?: OmpModelRef,
  ): Promise<RpcSession> {
    const workspaceRoot = input.workspaceRoot ? resolve(input.workspaceRoot) : null;
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      if (explicitModel) throw new Error("OMP 会话仍在运行，无法切换模型；请先停止当前会话");
      if (!sameNativePath(existing.cwd, input.cwd) || (existing.workspaceRoot && workspaceRoot && !sameNativePath(existing.workspaceRoot, workspaceRoot)) || Boolean(existing.workspaceRoot) !== Boolean(workspaceRoot)) {
        throw new Error("OMP conversation workspace changed; reconnect before using this session");
      }
      await existing.ready;
      return existing;
    }
    const inFlight = this.starting.get(input.sessionId);
    if (inFlight) return inFlight;
    if (this.stopping) throw new Error("OMP RPC runtime is shutting down");
    const start = this.startSession(input, false, explicitModel);
    this.starting.set(input.sessionId, start);
    try {
      return await start;
    } finally {
      if (this.starting.get(input.sessionId) === start) this.starting.delete(input.sessionId);
    }
  }

  private async startSession(
    input: { sessionId: string; cwd: string; workspaceRoot?: string },
    bootstrapModelAttempt = false,
    explicitModel?: OmpModelRef,
  ): Promise<RpcSession> {
    const binaryPath = await this.options.manager.getExecutablePath();
    if (!binaryPath) throw new Error("尚未安装或导入已验证的 OMP 引擎");
    const key = sessionKey(input.sessionId);
    const profileDir = join(this.options.rootDir, "runtime", "profile");
    const defaultSessionDir = join(this.options.rootDir, "runtime", "sessions", key);
    const mappedSessionFile = await this.readSessionMapping(input.sessionId);
    const sessionDir = mappedSessionFile ? dirname(mappedSessionFile) : defaultSessionDir;
    await Promise.all([mkdir(profileDir, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
    // Keep this narrowly scoped compatibility guard in PI's OMP profile; do
    // not mutate the user's standalone OMP config or binary. OMP exposes the
    // pre-execution tool_call hook and -e option as its native extension API.
    const extensionDir = join(profileDir, "pi-desktop-extensions");
    const taskToolsGuardPath = join(extensionDir, "task-tools-guard.mjs");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(taskToolsGuardPath, OMP_TASK_TOOLS_GUARD_EXTENSION, { encoding: "utf8", mode: 0o600 });
    let selectedModel: { provider: string; modelId: string } | null = null;
    try {
      const parsed = JSON.parse(await readFile(join(profileDir, "pi-selected-model.json"), "utf8"));
      if (typeof parsed.provider === "string" && typeof parsed.modelId === "string") selectedModel = parsed;
    } catch { /* First OMP GUI launch needs a boot model before RPC login is available. */ }
    const bootstrapMarkerPath = join(profileDir, "pi-rpc-bootstrap.json");
    let bootstrapPending = false;
    try {
      await readFile(bootstrapMarkerPath, "utf8");
      bootstrapPending = true;
    } catch {
      // Preserve an already-configured OMP profile. Only seed an entirely
      // fresh profile, where RPC login would otherwise be unreachable.
      const appManagedEntries = new Set([
        "pi-desktop-extensions",
        "pi-desktop-managed.yml",
        "pi-rpc-bootstrap.json",
        "pi-selected-model.json",
      ]);
      const hasNativeProfileState = (await readdir(profileDir)).some((name) => !appManagedEntries.has(name));
      if (!selectedModel && !hasNativeProfileState) {
        await writeFile(bootstrapMarkerPath, JSON.stringify({ model: "openai/gpt-5.2" }), { encoding: "utf8", mode: 0o600 });
        bootstrapPending = true;
      }
    }
    const profileSettings = await readOmpProfileSettings(profileDir);

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const args = ["--mode", "rpc-ui", "--cwd", input.cwd, "--config", profileSettings.configPath, "--extension", taskToolsGuardPath];
    // OMP refuses to start RPC mode with an empty profile and no selected
    // model, which would make its own login RPC unreachable. Bootstrap only
    // the first GUI run with a known catalog model; users can immediately
    // sign in and choose their native provider/model in the composer picker.
    if (input.sessionId === this.options.settingsSessionId) {
      // Keep provider-management reachable even if the user's remembered chat
      // model is stale or its credential is currently broken.
      args.push("--model", "openai/gpt-5.2");
    } else if (selectedModel) args.push("--model", `${selectedModel.provider}/${selectedModel.modelId}`);
    else if (bootstrapPending || bootstrapModelAttempt) args.push("--model", "openai/gpt-5.2");
    const customKeys = (await this.options.getCustomModelApiKeys?.()) ?? {};
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: profileDir, PI_RPC_EMIT_TITLE: "1" };
    // The engine performs OAuth token exchanges itself; without a proxy env it
    // egresses from the real region while the browser uses the configured one.
    await applyProxyToChildEnv(childEnv);
    // OMP resolves `apiKey` from an exact environment-variable name in models.json.
    // Keep credentials out of disk config, renderer IPC responses and logs.
    for (const name of Object.keys(childEnv)) {
      if (name.startsWith("PI_OMP_CUSTOM_MODEL_API_KEY")) delete childEnv[name];
    }
    Object.assign(childEnv, customKeys);
    const child = (this.options.spawnProcess ?? spawn)(binaryPath, args, {
      cwd: input.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const session: RpcSession = {
      sessionId: input.sessionId,
      runId: randomUUID(),
      child,
      stderrBuffer: "",
      bootstrapModelAttempt,
      bootstrapFallbackRequested: false,
      decoder: new StringDecoder("utf8"),
      stdoutBuffer: "",
      pending: new Map(),
      ready,
      resolveReady,
      rejectReady,
      nextId: 1,
      chunks: null,
      closing: false,
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot ? resolve(input.workspaceRoot) : null,
      busy: false,
      forking: false,
      supportsBashExcludeFromContext: false,
      cancelledHostRequestIds: new Set(),
      hostRequestControllers: new Map(),
    };
    this.sessions.set(input.sessionId, session);
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(session, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = String(chunk);
      session.stderrBuffer = `${session.stderrBuffer}${text}`.slice(-8000);
      if (!bootstrapModelAttempt && !selectedModel && /No default model selected/i.test(session.stderrBuffer)) {
        session.bootstrapFallbackRequested = true;
      }
      this.options.log?.("warn", "OMP RPC stderr", text.slice(-4000));
    });
    child.on("error", (error) => this.failSession(session, error));
    child.on("exit", (code, signal) => {
      const retryingWithBootstrapModel = session.bootstrapFallbackRequested && !session.bootstrapModelAttempt;
      // Settings owns a short-lived process and closes it after every task.
      // A shutdown we initiated (or a clean code-0 exit) is not a runtime
      // failure, so it must not surface as an error toast.
      const expectedExit = session.closing;
      const cleanExit = code === 0 && signal === null && !session.stderrBuffer.trim();
      if (!expectedExit && !retryingWithBootstrapModel) this.options.emit({ sessionId: session.sessionId, runId: session.runId, frame: { type: "process_exit", exitCode: code, signal } });
      const stderr = session.stderrBuffer.trim();
      const detail = stderr ? `\n${stderr}` : "";
      this.failSession(
        session,
        new Error(`OMP RPC process exited (code=${code ?? "null"}, signal=${signal ?? "null"})${detail}`),
        !retryingWithBootstrapModel && !expectedExit && !cleanExit,
      );
      if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
    });
    const timeout = setTimeout(() => session.rejectReady(new Error("OMP RPC ready timeout")), 20_000);
    try {
      await ready;
      // `open_session` restores the model saved in the session file. Naming a
      // provider/model pair makes OMP skip that restore branch entirely, which
      // is the only supported way out of a model that was renamed upstream.
      await this.command(input.sessionId, "open_session", {
        sessionDir,
        ...(explicitModel ? { provider: explicitModel.provider, modelId: explicitModel.modelId } : {}),
      });
      if (mappedSessionFile) {
        // `switch_session` restores the mapped file's saved model exactly like
        // `open_session` does, so the same explicit pair has to ride along or a
        // forked conversation still dies on the renamed model.
        const switched = await this.command(input.sessionId, "switch_session", {
          sessionPath: mappedSessionFile,
          ...(explicitModel ? { provider: explicitModel.provider, modelId: explicitModel.modelId } : {}),
        });
        const switchData = switched.data as Record<string, unknown> | undefined;
        if (switchData?.cancelled === true) throw new Error("OMP cancelled restoring its mapped native session");
        const state = await this.command(input.sessionId, "get_state");
        const stateData = state.data as Record<string, unknown> | undefined;
        if (!sameNativePath(await this.resolveSessionFile(stateData?.sessionFile, sessionDir), mappedSessionFile)) {
          throw new Error("OMP opened a different native session than the durable PI mapping");
        }
      }
      // The renderer implements OMP's structured multi-question `ask` dialog.
      // RPC emits that request only after the host opts in; without this flag
      // extensions silently fall back to other UI paths in headless mode.
      await this.command(input.sessionId, "set_ask_dialog", { enabled: true });
      // Restore the GUI's explicit subscription lease after an OMP process
      // restart. A new session defaults off until the renderer opts in.
      await this.command(input.sessionId, "set_subagent_subscription", {
        level: this.subagentSubscriptions.get(input.sessionId) ?? "off",
      });
      await this.command(input.sessionId, "set_event_filter", { events: null, messageUpdates: "full" });
      return session;
    } catch (error) {
      const retryingWithBootstrapModel = session.bootstrapFallbackRequested && !bootstrapModelAttempt && !selectedModel && !this.stopping;
      // Read the live catalog before the child dies: a validated replacement
      // lets the renderer offer "reopen with this model" instead of trapping
      // the conversation on the same restore failure forever.
      const failure = retryingWithBootstrapModel
        ? null
        : await this.describeSessionOpenFailure(input.sessionId, error).catch(() => null);
      this.sessions.delete(input.sessionId);
      session.closing = true;
      child.kill();
      if (retryingWithBootstrapModel) {
        this.options.log?.("info", "OMP has no default model; retrying RPC startup with the GUI bootstrap model");
        return this.startSession(input, true, explicitModel);
      }
      throw failure ?? error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Convert an `open_session` failure into a structured recovery error.
   *
   * The catalog read must happen while the child is still alive, so this is
   * called from the start failure path before the process is killed. A failed
   * catalog read still produces MODEL_UNAVAILABLE with an empty candidate list:
   * the renderer can then offer a manual pick instead of a dead end.
   */
  private async describeSessionOpenFailure(sessionId: string, error: unknown): Promise<Error | null> {
    const message = asError(error).message;
    if (!isRestoreModelFailure(message)) return null;
    // A catalog read on a stale session normally restarts the child; doing that
    // here would recurse into this same failure path.
    this.staleCatalogs.delete(sessionId);
    let catalog: unknown = null;
    try {
      // A recovery lookup must not inherit the full 60s command budget: the
      // session is already failing, and the user is waiting for an action.
      catalog = (await this.command(sessionId, "get_available_models", {}, 5_000)).data;
    } catch {
      // The engine may have exited during the failed open; keep the structured
      // error even when the catalog is unavailable.
    }
    const providers = catalogProviders(catalog);
    const ref = extractRestoreModelFailure(message, providers);
    if (!ref) return null;
    if (providers.length > 0 && !providers.includes(ref.provider)) {
      return buildProviderUnavailableError(ref);
    }
    return buildModelUnavailableError(ref, selectModelCandidates(catalog, ref.provider));
  }

  private write(session: RpcSession, frame: Record<string, unknown>): void {
    if (session.child.stdin.destroyed || session.child.killed || session.closing) throw new Error("OMP RPC process is unavailable");
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_PHYSICAL_FRAME_BYTES) throw new Error("OMP RPC request exceeds the physical frame limit");
    session.child.stdin.write(line);
  }

  private onStdout(session: RpcSession, chunk: Buffer): void {
    session.stdoutBuffer += session.decoder.write(chunk);
    for (;;) {
      const newline = session.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = session.stdoutBuffer.slice(0, newline);
      session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") + 1 > MAX_PHYSICAL_FRAME_BYTES) {
        this.failSession(session, new Error("OMP RPC frame exceeds advertised physical limit"));
        return;
      }
      let frame: OmpRpcFrame;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as any).type !== "string") throw new Error("invalid frame shape");
        frame = parsed as OmpRpcFrame;
      } catch (error) {
        this.options.log?.("warn", "Invalid OMP RPC JSONL frame", String(error));
        continue;
      }
      this.trackTurnState(session, frame);
      if (frame.type === "rpc_chunk") {
        this.consumeChunk(session, frame);
        continue;
      }
      if (frame.type === "ready") {
        session.supportsBashExcludeFromContext = frame.supportsBashExcludeFromContext === true;
        const supported = Array.isArray(frame.supportedProtocolVersions) ? frame.supportedProtocolVersions : [];
        if (supported.includes(2)) {
          void this.command(session.sessionId, "negotiate_protocol", { protocolVersion: 2 })
            .then(() => this.registerHostCapabilities(session))
            .then(() => session.resolveReady())
            .catch((error) => session.rejectReady(asError(error)));
        } else void this.registerHostCapabilities(session).then(() => session.resolveReady()).catch((error) => session.rejectReady(asError(error)));
        continue;
      }
      if (frame.type === "host_tool_call" || frame.type === "host_uri_request") {
        void this.handleHostRequest(session, frame);
        continue;
      }
      if (frame.type === "host_tool_cancel" || frame.type === "host_uri_cancel") {
        if (typeof frame.targetId === "string") this.cancelHostRequest(session, frame.targetId);
        continue;
      }
      if (frame.type === "response" && typeof frame.id === "string") {
        const pending = session.pending.get(frame.id);
        if (pending) {
          clearTimeout(pending.timer);
          session.pending.delete(frame.id);
          pending.resolve(frame);
          continue;
        }
      }
      this.options.emit({ sessionId: session.sessionId, runId: session.runId, frame });
    }
    if (Buffer.byteLength(session.stdoutBuffer, "utf8") > MAX_PHYSICAL_FRAME_BYTES) this.failSession(session, new Error("OMP RPC line exceeded physical frame limit"));
  }

  private trackTurnState(session: RpcSession, frame: OmpRpcFrame): void {
    if (frame.type === "agent_start") session.busy = true;
    else if (frame.type === "session_settled" || frame.type === "runtime_error") session.busy = false;
    // Mirror the transcript's own settle rule: a prompt result only ends the
    // turn when the session reports that nothing else is queued.
    else if (frame.type === "prompt_result" && (frame.status !== "completed" || frame.sessionSettled !== false)) session.busy = false;
  }

  private consumeChunk(session: RpcSession, frame: OmpRpcFrame): void {
    const chunkId = frame.chunkId;
    const index = frame.index;
    const count = frame.count;
    const byteLength = frame.byteLength;
    const data = frame.data;
    if (typeof chunkId !== "string" || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) || typeof data !== "string") {
      this.failSession(session, new Error("Malformed OMP RPC v2 chunk")); return;
    }
    if ((count as number) < 1 || (count as number) > MAX_LOGICAL_FRAME_BYTES ||
      (index as number) < 0 || (index as number) >= (count as number) ||
      (byteLength as number) < 0 || (byteLength as number) > MAX_LOGICAL_FRAME_BYTES ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      this.failSession(session, new Error("Invalid OMP RPC chunk bounds or base64")); return;
    }
      if ((index as number) === 0) {
      if (session.chunks || (byteLength as number) < 0 || (byteLength as number) > MAX_LOGICAL_FRAME_BYTES || (count as number) < 1) {
        this.failSession(session, new Error("Invalid or interleaved OMP RPC chunk sequence")); return;
      }
      session.chunks = { chunkId, count: count as number, byteLength: byteLength as number, nextIndex: 0, data: [] };
    }
    const sequence = session.chunks;
    if (!sequence || sequence.chunkId !== chunkId || sequence.count !== count || sequence.byteLength !== byteLength || sequence.nextIndex !== index) {
      this.failSession(session, new Error("Interrupted or out-of-order OMP RPC chunk sequence")); return;
    }
    let bytes: Buffer;
    try { bytes = Buffer.from(data, "base64"); } catch { this.failSession(session, new Error("Invalid OMP RPC chunk base64")); return; }
    sequence.data.push(bytes);
    sequence.nextIndex += 1;
    if (sequence.nextIndex !== sequence.count) return;
    const assembled = Buffer.concat(sequence.data);
    session.chunks = null;
    if (assembled.byteLength !== sequence.byteLength || assembled.byteLength > MAX_LOGICAL_FRAME_BYTES) {
      this.failSession(session, new Error("OMP RPC chunk reassembly length mismatch")); return;
    }
    try {
      const json = new TextDecoder("utf-8", { fatal: true }).decode(assembled);
      const inner = JSON.parse(json) as OmpRpcFrame;
      if (!inner || typeof inner.type !== "string" || inner.type === "rpc_chunk") throw new Error("invalid logical frame");
      if (inner.type === "host_tool_call" || inner.type === "host_uri_request") {
        void this.handleHostRequest(session, inner);
        return;
      }
      if (inner.type === "host_tool_cancel" || inner.type === "host_uri_cancel") {
        if (typeof inner.targetId === "string") this.cancelHostRequest(session, inner.targetId);
        return;
      }
      if (inner.type === "response" && typeof inner.id === "string") {
        const pending = session.pending.get(inner.id);
        if (pending) { clearTimeout(pending.timer); session.pending.delete(inner.id); pending.resolve(inner); return; }
      }
      this.options.emit({ sessionId: session.sessionId, runId: session.runId, frame: inner });
    } catch (error) { this.failSession(session, new Error(`Invalid reassembled OMP RPC frame: ${String(error)}`)); }
  }

  /** Register a project-scoped bridge through Host Core's normal tool policy. */
  private async registerHostCapabilities(session: RpcSession): Promise<void> {
    if (session.sessionId === this.options.settingsSessionId || !this.options.executeHostTool || !session.workspaceRoot) return;
    const results = await Promise.allSettled([
      this.command(session.sessionId, "set_host_tools", { tools: [{
        name: "pi_read_workspace_file",
        label: "Read workspace file",
        description: "Read a text file inside the current project workspace. The host applies its standard permission checks.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative path inside the current project" } },
          required: ["path"],
          additionalProperties: false,
        },
      }, {
        name: "pi_write_workspace_file",
        label: "Write workspace file",
        description: "Create or replace a text file inside the current project workspace. The host applies its standard permission checks.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path inside the current project" },
            content: { type: "string", description: "Complete replacement content" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      }, {
        name: "pi_edit_workspace_file",
        label: "Edit workspace file",
        description: "Replace an exact text range inside a file in the current project workspace. The host applies its standard permission checks.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path inside the current project" },
            oldText: { type: "string", description: "Exact text to replace" },
            newText: { type: "string", description: "Replacement text" },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
      }] }),
      this.command(session.sessionId, "set_host_uri_schemes", { schemes: [{
        scheme: "pi-workspace",
        description: "Text files in the current OMP project workspace. Reads and writes are checked by the PI Host permission system.",
        writable: true,
        immutable: false,
      }] }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") this.options.log?.("warn", "OMP host bridge registration unavailable", String(result.reason));
    }
  }

  private async handleHostRequest(session: RpcSession, frame: OmpRpcFrame): Promise<void> {
    if (typeof frame.id !== "string" || session.closing || this.sessions.get(session.sessionId) !== session) return;
    if (!this.options.executeHostTool || session.sessionId === this.options.settingsSessionId || !session.workspaceRoot) {
      this.rejectHostRequest(session, frame, "Host workspace tools are unavailable for this OMP session");
      return;
    }
    const uriRequest = frame.type === "host_uri_request";
    const hostToolRequestId = typeof frame.id === "string" ? frame.id : "";
    const toolCallId = typeof frame.toolCallId === "string" && frame.toolCallId.trim()
      ? frame.toolCallId
      : `${uriRequest ? "omp-uri" : "omp-host"}:${hostToolRequestId}`;
    const controller = new AbortController();
    session.hostRequestControllers.set(hostToolRequestId, { controller, toolCallId });
    try {
      let hostRequest: { toolName: "Read" | "Write" | "Edit"; args: Record<string, unknown> };
      if (uriRequest) {
        if (frame.operation !== "read" && frame.operation !== "write") throw new Error("Unsupported workspace URI operation");
        const path = workspacePathFromOmpUri(frame.url);
        hostRequest = normalizeOmpHostToolRequest(frame.operation === "read" ? "pi_read_workspace_file" : "pi_write_workspace_file", {
          path,
          ...(frame.operation === "write" ? { content: frame.content } : {}),
        });
      } else {
        hostRequest = normalizeOmpHostToolRequest(frame.toolName, frame.arguments);
      }
      const result = await this.options.executeHostTool({
        sessionId: session.sessionId,
        cwd: session.cwd,
        workspaceRoot: session.workspaceRoot,
        requestId: hostToolRequestId,
        toolCallId,
        toolName: hostRequest.toolName,
        args: hostRequest.args,
        signal: controller.signal,
      });
      if (controller.signal.aborted || session.closing || this.sessions.get(session.sessionId) !== session) return;
      if (uriRequest) {
        const normalized = normalizeHostToolResult(result);
        if (!normalized.ok) {
          this.write(session, { type: "host_uri_result", id: frame.id, isError: true, error: normalized.error });
        } else if (hostRequest.toolName === "Read") {
          this.write(session, { type: "host_uri_result", id: frame.id, content: normalized.text, contentType: "text/plain", immutable: false });
        } else {
          this.write(session, { type: "host_uri_result", id: frame.id });
        }
      } else {
        const normalized = normalizeHostToolResult(result);
        this.write(session, {
          type: "host_tool_result",
          id: frame.id,
          ...(normalized.ok ? {} : { isError: true }),
          result: normalized.result,
        });
      }
    } catch (error) {
      if (controller.signal.aborted || session.closing || this.sessions.get(session.sessionId) !== session) return;
      this.rejectHostRequest(session, frame, error instanceof Error ? error.message : String(error));
    } finally {
      session.hostRequestControllers.delete(hostToolRequestId);
      session.cancelledHostRequestIds.delete(hostToolRequestId);
    }
  }

  private rejectHostRequest(session: RpcSession, frame: OmpRpcFrame, message: string): void {
    if (typeof frame.id !== "string") return;
    if (frame.type === "host_tool_call") {
      this.write(session, { type: "host_tool_result", id: frame.id, isError: true, result: { content: [{ type: "text", text: message }] } });
    } else {
      this.write(session, { type: "host_uri_result", id: frame.id, isError: true, error: message });
    }
  }

  private cancelHostRequest(session: RpcSession, targetId: string): void {
    session.cancelledHostRequestIds.add(targetId);
    const active = session.hostRequestControllers.get(targetId);
    if (active) active.controller.abort(new DOMException("OMP host request cancelled", "AbortError"));
  }

  private failSession(session: RpcSession, error: unknown, emitRuntimeError = true): void {
    const failure = asError(error);
    session.rejectReady(failure);
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(failure); }
    session.pending.clear();
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
    if (emitRuntimeError) this.options.emit({ sessionId: session.sessionId, runId: session.runId, frame: { type: "runtime_error", message: failure.message } });
  }
}
