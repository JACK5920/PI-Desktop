import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { applyProxyToChildEnv } from "../network-proxy";
import { normalizeOmpHostToolRequest, workspacePathFromOmpUri } from "./host-bridge.mjs";
import { normalizeOmpTranscriptSnapshot } from "../../../src/lib/omp-transcript-sync.mjs";
import { describeOmpNativeLegacyLookup, describeOmpNativePromptMappingSkip, findNewOmpNativeUserEntryId, findOmpNativeTreeEntry, resolveOmpNativeMessageEntryId } from "./history-entry.mjs";
import { OMP_TASK_TOOLS_GUARD_EXTENSION } from "./task-tools-guard.mjs";
import { readOmpProfileSettings } from "./profile-settings.mjs";
import {
  parseOmpLocalSpillRef,
  readOmpNativeSessionId,
  resolveOmpLocalSpillFile,
  resolveOmpLocalSpillRoot,
} from "./local-spill-ref.mjs";
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
  /** Short-lived lock while an idle prompt is paired with its native tree entry. */
  mappingPrompt: boolean;
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
  /** Serializes prompt admission and native-message identity capture per chat. */
  private readonly promptAdmissions = new Map<string, Promise<void>>();
  /** Desired per-session subagent event level survives OMP RPC process restarts. */
  private readonly subagentSubscriptions = new Map<string, "off" | "events" | "messages">();
  private stopping = false;
  /** Sessions whose model catalog predates a provider/model config change. */
  private readonly staleCatalogs = new Set<string>();
  private mappingWrites: Promise<void> = Promise.resolve();
  private nativeMessageMappingWrites: Promise<void> = Promise.resolve();
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

  private async withPromptAdmission<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.promptAdmissions.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.promptAdmissions.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.promptAdmissions.get(sessionId) === tail) this.promptAdmissions.delete(sessionId);
    }
  }

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

  /** Resolve OMP's session-owned local spill store without accepting a renderer path. */
  async resolveLocalSpill(input: {
    sessionId: string;
    cwd: string;
    workspaceRoot?: string;
    ref?: string;
  }): Promise<{ root: string; absolutePath?: string; relativePath?: string; id?: number } | null> {
    if (input.ref !== undefined && parseOmpLocalSpillRef(input.ref) === null) return null;
    await this.ensureSession(input);
    const state = await this.command(input.sessionId, "get_state");
    const stateData = state.data && typeof state.data === "object" && !Array.isArray(state.data)
      ? state.data as Record<string, unknown>
      : {};
    const mappedSessionFile = await this.readSessionMapping(input.sessionId);
    const expectedSessionDir = mappedSessionFile
      ? dirname(mappedSessionFile)
      : join(this.options.rootDir, "runtime", "sessions", sessionKey(input.sessionId));
    const sessionFile = await this.resolveSessionFile(stateData.sessionFile, expectedSessionDir);
    const nativeSessionId = await readOmpNativeSessionId(sessionFile);
    const root = await resolveOmpLocalSpillRoot({ sessionFile, nativeSessionId });
    if (!root) return null;
    if (input.ref === undefined) return { root };
    const file = await resolveOmpLocalSpillFile({ sessionFile, nativeSessionId, ref: input.ref });
    return file ? file : null;
  }

  async command(sessionId: string, type: string, fields: Record<string, unknown> = {}, timeoutMs = type === "login" ? LOGIN_TIMEOUT_MS : type === "dictation_start" || type === "dictation_stop" ? NATIVE_AUDIO_TIMEOUT_MS : type === "live_start" || type === "live_connect" ? 2 * 60_000 : type === "predict_word" ? 155_000 : REQUEST_TIMEOUT_MS, internalForkCommand = false): Promise<OmpRpcFrame> {
    let session = this.sessions.get(sessionId);
    if (!session || session.closing) throw new Error("OMP 会话尚未连接");
    if (session.forking && !internalForkCommand && !READ_ONLY_DURING_FORK.has(type)) {
      throw new Error("OMP conversation is being forked; try again after it completes");
    }
    if (session.mappingPrompt && !internalForkCommand && !READ_ONLY_DURING_FORK.has(type)) {
      throw new Error("OMP prompt identity is being synchronized; try again after it completes");
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
      const selectedModel: Record<string, string> = {
        provider: fields.provider,
        modelId: fields.modelId,
      };
      // The settings-only picker represents the next new chat. OMP quick roles
      // are intentionally session-scoped by the engine, so persist them only as
      // the GUI's one-shot new-chat choice; changing an existing chat's model
      // must not silently change the next conversation's role.
      if (sessionId === this.options.settingsSessionId) {
        if (typeof fields.role === "string" && fields.role.trim().length > 0 && fields.role.length <= 80) {
          selectedModel.role = fields.role.trim();
        }
        const thinkingLevels = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
        if (typeof fields.thinkingLevel === "string" && thinkingLevels.has(fields.thinkingLevel)) {
          selectedModel.thinkingLevel = fields.thinkingLevel;
        }
      }
      await writeFile(join(this.options.rootDir, "runtime", "profile", "pi-selected-model.json"), JSON.stringify(selectedModel), { encoding: "utf8", mode: 0o600 });
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

  private nativeMessageMappingsPath(): string {
    return join(this.options.rootDir, "runtime", "native-message-mappings.json");
  }

  private async readNativeMessageMappings(): Promise<Record<string, Record<string, string>>> {
    try {
      const raw = JSON.parse(await readFile(this.nativeMessageMappingsPath(), "utf8"));
      if (!raw || raw.version !== 1 || !raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions)) {
        throw new Error("OMP native message mapping file has an unsupported format");
      }
      const sessions: Record<string, Record<string, string>> = {};
      for (const [key, value] of Object.entries(raw.sessions)) {
        if (!/^[a-f0-9]{32}$/.test(key) || !value || typeof value !== "object" || Array.isArray(value)) continue;
        const messages: Record<string, string> = {};
        for (const [messageId, entryId] of Object.entries(value)) {
          if (typeof messageId === "string" && messageId.length > 0 && messageId.length <= 160 &&
            typeof entryId === "string" && entryId.length > 0 && entryId.length <= 512) {
            messages[messageId] = entryId;
          }
        }
        sessions[key] = messages;
      }
      return sessions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async readNativeMessageEntryId(sessionId: string, messageId: string): Promise<string | null> {
    const sessions = await this.readNativeMessageMappings();
    return sessions[sessionKey(sessionId)]?.[messageId] ?? null;
  }

  private async updateNativeMessageEntryId(sessionId: string, messageId: string, entryId: string): Promise<void> {
    if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId) ||
      !entryId || entryId.length > 512) {
      throw new Error("OMP native message mapping identity is invalid");
    }
    const operation = this.nativeMessageMappingWrites.then(async () => {
      const sessions = await this.readNativeMessageMappings();
      const key = sessionKey(sessionId);
      const messages = sessions[key] ?? {};
      const existing = messages[messageId];
      if (existing && existing !== entryId) throw new Error("OMP native message mapping cannot be reassigned");
      const conflictingMessageId = Object.entries(messages).find(([candidateMessageId, candidateEntryId]) =>
        candidateMessageId !== messageId && candidateEntryId === entryId,
      )?.[0];
      if (conflictingMessageId) throw new Error("OMP native message mapping must be one-to-one");
      messages[messageId] = entryId;
      const messageIds = Object.keys(messages);
      if (messageIds.length > 50_000) {
        for (const expired of messageIds.slice(0, messageIds.length - 50_000)) delete messages[expired];
      }
      sessions[key] = messages;
      const destination = this.nativeMessageMappingsPath();
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, sessions }), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.nativeMessageMappingWrites = operation.catch(() => undefined);
    await operation;
  }

  private async readTreeForMessageMapping(sessionId: string): Promise<unknown | null> {
    try {
      const result = await this.command(sessionId, "get_tree");
      return result.data ?? null;
    } catch (error) {
      this.options.log?.("warn", "OMP prompt baseline tree could not be read; this message will not get a native edit mapping", {
        sessionId,
        data: String(error),
      });
      return null;
    }
  }

  private async rememberAcceptedNativeUserMessage(input: {
    sessionId: string;
    messageId: string;
    message: string;
    imageCount: number;
    beforeTreeSnapshot: unknown;
  }): Promise<void> {
    if (!input.beforeTreeSnapshot || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.messageId)) return;
    try {
      // OMP appends the user node only when it builds the provider request;
      // measured cold-start trails the accepted RPC by 3-4s, so a ~1s poll
      // missed every turn. Back off up to ~21s and keep the last snapshot for
      // logs. Stop early once the turn settled: a settled turn necessarily
      // already contains its user node, so further polling cannot succeed.
      const retryDelaysMs = [50, 100, 200, 300, 500, 800, 1200, 1800, 2500, 3500, 4500, 6000];
      const session = this.sessions.get(input.sessionId);
      let lastTree: unknown = null;
      let sawBusy = false;
      let attempts = 0;
      for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
        const after = await this.command(input.sessionId, "get_tree");
        lastTree = after.data ?? null;
        attempts = attempt + 1;
        const entryId = findNewOmpNativeUserEntryId({
          beforeTreeSnapshot: input.beforeTreeSnapshot,
          afterTreeSnapshot: after.data,
          expectedText: input.message,
          expectedImageCount: input.imageCount,
        });
        if (entryId) {
          await this.updateNativeMessageEntryId(input.sessionId, input.messageId, entryId);
          return;
        }
        if (session) {
          if (session.busy) sawBusy = true;
          else if (sawBusy) break;
        }
        if (attempt < retryDelaysMs.length - 1) await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      }
      const beforeIds = new Set<string>();
      const collectUserEntries = (nodes: unknown, out: Array<Record<string, unknown>>) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
          const entry = (node as Record<string, unknown> | null)?.entry as Record<string, unknown> | undefined;
          if (entry && typeof entry.id === "string") {
            const message = entry.message as Record<string, unknown> | undefined;
            const textLength = typeof message?.content === "string"
              ? message.content.length
              : Array.isArray(message?.content)
                ? (message.content as Array<Record<string, unknown>>)
                  .filter((block) => block?.type === "text")
                  .reduce((sum, block) => sum + String(block.text ?? "").length, 0)
                : -1;
            out.push({ id: entry.id, textLength });
          }
          collectUserEntries((node as Record<string, unknown> | null)?.children, out);
        }
      };
      const beforeEntries: Array<Record<string, unknown>> = [];
      collectUserEntries((input.beforeTreeSnapshot as Record<string, unknown> | null)?.tree, beforeEntries);
      for (const entry of beforeEntries) beforeIds.add(String(entry.id));
      const afterEntries: Array<Record<string, unknown>> = [];
      collectUserEntries((lastTree as Record<string, unknown> | null)?.tree, afterEntries);
      // Only the delta is useful: it shows whether OMP appended a node at all
      // and whether its stored text length diverges from the submitted prompt.
      const newEntries = afterEntries.filter((entry) => !beforeIds.has(String(entry.id))).slice(-5);
      this.options.log?.("warn", "OMP accepted a user prompt but its new native entry could not be uniquely mapped; historical editing will fail closed", {
        sessionId: input.sessionId,
        messageId: input.messageId,
        data: JSON.stringify({
          textLength: input.message.length,
          imageCount: input.imageCount,
          attempts,
          leafId: (lastTree as Record<string, unknown> | null)?.leafId ?? null,
          newEntries,
        }),
      });
    } catch (error) {
      this.options.log?.("warn", "OMP user prompt was accepted but its native message mapping could not be persisted", {
        sessionId: input.sessionId,
        messageId: input.messageId,
        data: String(error),
      });
    }
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
    // OMP's native `branch` command can place a newly-created branch under
    // its profile-owned `sessions` tree, even when the active chat was opened
    // from PI's per-chat session directory. Both locations remain inside the
    // isolated OMP runtime; arbitrary profile files and external paths do not.
    const managedSessionRoots = [
      join(this.options.rootDir, "runtime", "sessions"),
      join(this.options.rootDir, "runtime", "profile", "sessions"),
    ];
    await Promise.all(managedSessionRoots.map((root) => mkdir(root, { recursive: true })));
    const roots = await Promise.all(managedSessionRoots.map((root) => realpath(root)));
    const file = await realpath(value);
    const isInsideManagedRoot = roots.some((root) => {
      const rel = relative(root, file);
      return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
    });
    if (!isInsideManagedRoot) {
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

  private async resolveTransitionSessionFile(value: unknown, expectedSessionDir: string): Promise<string> {
    if (typeof value !== "string" || !isAbsolute(value)) throw new Error("OMP did not report a valid native session file");
    const file = await this.validateMappedSessionFile(value);
    const directory = await realpath(expectedSessionDir);
    if (dirname(file).toLowerCase() === directory.toLowerCase()) return file;

    // OMP owns the destination of its native branch operation. Permit the
    // alternate profile session store only for this transition result, then
    // pin the exact file in PI's durable session map. Reconnects still require
    // the mapped file's exact parent directory and all paths remain below the
    // managed runtime roots checked above.
    const profileSessionsRoot = join(this.options.rootDir, "runtime", "profile", "sessions");
    await mkdir(profileSessionsRoot, { recursive: true });
    const root = await realpath(profileSessionsRoot);
    const rel = relative(root, file);
    if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error("OMP native session transition is outside the current PI session folder");
    }
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

  async prompt(input: {
    sessionId: string;
    cwd: string;
    workspaceRoot?: string;
    message: string;
    messageId?: string;
    commandType?: "prompt" | "steer";
    images?: Array<{ data: string; mimeType: string }>;
    streamingBehavior?: "steer" | "followUp";
  }): Promise<{ accepted: boolean; turnId: string }> {
    return this.withPromptAdmission(input.sessionId, async () => {
      const session = await this.ensureSession({ sessionId: input.sessionId, cwd: input.cwd, ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}) });
      if (session.forking) throw new Error("OMP conversation history is being edited; try again after it settles");
      const commandType = input.commandType ?? "prompt";
      const images = input.images?.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
      let beforeTreeSnapshot: unknown = null;
      let ownsMappingLock = false;
      if (input.messageId && commandType === "prompt") {
        const baseSkipReason = describeOmpNativePromptMappingSkip({
          messageId: input.messageId,
          commandType,
          streamingBehavior: input.streamingBehavior,
          sessionBusy: session.busy,
          pendingCommandCount: session.pending.size,
        });
        if (baseSkipReason) {
          this.options.log?.("info", "OMP native prompt mapping skipped", {
            sessionId: input.sessionId,
            messageId: input.messageId,
            data: baseSkipReason,
          });
        } else {
          try {
            const stateResult = await this.command(input.sessionId, "get_state");
            if (session.forking) throw new Error("OMP conversation history is being edited; try again after it settles");
            if (!stateResult.data || typeof stateResult.data !== "object") {
              this.options.log?.("warn", "OMP native prompt mapping skipped", {
                sessionId: input.sessionId,
                messageId: input.messageId,
                data: "native-state-unreadable",
              });
            } else {
              const nativeState = stateResult.data as Record<string, unknown>;
              const skipReason = describeOmpNativePromptMappingSkip({
                messageId: input.messageId,
                commandType,
                streamingBehavior: input.streamingBehavior,
                sessionBusy: session.busy,
                pendingCommandCount: session.pending.size,
                nativeState,
              });
              if (!skipReason) {
                // Block other history-changing RPC commands until this immediate
                // prompt's native entry is captured (or proven unavailable).
                session.mappingPrompt = true;
                ownsMappingLock = true;
                beforeTreeSnapshot = await this.readTreeForMessageMapping(input.sessionId);
              } else {
                this.options.log?.("info", "OMP native prompt mapping skipped", {
                  sessionId: input.sessionId,
                  messageId: input.messageId,
                  data: skipReason,
                });
              }
            }
          } catch (error) {
            this.options.log?.("warn", "OMP prompt identity capture was skipped because idle state could not be confirmed", {
              sessionId: input.sessionId,
              messageId: input.messageId,
              data: String(error),
            });
          }
        }
      }
      try {
        await this.command(input.sessionId, commandType, {
          message: input.message,
          ...(images?.length ? { images } : {}),
          ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}),
        }, REQUEST_TIMEOUT_MS, ownsMappingLock);
        if (input.messageId && beforeTreeSnapshot) {
          await this.rememberAcceptedNativeUserMessage({
            sessionId: input.sessionId,
            messageId: input.messageId,
            message: input.message,
            imageCount: images?.length ?? 0,
            beforeTreeSnapshot,
          });
        }
        return { accepted: true, turnId: session.runId };
      } finally {
        if (ownsMappingLock) session.mappingPrompt = false;
      }
    });
  }

  /**
   * Replace an OMP user prompt in the same native session by navigating to its
   * parent and submitting the edited prompt. OMP retains the old node as a
   * sibling; the PI transcript mirror follows the new active branch. The
   * caller supplies Host persistence callbacks so the branch snapshot and new
   * user message are written in the same main-process turn admission.
   */
  async promptFromMessage(input: {
    sessionId: string;
    cwd: string;
    workspaceRoot?: string;
    messageId: string;
    newMessageId?: string;
    /** Original text and timestamp of the row being edited, used only to rebuild a missing native mapping. */
    originalText?: string;
    originalTimestamp?: number;
    message: string;
    images?: Array<{ data: string; mimeType: string }>;
    replaceTranscript: (sessionId: string, messages: unknown[]) => Promise<unknown>;
    persistUserMessage: () => Promise<void>;
  }): Promise<{ accepted: boolean; turnId: string }> {
    const messageId = input.messageId.trim();
    if (!input.sessionId || !messageId || messageId.length > 160 || typeof input.message !== "string" ||
      (input.newMessageId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.newMessageId)) ||
      typeof input.replaceTranscript !== "function" || typeof input.persistUserMessage !== "function") {
      throw new Error("Invalid OMP historical prompt edit request");
    }
    return this.withPromptAdmission(input.sessionId, async () => {
      const session = await this.ensureSession({
        sessionId: input.sessionId,
        cwd: input.cwd,
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      });
      if (session.forking) throw new Error("OMP conversation is already changing history");
      session.forking = true;
      let originalLeafId: string | null = null;
      let originalMessages: unknown[] | null = null;
      let selectedParentId: string | null = null;
      let navigationMayHaveStarted = false;
      let transcriptReplacementStarted = false;
      let userMessagePersistenceStarted = false;
      let promptWasSent = false;
      let promptBaselineTree: unknown = null;
      let promptImageCount = 0;
      try {
      if (session.busy || session.pending.size > 0) {
        throw Object.assign(new Error("OMP 会话仍有未完成工作，暂不能编辑旧消息"), { errorCode: "AGENT_BUSY" });
      }
      const stateResult = await this.command(input.sessionId, "get_state");
      const state = stateResult.data && typeof stateResult.data === "object" ? stateResult.data as Record<string, unknown> : {};
      if (state.isStreaming === true || state.isCompacting === true || state.hasPendingAsyncWork === true) {
        throw Object.assign(new Error("OMP 会话仍有未完成工作，暂不能编辑旧消息"), { errorCode: "AGENT_BUSY" });
      }
      const [messagesResult, treeResult] = await Promise.all([
        this.command(input.sessionId, "get_messages"),
        this.command(input.sessionId, "get_tree"),
      ]);
      const mappedNativeEntryId = /^omp:snapshot:\d+:\d+$/.test(messageId)
        ? null
        : await this.readNativeMessageEntryId(input.sessionId, messageId).catch((error) => {
            this.options.log?.("warn", "OMP native message identity could not be read", { sessionId: input.sessionId, data: String(error) });
            return null;
          });
      let resolvedEntryId = resolveOmpNativeMessageEntryId({
        messageId,
        messagesSnapshot: messagesResult.data,
        treeSnapshot: treeResult.data,
        requiredRole: "user",
        nativeEntryId: mappedNativeEntryId,
      });
      const isLegacyHostId = !/^omp:snapshot:\d+:\d+$/.test(messageId) && !mappedNativeEntryId;
      let legacyDiagnosis: ReturnType<typeof describeOmpNativeLegacyLookup> | null = null;
      if (!resolvedEntryId && isLegacyHostId && typeof input.originalText === "string" && input.originalText) {
        // Mapping capture predates this row (or was skipped). Rebuild it once
        // from unambiguous content and timestamp evidence, then persist so the
        // next edit stays on the fast path. Ambiguity still fails closed.
        legacyDiagnosis = describeOmpNativeLegacyLookup({
          messagesSnapshot: messagesResult.data,
          treeSnapshot: treeResult.data,
          text: input.originalText,
          timestampMs: input.originalTimestamp,
        });
        const inferredEntryId = legacyDiagnosis.entryId;
        if (inferredEntryId) {
          try {
            // Persist first: a conflicting one-to-one mapping means the
            // inferred node already belongs to another row, so the edit must
            // stay rejected instead of proceeding on a guess.
            await this.updateNativeMessageEntryId(input.sessionId, messageId, inferredEntryId);
            resolvedEntryId = inferredEntryId;
          } catch (error) {
            this.options.log?.("warn", "OMP native message mapping could not be backfilled", {
              sessionId: input.sessionId,
              messageId,
              data: String(error),
            });
          }
        } else {
          // No prompt text in logs: the reason plus both sequence sizes is
          // enough to tell "native history is empty" from "alignment shifted".
          this.options.log?.("warn", "OMP legacy message could not be re-associated with a native entry", {
            sessionId: input.sessionId,
            messageId,
            data: JSON.stringify({
              reason: legacyDiagnosis.reason,
              messageCount: legacyDiagnosis.messageCount,
              pathMessageCount: legacyDiagnosis.pathMessageCount,
            }),
          });
        }
      }
      if (!resolvedEntryId) {
        // A rejected stale action is read-only. Do not rewrite Host's richer
        // mirror from a synthetic OMP snapshot just to report the conflict.
        throw Object.assign(
          new Error(isLegacyHostId
            ? legacyDiagnosis?.reason === "native-history-empty"
              ? "这条旧消息无法关联到 OMP 原生历史：该会话在 OMP 侧还没有任何原生消息，历史可能来自 PI 引擎或尚未同步到 OMP。本次没有修改会话；旧消息在 OMP 下不能编辑，发送新消息只对之后的消息生效。"
              : "无法将这条旧消息可靠关联到 OMP 原生历史（可能是稳定关联记录启用前的消息）。为避免改错内容，本次没有修改会话；请在当前分支发送的新消息上编辑。"
            : "这条消息已不在 OMP 当前活动分支中；本次没有修改会话，请刷新对话后重新选择当前分支里的消息。"),
          { errorCode: "OMP_HISTORY_STALE" },
        );
      }
      const tree = treeResult.data && typeof treeResult.data === "object" ? treeResult.data as Record<string, unknown> : {};
      const selected = findOmpNativeTreeEntry(tree, resolvedEntryId) as {
        id?: unknown;
        type?: unknown;
        parentId?: unknown;
        message?: { role?: unknown; content?: unknown };
      } | null;
      if (!selected || selected.type !== "message" || selected.message?.role !== "user") {
        throw new Error("要编辑的提示不再是 OMP 当前分支中的用户消息");
      }
      const nativeImages = input.images?.length
        ? input.images
        : this.ompUserMessageImages(selected.message.content);
      promptImageCount = nativeImages.length;
      if (!input.message.trim() && nativeImages.length === 0) {
        throw new Error("编辑后的提示不能为空；请保留文字或图片");
      }
      originalLeafId = typeof tree.leafId === "string" ? tree.leafId : null;
      if (!originalLeafId) throw new Error("OMP 当前没有可恢复的原生分支叶节点");
      selectedParentId = typeof selected.parentId === "string" ? selected.parentId : null;
      const originalSnapshot = normalizeOmpTranscriptSnapshot(messagesResult.data);
      if (!originalSnapshot.ok) throw new Error(`OMP 当前历史无法安全恢复：${originalSnapshot.reason}`);
      originalMessages = originalSnapshot.messages;

      // `navigate_tree` accepts the selected user entry and moves the active
      // cursor to its parent. Set the flag before the call: an RPC timeout can
      // arrive after OMP has already moved the cursor.
      navigationMayHaveStarted = true;
      const navigation = await this.command(input.sessionId, "navigate_tree", { entryId: resolvedEntryId }, REQUEST_TIMEOUT_MS, true);
      if (navigation.data && typeof navigation.data === "object" && (navigation.data as Record<string, unknown>).cancelled === true) {
        throw new Error("OMP 已取消这次历史编辑");
      }
      const [branchTreeResult, branchMessagesResult] = await Promise.all([
        this.command(input.sessionId, "get_tree"),
        this.command(input.sessionId, "get_messages"),
      ]);
      const branchTree = branchTreeResult.data && typeof branchTreeResult.data === "object" ? branchTreeResult.data as Record<string, unknown> : {};
      if ((typeof branchTree.leafId === "string" ? branchTree.leafId : null) !== selectedParentId) {
        throw new Error("OMP 没有移动到目标提示之前，已取消编辑以免改错分支");
      }
      const branchSnapshot = normalizeOmpTranscriptSnapshot(branchMessagesResult.data);
      if (!branchSnapshot.ok) throw new Error(`OMP 编辑分支无法安全同步到 PI：${branchSnapshot.reason}`);
      promptBaselineTree = branchTree;
      // Treat a lost/failed Host acknowledgement as an ambiguous commit and
      // restore from OMP's canonical snapshot in the catch path.
      transcriptReplacementStarted = true;
      await input.replaceTranscript(input.sessionId, branchSnapshot.messages);

      userMessagePersistenceStarted = true;
      await input.persistUserMessage();
      const images = nativeImages.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
      promptWasSent = true;
      await this.command(input.sessionId, "prompt", {
        message: input.message,
        ...(images.length ? { images } : {}),
      }, REQUEST_TIMEOUT_MS, true);
      if (input.newMessageId) {
        await this.rememberAcceptedNativeUserMessage({
          sessionId: input.sessionId,
          messageId: input.newMessageId,
          message: input.message,
          imageCount: images.length,
          beforeTreeSnapshot: promptBaselineTree,
        });
      }
      return { accepted: true, turnId: session.runId };
    } catch (error) {
      if (promptWasSent && await this.ompEditPromptWasAccepted(input.sessionId, input.message, selectedParentId)) {
        // RPC transport errors can arrive after OMP has durably accepted the
        // prompt. Returning success prevents the UI from asking the user to
        // resend a turn that is already running or present in the native tree.
        if (input.newMessageId) {
          await this.rememberAcceptedNativeUserMessage({
            sessionId: input.sessionId,
            messageId: input.newMessageId,
            message: input.message,
            imageCount: promptImageCount,
            beforeTreeSnapshot: promptBaselineTree,
          });
        }
        return { accepted: true, turnId: session.runId };
      }
      if (navigationMayHaveStarted && originalLeafId && originalMessages) {
        try {
          const currentTreeResult = await this.command(input.sessionId, "get_tree");
          const currentTree = currentTreeResult.data && typeof currentTreeResult.data === "object" ? currentTreeResult.data as Record<string, unknown> : {};
          if (currentTree.leafId !== originalLeafId) {
            await this.command(input.sessionId, "navigate_tree", { entryId: originalLeafId }, REQUEST_TIMEOUT_MS, true);
            const restoredTreeResult = await this.command(input.sessionId, "get_tree");
            const restoredTree = restoredTreeResult.data && typeof restoredTreeResult.data === "object" ? restoredTreeResult.data as Record<string, unknown> : {};
            if (restoredTree.leafId !== originalLeafId) throw new Error("OMP 原生分支叶节点未恢复");
          }
          if (transcriptReplacementStarted || userMessagePersistenceStarted) {
            const restoredMessages = await this.command(input.sessionId, "get_messages");
            const restoredSnapshot = normalizeOmpTranscriptSnapshot(restoredMessages.data);
            if (!restoredSnapshot.ok) throw new Error(`恢复后的 OMP 历史无法安全同步：${restoredSnapshot.reason}`);
            await input.replaceTranscript(input.sessionId, restoredSnapshot.messages);
          }
        } catch (rollbackError) {
          throw new Error(`OMP 编辑失败，且无法完整恢复原分支/对话镜像：${String(rollbackError)}`, { cause: error });
        }
      }
        throw error;
      } finally {
        session.forking = false;
      }
    });
  }

  private ompUserMessageImages(content: unknown): Array<{ data: string; mimeType: string }> {
    const prompt = normalizeOmpTranscriptSnapshot([{ role: "user", content }]);
    if (!prompt.ok || prompt.messages.length !== 1) return [];
    const message = prompt.messages[0] as { inlineImages?: Array<{ dataUrl: string; mimeType: string }> };
    return (message.inlineImages ?? []).flatMap((image) => {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
      return match ? [{ data: match[2], mimeType: image.mimeType || match[1] }] : [];
    });
  }

  private async ompEditPromptWasAccepted(sessionId: string, message: string, expectedParentId: string | null): Promise<boolean> {
    try {
      const [stateResult, treeResult, messagesResult] = await Promise.all([
        this.command(sessionId, "get_state"),
        this.command(sessionId, "get_tree"),
        this.command(sessionId, "get_messages"),
      ]);
      const state = stateResult.data && typeof stateResult.data === "object" ? stateResult.data as Record<string, unknown> : {};
      if (state.isStreaming === true || state.hasPendingAsyncWork === true) return true;
      const tree = treeResult.data && typeof treeResult.data === "object" ? treeResult.data as Record<string, unknown> : {};
      if (tree.leafId === expectedParentId) return false;
      const snapshot = normalizeOmpTranscriptSnapshot(messagesResult.data);
      if (!snapshot.ok) return false;
      for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
        const candidate = snapshot.messages[index] as { role?: unknown; content?: unknown };
        if (candidate.role !== "user") continue;
        return typeof candidate.content === "string" && candidate.content === message;
      }
      return false;
    } catch {
      return false;
    }
  }

  async abort(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) return;
    await this.withPromptAdmission(sessionId, async () => {
      if (!this.sessions.has(sessionId)) return;
      await this.command(sessionId, "abort");
    });
  }

  /**
   * Fork an OMP message into a separate durable PI conversation. OMP's fork
   * command switches the current RPC process to a new session file, so pin
   * both PI ids to their exact native files before restoring the parent. The
   * mapping survives restart and prevents `open_session(sessionDir)` from
   * silently attaching the parent PI chat to the newest forked file.
   */
  async forkToSession(input: { sessionId: string; targetSessionId: string; cwd: string; workspaceRoot?: string; entryId: string }): Promise<{ messages: unknown[]; parentMessages: unknown[] }> {
    return this.branchOrForkToSession(input, "fork");
  }

  private async branchOrForkToSession(
    input: { sessionId: string; targetSessionId: string; cwd: string; workspaceRoot?: string; entryId: string },
    operation: "fork" | "branch",
    lockedSource?: RpcSession,
  ): Promise<{
    messages: unknown[];
    parentMessages: unknown[];
    prompt?: { text: string; images: Array<{ dataUrl: string; mimeType: string }> };
  }> {
    const sourceId = input.sessionId;
    const targetId = input.targetSessionId;
    const entryId = input.entryId.trim();
    if (!sourceId || !targetId || sourceId === targetId || !entryId || entryId.length > 512) {
      throw new Error("Invalid OMP fork request");
    }
    const source = await this.ensureSession({ sessionId: sourceId, cwd: input.cwd, ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}) });
    const ownsHistoryLock = lockedSource === undefined;
    if (source.mappingPrompt) throw new Error("OMP 正在同步新消息的原生关联，暂不能分叉");
    if (lockedSource && lockedSource !== source) throw new Error("OMP history operation lost its session lock");
    if (ownsHistoryLock) {
      if (source.forking) throw new Error("OMP conversation is already being forked");
      source.forking = true;
    }
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
      const transition = await this.command(sourceId, operation, { entryId }, REQUEST_TIMEOUT_MS, true);
      const transitionData = transition.data as Record<string, unknown> | undefined;
      if (transitionData?.cancelled === true) throw new Error("OMP 已取消本次分支");
      const forkState = await this.command(sourceId, "get_state");
      const forkStateData = forkState.data as Record<string, unknown> | undefined;
      childFile = await this.resolveTransitionSessionFile(forkStateData?.sessionFile, sourceSessionDir);
      if (sameNativePath(childFile, originalFile)) throw new Error("OMP 分叉没有生成独立会话文件");
      const childSnapshot = await this.command(sourceId, "get_messages");
      const normalizedChild = normalizeOmpTranscriptSnapshot(childSnapshot.data);
      if (!normalizedChild.ok) throw new Error(`OMP 分支内容无法安全同步到 PI：${normalizedChild.reason}`);

      let prompt: { text: string; images: Array<{ dataUrl: string; mimeType: string }> } | undefined;
      if (operation === "branch") {
        const text = typeof transitionData?.text === "string" ? transitionData.text : "";
        const rawImages = Array.isArray(transitionData?.images) ? transitionData.images : [];
        const promptContent = [
          ...(text ? [{ type: "text", text }] : []),
          ...rawImages,
        ];
        const normalizedPrompt = normalizeOmpTranscriptSnapshot([
          { role: "user", content: promptContent },
        ]);
        if (!normalizedPrompt.ok || normalizedPrompt.messages.length !== 1) {
          throw new Error(`OMP 原生分支返回的原提示无法安全恢复：${normalizedPrompt.reason}`);
        }
        const message = normalizedPrompt.messages[0] as { content?: unknown; inlineImages?: Array<{ dataUrl: string; mimeType: string }> };
        const promptText = typeof message.content === "string" ? message.content : "";
        const images = Array.isArray(message.inlineImages) ? message.inlineImages : [];
        if (!promptText.trim() && images.length === 0) throw new Error("OMP 原生分支没有返回可恢复的用户输入");
        prompt = { text: promptText, images };
      }

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
      return { messages: normalizedChild.messages, parentMessages, ...(prompt ? { prompt } : {}) };
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
            throw new Error(`OMP 原生分支失败，且无法自动恢复原会话：${String(recoveryError)}`, { cause: error });
          }
        }
      }
      await this.completeForkTranscriptSync(sourceId, targetId).catch(() => undefined);
      throw error;
    } finally {
      if (ownsHistoryLock) source.forking = false;
    }
  }

  /**
   * Navigate OMP's temporary active tree cursor and persist the matching PI
   * transcript mirror as one guarded transition. If the mirror write fails,
   * restore the old native leaf and old mirror before releasing the session.
   */
  async navigateTreeAndSync(input: {
    sessionId: string;
    entryId: string;
    replaceTranscript: (sessionId: string, messages: unknown[]) => Promise<unknown>;
  }): Promise<{
    cancelled: boolean;
    leafId: string | null;
    previousLeafId: string | null;
    messages: unknown[];
    editorText?: string;
    editorImages?: Array<{ dataUrl: string; mimeType: string }>;
  }> {
    const sessionId = input.sessionId;
    const entryId = input.entryId.trim();
    if (!sessionId || !entryId || entryId.length > 512 || typeof input.replaceTranscript !== "function") {
      throw new Error("Invalid OMP tree navigation request");
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) throw new Error("OMP RPC 会话尚未连接");
    if (session.forking || session.mappingPrompt) throw new Error("OMP 会话正在执行另一项原生历史操作");
    session.forking = true;
    let originalLeafId: string | null = null;
    let originalMessages: unknown[] | null = null;
    let navigationStarted = false;
    try {
      if (session.busy || session.pending.size > 0) throw new Error("OMP 会话仍有未完成工作，暂不能跳转");
      const stateResult = await this.command(sessionId, "get_state");
      const state = stateResult.data && typeof stateResult.data === "object" ? stateResult.data as Record<string, unknown> : {};
      if (state.isStreaming === true || state.isCompacting === true || state.hasPendingAsyncWork === true) {
        throw new Error("OMP 会话仍有未完成工作，暂不能跳转");
      }
      const treeResult = await this.command(sessionId, "get_tree");
      const tree = treeResult.data && typeof treeResult.data === "object" ? treeResult.data as Record<string, unknown> : {};
      const selected = findOmpNativeTreeEntry(tree, entryId) as { id?: unknown; type?: unknown; parentId?: unknown; message?: { role?: unknown; content?: unknown } } | null;
      if (!selected || selected.type !== "message" || !["user", "assistant"].includes(String(selected.message?.role))) {
        throw new Error("只能跳转到 OMP 原生树中的用户或 assistant 消息");
      }
      originalLeafId = typeof tree.leafId === "string" ? tree.leafId : null;
      if (!originalLeafId) throw new Error("OMP 当前没有可恢复的原生分支叶节点");
      const before = await this.command(sessionId, "get_messages");
      const beforeSnapshot = normalizeOmpTranscriptSnapshot(before.data);
      if (!beforeSnapshot.ok) throw new Error(`OMP 当前历史无法安全同步到 PI：${beforeSnapshot.reason}`);
      originalMessages = beforeSnapshot.messages;

      navigationStarted = true;
      const transition = await this.command(sessionId, "navigate_tree", { entryId }, REQUEST_TIMEOUT_MS, true);
      const transitionData = transition.data && typeof transition.data === "object" ? transition.data as Record<string, unknown> : {};
      if (transitionData.cancelled === true) {
        return { cancelled: true, leafId: originalLeafId, previousLeafId: originalLeafId, messages: originalMessages };
      }
      const [afterTreeResult, afterMessagesResult] = await Promise.all([
        this.command(sessionId, "get_tree"),
        this.command(sessionId, "get_messages"),
      ]);
      const afterTree = afterTreeResult.data && typeof afterTreeResult.data === "object" ? afterTreeResult.data as Record<string, unknown> : {};
      const afterLeafId = typeof afterTree.leafId === "string" ? afterTree.leafId : null;
      const expectedLeaf = selected.message?.role === "user"
        ? (typeof selected.parentId === "string" ? selected.parentId : null)
        : entryId;
      if (afterLeafId !== expectedLeaf) throw new Error("OMP 跳转后的活动分支与选中节点不一致");
      const afterSnapshot = normalizeOmpTranscriptSnapshot(afterMessagesResult.data);
      if (!afterSnapshot.ok) throw new Error(`OMP 跳转后的历史无法安全同步到 PI：${afterSnapshot.reason}`);

      let editorText: string | undefined;
      let editorImages: Array<{ dataUrl: string; mimeType: string }> | undefined;
      if (selected.message?.role === "user") {
        const prompt = normalizeOmpTranscriptSnapshot([{ role: "user", content: selected.message.content }]);
        if (!prompt.ok || prompt.messages.length !== 1) throw new Error(`OMP 原生输入无法安全恢复到编辑框：${prompt.reason}`);
        const normalizedPrompt = prompt.messages[0] as { content?: unknown; inlineImages?: Array<{ dataUrl: string; mimeType: string }> };
        const blocks = Array.isArray(selected.message.content) ? selected.message.content : [];
        const textFromTree = typeof selected.message.content === "string"
          ? selected.message.content
          : blocks.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("");
        editorText = typeof transitionData.editorText === "string" ? transitionData.editorText : textFromTree;
        editorImages = Array.isArray(normalizedPrompt.inlineImages) ? normalizedPrompt.inlineImages : [];
      }

      await input.replaceTranscript(sessionId, afterSnapshot.messages);
      return {
        cancelled: false,
        leafId: afterLeafId,
        previousLeafId: originalLeafId,
        messages: afterSnapshot.messages,
        ...(editorText !== undefined ? { editorText } : {}),
        ...(editorImages ? { editorImages } : {}),
      };
    } catch (error) {
      if (navigationStarted && originalLeafId && originalMessages) {
        try {
          const rollbackTreeResult = await this.command(sessionId, "get_tree");
          const rollbackTree = rollbackTreeResult.data && typeof rollbackTreeResult.data === "object" ? rollbackTreeResult.data as Record<string, unknown> : {};
          const nativeMoved = rollbackTree.leafId !== originalLeafId;
          if (nativeMoved) {
            await this.command(sessionId, "navigate_tree", { entryId: originalLeafId }, REQUEST_TIMEOUT_MS, true);
            const restoredTreeResult = await this.command(sessionId, "get_tree");
            const restoredTree = restoredTreeResult.data && typeof restoredTreeResult.data === "object" ? restoredTreeResult.data as Record<string, unknown> : {};
            if (restoredTree.leafId !== originalLeafId) throw new Error("OMP 原生分支叶节点未恢复");
            await input.replaceTranscript(sessionId, originalMessages);
          }
        } catch (rollbackError) {
          throw new Error(`OMP 树跳转失败，且无法完整恢复原分支/对话镜像：${String(rollbackError)}`, { cause: error });
        }
      }
      throw error;
    } finally {
      session.forking = false;
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
    if (session.busy || session.forking || session.mappingPrompt) return;
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
    let selectedModel: { provider: string; modelId: string; role?: string; thinkingLevel?: string } | null = null;
    try {
      const parsed = JSON.parse(await readFile(join(profileDir, "pi-selected-model.json"), "utf8"));
      if (typeof parsed.provider === "string" && typeof parsed.modelId === "string") {
        selectedModel = {
          provider: parsed.provider,
          modelId: parsed.modelId,
          ...(typeof parsed.role === "string" && parsed.role.trim() && parsed.role.length <= 80 ? { role: parsed.role.trim() } : {}),
          ...(typeof parsed.thinkingLevel === "string" && ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(parsed.thinkingLevel) ? { thinkingLevel: parsed.thinkingLevel } : {}),
        };
      }
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
      mappingPrompt: false,
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
      if (!mappedSessionFile && input.sessionId !== this.options.settingsSessionId && selectedModel?.role) {
        // OMP deliberately does not persist quick roles. Apply the GUI's next-
        // chat role once, immediately after opening a fresh native session.
        await this.command(input.sessionId, "set_model", {
          provider: selectedModel.provider,
          modelId: selectedModel.modelId,
          role: selectedModel.role,
          ...(selectedModel.thinkingLevel ? { thinkingLevel: selectedModel.thinkingLevel } : {}),
        }).catch((error) => {
          this.options.log?.("warn", "OMP one-shot quick-role selection could not be applied", { sessionId: input.sessionId, data: String(error) });
        });
      }
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
