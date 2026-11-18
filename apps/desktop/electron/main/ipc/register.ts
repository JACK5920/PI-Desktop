import { isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { app, dialog, net, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import { err, ErrorCodes, IPC, ok, OMP_SETTINGS_RPC_SESSION_ID, type AgentEventEnvelope, type LifecycleDialogChoice, type Result, type UiMessage } from "@pi-desktop/shared";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import { ROUTE_LOCAL, type BackendRouter } from "../remote/backend-router";
import { registerAgentExtensionIpc } from "../agent-extensions-ipc";
import { readNpmPath, writeNpmPath } from "../npm-preferences";
import { createManagedSessionRouter } from "../plugin-managed-sessions";
import { registerAgentIpc } from "./agent-ipc";
import { registerAppIpc } from "./app-ipc";
import { registerDiagnosticsIpc } from "./diagnostics-ipc";
import { registerMarketIpc } from "./market-ipc";
import { registerMcpIpc } from "./mcp-ipc";
import type { McpOAuthManager } from "../mcp-oauth";
import { searchMcpMarket } from "../mcp-registry-catalog";
import { registerNotificationIpc } from "./notification-ipc";
import { registerPluginIpc } from "./plugin-ipc";
import { registerPluginUiIpc } from "./plugin-ui-ipc";
import { registerPluginLauncherIpc } from "./plugin-launcher-ipc";
import { registerJevIpc } from "./jev-ipc";
import { registerProviderIpc } from "./provider-ipc";
import { registerScheduledIpc } from "./scheduled-ipc";
import { registerSessionIpc } from "./session-ipc";
import { registerSettingsIpc } from "./settings-ipc";
import { createOmpManagedEngine } from "../omp/managed-engine";
import { createPiManagedEngine } from "../pi/managed-engine";
import { getModuleDirectory } from "../module-path";
import { ompCustomModelSecretRef, readOmpCustomModelKeys } from "../omp/custom-model";
import { OmpRpcRuntime } from "../omp/rpc-runtime";
import { OmpSubagentArchive } from "../omp/subagent-archive.mjs";
import { archiveOmpTaskProgress } from "../omp/subagent-progress-archive.mjs";
import { liveOwnerFromInvoke } from "../live-voice/owner";
import { ompFrameToAgentEvent } from "../omp/rpc-event-adapter";
import { normalizeOmpTranscriptSnapshot, persistOmpForkTranscriptSnapshots } from "../../../src/lib/omp-transcript-sync.mjs";
import { registerStorageIpc } from "../storage/ipc";
import { registerConfigSyncIpc } from "./config-sync-ipc";
import { registerBackgroundTasksIpc } from "./background-tasks-ipc";
import { registerArtifactsIpc } from "./artifacts-ipc";
import { registerSkillsIpc } from "./skills-ipc";
import { registerAgentImportIpc } from "./agent-import-ipc";
import { registerRemoteHostIpc } from "./remote-host-ipc";
import { fetchSkillMarketDocument, searchSkillMarket } from "../skill-market-catalog";
import { registerWindowIpc } from "./window-ipc";
import { registerWorktreeIpc } from "./worktree-ipc";
import { registerGitHubPrReviewIpc } from "./github-pr-review-ipc";
import { createComposerTemplateLoader, registerWorkspaceIpc } from "./workspace-ipc";
import { registerComposerIpc } from "./composer-ipc";
import { registerSpeechIpc } from "./speech-ipc";
import { registerVoiceIpc } from "./voice-ipc";
import { registerLiveVoiceIpc } from "./live-voice-ipc";
import type { LiveCallService } from "../live-voice/call-service";
import type { ComposerSuggestionAnswer } from "../services/composer-suggestion";
import type { LiveVoiceWidget } from "../live-voice/widget-window";
import { registerComputerUseIpc } from "./computer-use-ipc";
import type { ComputerUseWidget } from "../computer-use/widget-window";
import { getActiveComputerUseRun } from "../computer-use/active-run";
import type { IpcRegistrar } from "./types";
import type { createTraySessions } from "../tray-sessions";
import type { createTaskbarUnreadBadge } from "../taskbar-unread-badge";

export type RegisterIpcDependencies = {
  isQuitting: () => boolean;
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  traySessions: ReturnType<typeof createTraySessions>;
  taskbarUnreadBadge: ReturnType<typeof createTaskbarUnreadBadge>;
  getSidecar: () => AgentSidecar | null;
  publishAgentEvent: (envelope: AgentEventEnvelope) => UiMessage | undefined;
  onOmpRpcRuntimeCreated?: (runtime: Pick<OmpRpcRuntime, "stopAll"> | undefined) => void;
  sessionProjects: Map<string, string | null>;
  getAgentHostBridge: () => AgentHostBridge | null;
  /**
   * Resolves the remote backend router once it exists. Renderer IPC calls whose
   * session is owned by a paired remote host are forwarded through it; every
   * other call — including all internal invokes — runs the local handler
   * unchanged. Null until the router is wired (and in tests).
   */
  getBackendRouter?: () => BackendRouter | null;
  getNotificationViewingSessionId: () => string | null;
  setNotificationViewingSessionId: (sessionId: string | null) => void;
  /** The session on screen, as the shell reported it (plugin `session:activated`). */
  setActivePluginSession: (
    next: { sessionId: string; projectPath: string | null } | null,
  ) => void;
  /** The shell's answer to a composer suggestion it was offered (ADR 0333). */
  settleComposerSuggestion: (answer: ComposerSuggestionAnswer) => boolean;
  activeUserSubagentDocuments: (...args: any[]) => Promise<any>;
  disabledBuiltinSubagents: () => Promise<string[]>;
  disabledBuiltinSkills: () => Promise<string[]>;
  /** Host activation plus the inline-visualization switch, for runtime consumers. */
  runtimeDisabledBuiltinSkills: () => Promise<string[]>;
  completionNoticeTurns: Set<string>;
  liveCallService?: LiveCallService;
  liveVoiceWidget?: LiveVoiceWidget;
  computerUseWidget?: ComputerUseWidget;
  restartForStorage: () => void;
  mcpOAuth?: McpOAuthManager;
  markLifecycleDialogRendererReady: (window: BrowserWindow) => boolean;
  respondLifecycleDialog: (senderWindowId: number, requestId: unknown, choice: LifecycleDialogChoice) => boolean;
  [name: string]: any;
};

function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return fn()
    .then((data) => ok(data))
    .catch((e: any) =>
      err(
        e?.data?.errorCode || e?.errorCode || ErrorCodes.INTERNAL,
        e instanceof Error ? e.message : String(e),
        { retriable: e?.data?.retriable === true, details: e?.data },
      ),
    );
}

export function registerIpcHandlers(dependencies: RegisterIpcDependencies) {
  const {
    ipcMain,
    getMainWindow,
    getHost,
    getSidecar,
    publishAgentEvent,
    onOmpRpcRuntimeCreated,
    getAgentHostBridge,
    getBackendRouter,
    getNotificationViewingSessionId,
    setNotificationViewingSessionId,
    setActivePluginSession,
    settleComposerSuggestion,
    getPluginLauncherWindow,
    togglePluginLauncher,
    openPluginMarket,
    safeOpenExternal,
    updater,
    pluginServices,
    dataDir,
    activeTurns,
    completionNoticeTurns,
    isTurnDispatchable,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    localApps,
    speech,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    beginManualCompaction,
    endManualCompaction,
    beginTranscriptRewrite,
    forgetTranscriptRewriteHistory,
    recordTurnStart,
    stripWinLongPrefix,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    applyPreventScreenSleep,
    applyKeepAwakeWhileRunning,
    resolveEffectiveCommandShell,
    modelsDevCatalog,
    vendorOAuth,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
    agentExtensions,
    activeUserSkills,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    disabledBuiltinSkills,
    runtimeDisabledBuiltinSkills,
    pluginActiveInProject,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    getWindowMinimumSize,
    applyCloseBehavior,
    getCloseBehavior,
    isMacosWindowTranslucent,
    markMenuRendererReady,
    markLifecycleDialogRendererReady,
    respondLifecycleDialog,
    traySessions,
    taskbarUnreadBadge,
    executeNativeMenuAction,
    scheduledRunsBySession,
    isDevelopmentBuild,
    browserHost,
    clipboardHistory,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    userMcp,
    mcpOAuth,
    refreshUserMcp,
    describeError,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    pluginPanels,
    getUpdaterLocale,
    getPluginPanelTheme,
    isDeveloperMode,
    sendToRenderer,
    voiceService,
    liveCallService,
    liveVoiceWidget,
    computerUseWidget,
  } = dependencies;


  const ipcHandlers = new Map<string, (...args: any[]) => Promise<any>>();
  const abortAgentRun = async (sessionId: string): Promise<void> => {
    const handler = ipcHandlers.get(IPC.invoke.agentAbort);
    if (!handler) throw new Error("agent abort handler unavailable");
    await handler({ sessionId });
  };
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    const handler = async (...args: any[]) => {
      const result = await fn(...args);
      traySessions.observeInvoke(channel);
      taskbarUnreadBadge.observeInvoke(channel);
      return result;
    };
    ipcHandlers.set(channel, handler);
    // The interception seam for remote-host routing: a renderer call whose
    // session is owned by a paired remote host is served over RACP-WS; every
    // other call (and every internal invoke, which never reaches this wrapper)
    // runs the existing local handler byte-for-byte unchanged.
    ipcMain.handle(channel, async (_event, ...args) =>
      wrap(async () => {
        const router = getBackendRouter?.();
        if (router) {
          const outcome = await router.route(channel, args);
          if (outcome !== ROUTE_LOCAL) return outcome.value;
        }
        return handler(...args);
      }),
    );
  };
  const handleWithEvent = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) =>
      wrap(() => fn(event, ...args)),
    );
  };
  const assertMainWindowSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== getMainWindow()?.webContents.id) {
      throw Object.assign(new Error("renderer is not the main window"), {
        errorCode: "PERMISSION_DENIED",
      });
    }
  };

  const optionalWorkspaceRoot = async (): Promise<string | null> => {
    const currentHost = getHost();
    if (!currentHost) return null;
    try {
      const result = (await currentHost.call("workspace.get")) as {
        workspace: { path?: string } | null;
      };
      return result.workspace?.path ?? null;
    } catch {
      return null;
    }
  };

  const registrar: IpcRegistrar = {
    ipcMain,
    handle,
    handleWithEvent,
    assertMainWindowSender,
  };

  registerAppIpc({
    registrar,
    getHost,
    getPluginLauncherWindow,
    togglePluginLauncher,
    safeOpenExternal,
    updater,
  });
  registerStorageIpc({ registrar, getMainWindow, restart: dependencies.restartForStorage });
  registerNotificationIpc({
    registrar,
    getHost,
    getMainWindow,
    getViewingSessionId: getNotificationViewingSessionId,
    setViewingSessionId: setNotificationViewingSessionId,
    sendToRenderer,
  });
  registerSessionIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    activeTurns,
    sessionProjects,
    persistenceOutbox,
    logger,
    plugins,
    sessionCapabilityContext,
    enrichSession,
    acquireSessionOperation,
    beginTranscriptRewrite,
    forgetTranscriptRewriteHistory,
    stripWinLongPrefix,
  });
  let ompEngine: ReturnType<typeof createOmpManagedEngine> | undefined;
  try {
    ompEngine = createOmpManagedEngine(join(dataDir, "managed-engines", "oh-my-pi"));
  } catch {
    // Unsupported OS/architecture is reported to the settings view as unavailable.
  }
  const mainModuleDir = getModuleDirectory(import.meta.url);
  const piRuntimeCandidates = [
    join(process.resourcesPath || "", "agent-runtime"),
    join(mainModuleDir, "../../../agent-runtime/dist"),
    join(mainModuleDir, "../../../../packages/agent-runtime/dist"),
    join(mainModuleDir, "../../../../packages/agent-runtime/dist-bundle"),
  ];
  const piBundledRuntimeDir = piRuntimeCandidates.find((path) => existsSync(join(path, "runtime-manifest.json")))
    ?? piRuntimeCandidates.find((path) => existsSync(join(path, "sidecar.js")))
    ?? piRuntimeCandidates[0]!;
  let piEngine: ReturnType<typeof createPiManagedEngine> | undefined;
  try {
    piEngine = createPiManagedEngine(join(dataDir, "managed-engines", "pi-runtime"), piBundledRuntimeDir);
  } catch {
    // Unsupported OS/architecture is reported to the settings view as unavailable.
  }
  const ompSubagentArchive = new OmpSubagentArchive(join(dataDir, "managed-engines", "oh-my-pi"));
  const ompMessageIds = new Map<string, Set<string>>();
  const ompSubagentCaptureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const ompSubagentCaptureRunning = new Set<string>();
  const ompSubagentCapturePending = new Set<string>();
  const ompSubagentCaptureAgentIds = new Map<string, Set<string>>();
  let ompRpcRuntime: OmpRpcRuntime | undefined;

  const resolveOmpSessionContext = async (sessionId: string) => {
    if (!sessionId) throw new Error("会话不存在或不属于当前桌面窗口");
    if (!ompRpcRuntime) throw new Error("当前系统不支持 OMP RPC 引擎");
    if (sessionId === OMP_SETTINGS_RPC_SESSION_ID) return { sessionId, cwd: app.getPath("home") };
    const host = getHost();
    if (!host) throw new Error("Host 不可用");
    const detail = await host.call<{ session?: { agentEngine?: string; projectPath?: string | null; remoteWorkspace?: unknown } }>("session.get", { id: sessionId, messageLimit: 1 });
    if (!detail.session || detail.session.agentEngine !== "omp") throw new Error("会话不存在或不是 OMP 原生会话");
    if (detail.session.remoteWorkspace) throw new Error("OMP 原生引擎目前仅支持本机工作区会话");
    const projectPath = detail.session.projectPath ?? sessionProjects.get(sessionId) ?? null;
    const cwd = projectPath ? stripWinLongPrefix(projectPath) : app.getPath("home");
    if (!isAbsolute(cwd)) throw new Error("当前会话的工作目录不是绝对路径，无法启动 OMP");
    return { sessionId, cwd, ...(projectPath ? { workspaceRoot: cwd } : {}) };
  };

  const captureOmpSubagents = async (sessionId: string) => {
    if (!ompRpcRuntime || ompSubagentCaptureRunning.has(sessionId)) {
      if (ompSubagentCaptureRunning.has(sessionId)) ompSubagentCapturePending.add(sessionId);
      return;
    }
    ompSubagentCaptureRunning.add(sessionId);
    const eventAgentIds = new Set(ompSubagentCaptureAgentIds.get(sessionId) ?? []);
    ompSubagentCaptureAgentIds.delete(sessionId);
    try {
      const context = await resolveOmpSessionContext(sessionId);
      await ompRpcRuntime.connect(context);
      const rosterResult = await ompRpcRuntime.command(sessionId, "get_subagents");
      const rosterData = rosterResult.data && typeof rosterResult.data === "object" ? rosterResult.data as Record<string, any> : {};
      const nativeRoster = Array.isArray(rosterData.subagents) ? rosterData.subagents.filter((agent: any) => agent && typeof agent.id === "string") : [];
      if (nativeRoster.length) await ompSubagentArchive.mergeRoster(sessionId, nativeRoster);
      const captureIds = new Set([...nativeRoster.map((agent: any) => agent.id), ...eventAgentIds]);
      const roster = (await ompSubagentArchive.getRoster(sessionId)).filter((agent) => captureIds.has(agent.id));
      // Bound concurrency: large Task batches should not flood the OMP RPC
      // worker with dozens of transcript reads at the same time.
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < roster.length) {
          const agent = roster[nextIndex++];
          const previous = await ompSubagentArchive.getAgentMeta(sessionId, agent.id);
          const previousNextByte = previous?.transcriptNextByte;
          const fromByte = typeof previousNextByte === "number" && Number.isSafeInteger(previousNextByte) && previousNextByte >= 0
            ? previousNextByte
            : 0;
          try {
            const transcriptResult = await ompRpcRuntime!.command(sessionId, "get_subagent_messages", { subagentId: agent.id, fromByte });
            const data = transcriptResult.data && typeof transcriptResult.data === "object" ? transcriptResult.data as Record<string, any> : {};
            if (Array.isArray(data.messages) && data.messages.length) {
              await ompSubagentArchive.appendTranscript(sessionId, agent.id, {
                fromByte,
                nextByte: data.nextByte,
                reset: data.reset,
                messages: data.messages,
              });
            }
          } catch {
            // A completed OMP worker may no longer expose a live transcript;
            // the last durable snapshot remains available for old chats.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, roster.length) }, () => worker()));
    } catch (error) {
      if (eventAgentIds.size) ompSubagentCaptureAgentIds.set(sessionId, new Set([...(ompSubagentCaptureAgentIds.get(sessionId) ?? []), ...eventAgentIds]));
      logger.app("omp-rpc", "warn", "OMP subagent snapshot failed", { sessionId, data: String(error) });
    } finally {
      ompSubagentCaptureRunning.delete(sessionId);
      if (ompSubagentCapturePending.delete(sessionId)) scheduleOmpSubagentCapture(sessionId, 250);
    }
  };

  function scheduleOmpSubagentCapture(sessionId: string, delay = 650) {
    const previous = ompSubagentCaptureTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      ompSubagentCaptureTimers.delete(sessionId);
      void captureOmpSubagents(sessionId);
    }, delay);
    timer.unref?.();
    ompSubagentCaptureTimers.set(sessionId, timer);
  }

  ompRpcRuntime = ompEngine ? new OmpRpcRuntime({
    rootDir: join(dataDir, "managed-engines", "oh-my-pi"),
    manager: ompEngine,
    settingsSessionId: OMP_SETTINGS_RPC_SESSION_ID,
    emit: (event) => {
      if (event.frame.type === "live_end" || event.frame.type === "process_exit" || event.frame.type === "runtime_error") {
        dependencies.ompMicrophoneLeases?.releaseSession(event.sessionId);
      }
      sendToRenderer(IPC.event.ompRpcEvent, event);
      // Settings owns a dedicated OMP RPC process for provider management. Its
      // auth/model events are UI-only and must never enter a PI chat transcript.
      if (event.sessionId === OMP_SETTINGS_RPC_SESSION_ID) return;
      const frameType = String(event.frame.type ?? "");
      if (frameType.startsWith("subagent_")) {
        const payload = event.frame.payload && typeof event.frame.payload === "object"
          ? event.frame.payload as Record<string, any>
          : event.frame as Record<string, any>;
        const subagentId = typeof payload.id === "string"
          ? payload.id
          : typeof payload.progress?.id === "string" ? payload.progress.id : null;
        if (subagentId) {
          const parentToolCallId = payload.parentToolCallId ?? payload.parent_tool_call_id ?? payload.parentCallId
            ?? payload.progress?.parentToolCallId ?? payload.progress?.parent_tool_call_id ?? payload.progress?.parentCallId;
          const pending = ompSubagentCaptureAgentIds.get(event.sessionId) ?? new Set<string>();
          pending.add(subagentId);
          ompSubagentCaptureAgentIds.set(event.sessionId, pending);
          void ompSubagentArchive.upsertAgent(event.sessionId, {
            ...payload,
            id: subagentId,
            status: payload.status ?? payload.progress?.status ?? (frameType === "subagent_progress" ? "running" : undefined),
            ...(typeof parentToolCallId === "string" && parentToolCallId ? { parentToolCallId } : {}),
            ...(payload.progress && typeof payload.progress === "object" ? { progress: payload.progress } : {}),
          }).catch((error) => logger.app("omp-rpc", "warn", "OMP subagent lifecycle snapshot write failed", { sessionId: event.sessionId, data: String(error) }));
        }
        scheduleOmpSubagentCapture(event.sessionId);
      } else if (frameType === "tool_execution_end") {
        // The Task result includes exact child ids and parent call context.
        // Archive it before OMP drops completed workers from get_subagents.
        void archiveOmpTaskProgress(ompSubagentArchive, event.sessionId, event.frame).then((agentIds) => {
          if (!agentIds.length) return;
          const pending = ompSubagentCaptureAgentIds.get(event.sessionId) ?? new Set<string>();
          for (const agentId of agentIds) pending.add(agentId);
          ompSubagentCaptureAgentIds.set(event.sessionId, pending);
          scheduleOmpSubagentCapture(event.sessionId, 250);
        }).catch((error) => logger.app("omp-rpc", "warn", "OMP Task-result subagent snapshot write failed", { sessionId: event.sessionId, data: String(error) }));
      } else if (["agent_end", "prompt_result", "session_settled", "runtime_error"].includes(frameType)) {
        scheduleOmpSubagentCapture(event.sessionId, 350);
      }
      if (event.frame.type === "agent_start" && !ompMessageIds.has(event.sessionId)) ompMessageIds.set(event.sessionId, new Set());
      const messageIds = ompMessageIds.get(event.sessionId) ?? new Set<string>();
      const mapped = ompFrameToAgentEvent({
        sessionId: event.sessionId,
        runId: event.runId,
        turnId: activeTurns.get(event.sessionId),
        frame: event.frame,
        messageIds,
      });
      if (mapped) publishAgentEvent(mapped);
      if ((event.frame.type === "prompt_result" &&
          (event.frame.status !== "completed" || event.frame.sessionSettled !== false)) ||
        event.frame.type === "session_settled" || event.frame.type === "runtime_error") {
        ompMessageIds.delete(event.sessionId);
      }
    },
    log: (level, message, data) => logger.app("omp-rpc", level, message, { data }),
    getCustomModelApiKeys: async () => {
      const host = getHost();
      if (!host) return {};
      return readOmpCustomModelKeys(
        join(dataDir, "managed-engines", "oh-my-pi", "runtime", "profile"),
        async (id) => {
          const secret = await host.call<{ value?: string | null }>("secrets.getForRuntime", { secretRef: ompCustomModelSecretRef(id) });
          return typeof secret.value === "string" ? secret.value : null;
        },
      );
    },
    executeHostTool: async (input) => {
      const host = getHost();
      if (!host) throw new Error("PI Host is unavailable");
      if (!input.workspaceRoot) throw new Error("OMP Host tools require a project workspace");
      const detail = await host.call<{ session?: {
        agentEngine?: string;
        projectPath?: string | null;
        remoteWorkspace?: unknown;
        mode?: string;
      } }>("session.get", { id: input.sessionId, messageLimit: 1 });
      const session = detail.session;
      if (!session || session.agentEngine !== "omp" || session.remoteWorkspace || !session.projectPath) {
        throw new Error("OMP Host tools require an OMP conversation attached to a local project");
      }
      const sessionRoot = stripWinLongPrefix(session.projectPath);
      const normalizedRoot = resolve(input.workspaceRoot);
      const normalizedSessionRoot = resolve(sessionRoot);
      const normalizedCwd = resolve(input.cwd);
      const sameRoot = process.platform === "win32"
        ? normalizedRoot.toLowerCase() === normalizedSessionRoot.toLowerCase() && normalizedRoot.toLowerCase() === normalizedCwd.toLowerCase()
        : normalizedRoot === normalizedSessionRoot && normalizedRoot === normalizedCwd;
      if (!sameRoot) {
        throw new Error("OMP workspace changed; reconnect before using Host tools");
      }
      const hostToolCallId = `omp-host:${input.sessionId}:${input.toolCallId}`;
      const abort = () => {
        void host.call("tools.abort", { sessionId: input.sessionId, toolCallId: hostToolCallId }).catch(() => undefined);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      try {
        return await host.call("tools.execute", {
          sessionId: input.sessionId,
          ...(activeTurns.get(input.sessionId) ? { turnId: activeTurns.get(input.sessionId) } : {}),
          toolCallId: hostToolCallId,
          toolName: input.toolName,
          args: input.args,
          mode: session.mode ?? "agent",
          timeoutMs: 120_000,
        });
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
    },
  }) : undefined;
  onOmpRpcRuntimeCreated?.(ompRpcRuntime);
  const ompSessionContext = async (event: IpcMainInvokeEvent, input: any) => {
    registrar.assertMainWindowSender(event);
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
    return resolveOmpSessionContext(sessionId);
  };
  const recoverOmpForkTranscriptSync = async (sessionId: string) => {
    const runtime = ompRpcRuntime;
    if (!runtime) return;
    const pending = await runtime.pendingForkTranscriptSync(sessionId);
    if (!pending) return;
    const host = getHost();
    if (!host) throw new Error("PI Host is unavailable while recovering an OMP fork");
    const [parentRecord, childRecord] = await Promise.all([
      host.call<{ session?: { agentEngine?: string } | null }>("session.get", { id: pending.parentSessionId, messageLimit: 1 }),
      host.call<{ session?: { agentEngine?: string } | null }>("session.get", { id: pending.childSessionId, messageLimit: 1 }),
    ]);
    const parentIsOmp = parentRecord.session?.agentEngine === "omp";
    const childIsOmp = childRecord.session?.agentEngine === "omp";
    let parentMapped = parentIsOmp && await runtime.hasMappedSession(pending.parentSessionId);
    const childMapped = childIsOmp && await runtime.hasMappedSession(pending.childSessionId);
    // The intent record stores the exact old native parent file before OMP is
    // asked to fork. If the process died before the paired mapping commit, put
    // that parent back on its canonical file rather than allowing OMP to open
    // whichever sibling happens to be newest.
    if (parentIsOmp && !parentMapped && pending.parentSessionFile) {
      await runtime.restoreForkParentMapping(pending.parentSessionId, pending.parentSessionFile);
      parentMapped = true;
    }
    if (parentIsOmp && !parentMapped) {
      // Older recovery records may not include the pre-fork file. Guessing
      // from OMP's newest-session ordering could attach the parent's PI chat to
      // its child branch, so leave the journal intact and fail closed.
      throw new Error("OMP 分叉恢复记录缺少原始父会话文件，无法安全猜测；恢复记录已保留，请先修复会话映射。");
    }

    const persistOne = async (id: string) => {
      const context = await resolveOmpSessionContext(id);
      await runtime.connect(context);
      const result = await runtime.command(id, "get_messages");
      const snapshot = normalizeOmpTranscriptSnapshot(result.data);
      if (!snapshot.ok) throw new Error(`OMP native fork history cannot be safely reconciled: ${snapshot.reason}`);
      await host.call("session.replaceMessages", { sessionId: id, messages: snapshot.messages });
    };

    if (parentIsOmp && childIsOmp && parentMapped && childMapped) {
      const parentContext = await resolveOmpSessionContext(pending.parentSessionId);
      const childContext = await resolveOmpSessionContext(pending.childSessionId);
      await runtime.connect(parentContext);
      await runtime.connect(childContext);
      const [parentResult, childResult] = await Promise.all([
        runtime.command(pending.parentSessionId, "get_messages"),
        runtime.command(pending.childSessionId, "get_messages"),
      ]);
      const parentSnapshot = normalizeOmpTranscriptSnapshot(parentResult.data);
      const childSnapshot = normalizeOmpTranscriptSnapshot(childResult.data);
      if (!parentSnapshot.ok || !childSnapshot.ok) throw new Error("OMP native fork history cannot be safely reconciled with the PI transcript");
      // The journal is retired only after both idempotent Host replacements
      // succeed. A crash or transient write error leaves it replayable.
      await persistOmpForkTranscriptSnapshots({
        parentSessionId: pending.parentSessionId,
        childSessionId: pending.childSessionId,
        parentMessages: parentSnapshot.messages,
        childMessages: childSnapshot.messages,
        replaceMessages: (id, messages) => host.call("session.replaceMessages", { sessionId: id, messages }),
        complete: (parentId, childId) => runtime.completeForkTranscriptSync(parentId, childId),
      });
      return;
    }

    // An OMP child without a durable native mapping means the process died
    // before fork commit. Roll back the empty PI child, preserve/resync the
    // original parent, and remove stale mappings for conversations deleted by
    // the user. Never recreate a deleted PI chat from an orphaned OMP file.
    if (parentIsOmp && parentMapped) await persistOne(pending.parentSessionId);
    else await runtime.discardSessionMapping(pending.parentSessionId);
    if (childIsOmp && !childMapped) {
      await host.call("session.delete", { id: pending.childSessionId });
      await runtime.discardSessionMapping(pending.childSessionId);
    } else if (childIsOmp && childMapped) {
      await persistOne(pending.childSessionId);
    } else {
      await runtime.discardSessionMapping(pending.childSessionId);
    }
    await runtime.completeForkTranscriptSync(pending.parentSessionId, pending.childSessionId);
  };
  registrar.handleWithEvent(IPC.invoke.ompRpcAttach, async (event, input) => {
    const context = await ompSessionContext(event, input);
    await recoverOmpForkTranscriptSync(context.sessionId);
    // The composer's model picker only needs provider/model metadata, and the
    // full transcript is the slowest part of an attach on long sessions.
    return ompRpcRuntime!.attach(context, { includeMessages: input?.skipMessages !== true });
  });
  registrar.handleWithEvent(IPC.invoke.ompRpcCommand, async (event, input) => {
    const context = await ompSessionContext(event, input);
    const command = typeof input?.command === "string" ? input.command : "";
    if (context.sessionId === OMP_SETTINGS_RPC_SESSION_ID) {
      const managementCommands = new Set(["get_state", "get_available_models", "get_available_thinking_levels", "get_login_providers", "get_logout_accounts", "login", "logout", "set_model"]);
      if (!managementCommands.has(command)) throw new Error(`OMP settings cannot run RPC command: ${command}`);
      await ompRpcRuntime!.connect(context);
      const result = await ompRpcRuntime!.command(context.sessionId, command, input?.fields && typeof input.fields === "object" ? input.fields : {});
      // Live chat sessions froze their model catalog at boot; a credential change
      // here must invalidate them or the picker keeps hiding the new provider.
      if (command === "login" || command === "logout") ompRpcRuntime!.markCatalogStale();
      return result;
    }
    const allowedCommands = new Set([
      "get_state", "get_messages", "get_messages_page", "get_entries", "get_tree", "get_branch_messages", "get_last_assistant_text", "get_session_stats",
      "get_available_commands", "get_available_models", "get_available_thinking_levels", "set_model", "cycle_model", "set_thinking_level", "cycle_thinking_level",
      "set_fast_mode", "set_slow_mode", "set_steering_mode", "set_follow_up_mode", "set_interrupt_mode", "set_auto_compaction", "set_auto_retry", "set_cache_warming",
      "prompt", "steer", "follow_up", "abort", "abort_and_prompt", "abort_and_restore_queue", "remove_queued_message", "promote_queued_message",
      "new_session", "switch_session", "branch", "fork", "open_session", "navigate_tree", "abort_branch_summary", "set_label", "set_session_name", "export_html", "handoff",
      "goal", "set_todos", "compact", "bash", "get_subagents", "get_subagent_messages", "cancel_subagent", "steer_subagent",
      "get_login_providers", "login", "get_logout_accounts", "logout", "set_ask_dialog", "get_btw_history", "btw", "btw_cancel",
      // Public OMP RPC-UI surfaces used by the native GUI controls and session management.
      "live_start", "live_connect", "live_stop", "live_mute", "dictation_start", "dictation_stop",
      "predict_word", "predict_word_feedback", "set_subagent_subscription", "set_event_filter",
      "abort_retry", "abort_bash", "get_session_lease",
    ]);
    if (!allowedCommands.has(command)) throw new Error(`OMP RPC command is not exposed by the desktop adapter: ${command}`);
    // Controls (session stats, subagents, dictation, word prediction, etc.) can
    // be the first UI to touch a restored OMP conversation. Do not rely on the
    // first prompt or model-picker attach having started its RPC process.
    const fields = input?.fields && typeof input.fields === "object" ? input.fields : {};
    const agentId = typeof fields.subagentId === "string" ? fields.subagentId : "";
    const fromByte = Number.isSafeInteger(fields.fromByte) && Number(fields.fromByte) >= 0 ? Number(fields.fromByte) : 0;
    let result: Record<string, any>;
    try {
      await ompRpcRuntime!.connect(context);
      result = await ompRpcRuntime!.command(context.sessionId, command, fields) as Record<string, any>;
    } catch (cause) {
      if (command === "get_subagents") {
        try {
          const archived = await ompSubagentArchive.getRoster(context.sessionId);
          if (archived.length) return { type: command, success: true, data: { subagents: archived, archived: true } };
        } catch (archiveError) {
          logger.app("omp-rpc", "warn", "OMP subagent archive could not be read", { sessionId: context.sessionId, data: String(archiveError) });
        }
      }
      if (command === "get_subagent_messages" && agentId) {
        try {
          const archived = await ompSubagentArchive.getTranscript(context.sessionId, agentId);
          if (archived?.messages.length) {
            return {
              type: command,
              success: true,
              data: { messages: fromByte === 0 ? archived.messages : [], nextByte: archived.nextByte, archived: true },
            };
          }
        } catch (archiveError) {
          logger.app("omp-rpc", "warn", "OMP subagent transcript archive could not be read", { sessionId: context.sessionId, data: String(archiveError) });
        }
      }
      throw cause;
    }
    const data = result.data && typeof result.data === "object" ? result.data as Record<string, any> : {};
    if (command === "get_subagents") {
      const live = Array.isArray(data.subagents) ? data.subagents.filter((agent: any) => agent && typeof agent.id === "string") : [];
      let archivedAndLive = live;
      try {
        archivedAndLive = await ompSubagentArchive.mergeRoster(context.sessionId, live);
      } catch (archiveError) {
        logger.app("omp-rpc", "warn", "OMP subagent archive could not be merged", { sessionId: context.sessionId, data: String(archiveError) });
      }
      if (live.length) scheduleOmpSubagentCapture(context.sessionId, 400);
      return { ...result, data: { ...data, subagents: archivedAndLive } };
    }
    if (command === "get_subagent_messages") {
      const liveMessages = Array.isArray(data.messages) ? data.messages : [];
      if (agentId && liveMessages.length) {
        try {
          await ompSubagentArchive.appendTranscript(context.sessionId, agentId, {
            fromByte,
            nextByte: data.nextByte,
            reset: data.reset,
            messages: liveMessages,
          });
        } catch (archiveError) {
          logger.app("omp-rpc", "warn", "OMP subagent transcript snapshot write failed", { sessionId: context.sessionId, data: String(archiveError) });
        }
      } else if (agentId && fromByte === 0) {
        try {
          const archived = await ompSubagentArchive.getTranscript(context.sessionId, agentId);
          if (archived?.messages.length) {
            return { ...result, data: { ...data, messages: archived.messages, nextByte: archived.nextByte, archived: true } };
          }
        } catch (archiveError) {
          logger.app("omp-rpc", "warn", "OMP subagent transcript archive could not be read", { sessionId: context.sessionId, data: String(archiveError) });
        }
      }
    }
    return result;
  });
  registrar.handleWithEvent(IPC.invoke.ompRpcReopenWithModel, async (event, input) => {
    const context = await ompSessionContext(event, input);
    if (context.sessionId === OMP_SETTINGS_RPC_SESSION_ID) {
      throw Object.assign(new Error("OMP 设置会话不能切换聊天模型"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    const provider = typeof input?.provider === "string" ? input.provider.trim() : "";
    const modelId = typeof input?.modelId === "string" ? input.modelId.trim() : "";
    if (!provider || !modelId) {
      throw Object.assign(new Error("OMP 模型覆盖需要 provider 与 modelId"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    // Cross-provider migration stays a renderer decision: it asks the user to
    // confirm that later context goes to the new vendor. Main only executes
    // the explicit pair and never substitutes a model on its own.
    await ompRpcRuntime!.openSessionWithModel(context, provider, modelId);
    logger.app("omp-rpc", "info", "OMP conversation reopened with explicit model", {
      sessionId: context.sessionId,
      data: { provider, modelId },
    });
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.ompRpcForkSession, async (event, input) => {
    const context = await ompSessionContext(event, input);
    const entryId = typeof input?.entryId === "string" ? input.entryId.trim() : "";
    if (!entryId || entryId.length > 512) throw new Error("OMP fork entry is invalid");
    const host = getHost();
    if (!host) throw new Error("Host 不可用");
    const sourceResult = await host.call<{ session?: Record<string, any> | null }>("session.get", { id: context.sessionId, messageLimit: 1 });
    const source = sourceResult.session;
    if (!source || source.agentEngine !== "omp") throw new Error("只能从 OMP 原生会话创建分叉");
    if (source.remoteWorkspace) throw new Error("OMP 分叉目前仅支持本机工作区会话");
    await ompRpcRuntime!.connect(context);
    const nativeTree = await ompRpcRuntime!.command(context.sessionId, "get_tree");
    const treeData = nativeTree.data as { tree?: unknown } | undefined;
    const findEntry = (nodes: unknown): any | null => {
      if (!Array.isArray(nodes)) return null;
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const candidate = node as { entry?: any; children?: unknown };
        if (candidate.entry?.id === entryId) return candidate.entry;
        const nested = findEntry(candidate.children);
        if (nested) return nested;
      }
      return null;
    };
    const selectedEntry = findEntry(treeData?.tree);
    if (!selectedEntry || !["user", "assistant"].includes(selectedEntry.message?.role)) {
      throw new Error("分叉起点必须是当前 OMP 会话树中的用户或 assistant 消息");
    }
    const titleBase = typeof source.title === "string" && source.title.trim() ? source.title.trim() : "OMP conversation";
    const createInput = {
      title: `Fork: ${titleBase}`.slice(0, 80),
      mode: typeof source.mode === "string" ? source.mode : "agent",
      agentEngine: "omp",
      ...(typeof source.projectPath === "string" ? { projectPath: source.projectPath } : {}),
      ...(typeof source.providerId === "string" ? { providerId: source.providerId } : {}),
      ...(typeof source.modelId === "string" ? { modelId: source.modelId } : {}),
      ...(typeof source.thinkingLevel === "string" ? { thinkingLevel: source.thinkingLevel } : {}),
      ...(typeof source.permissionMode === "string" ? { permissionMode: source.permissionMode } : {}),
    };
    const created = await host.call<{ session?: (Record<string, any> & { id?: string }) | null }>("session.create", createInput);
    const targetSessionId = typeof created.session?.id === "string" ? created.session.id : "";
    if (!targetSessionId) throw new Error("Host 未创建 OMP 分叉会话");
    let forked: { messages: unknown[]; parentMessages: unknown[] };
    try {
      forked = await ompRpcRuntime!.forkToSession({
        sessionId: context.sessionId,
        targetSessionId,
        cwd: context.cwd,
        ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
        entryId,
      });
    } catch (error) {
      // Runtime-level failure compensates the native file switch. Remove the
      // PI placeholder only for this pre-commit failure; after forkToSession
      // returns, its journal and both mappings become the recovery authority.
      await ompRpcRuntime!.completeForkTranscriptSync(context.sessionId, targetSessionId).catch(() => undefined);
      await ompRpcRuntime!.discardSessionMapping(targetSessionId).catch(() => undefined);
      await host.call("session.delete", { id: targetSessionId }).catch(() => undefined);
      throw error;
    }

    try {
      // Re-opening the original OMP session file may restore its persisted
      // leaf rather than the renderer's previous in-memory tree cursor. Keep
      // the source PI mirror aligned with that verified native parent too.
      await persistOmpForkTranscriptSnapshots({
        parentSessionId: context.sessionId,
        childSessionId: targetSessionId,
        parentMessages: forked.parentMessages as UiMessage[],
        childMessages: forked.messages as UiMessage[],
        replaceMessages: (id, messages) => host.call("session.replaceMessages", { sessionId: id, messages }),
        complete: (parentId, childId) => ompRpcRuntime!.completeForkTranscriptSync(parentId, childId),
      });
    } catch (syncError) {
      // A transient Host write may happen after OMP and its paired file mapping
      // are already committed. Retry from canonical OMP snapshots immediately;
      // if Host is still unavailable, keep the journal and both chats so the
      // next attach can safely replay them instead of deleting the only child.
      try {
        await recoverOmpForkTranscriptSync(context.sessionId);
      } catch (recoveryError) {
        const detail = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        throw new Error(`OMP 分叉已创建，但桌面对话记录同步暂未完成；恢复记录已保留，重新打开父/子对话会自动重试。${detail ? ` ${detail}` : ""}`, { cause: syncError });
      }
    }
    const { providers, defaults } = await sessionCapabilityContext();
    if (typeof source.projectPath === "string") sessionProjects.set(targetSessionId, source.projectPath);
    return { session: enrichSession(created.session!, providers, defaults), parentMessages: forked.parentMessages };
  });
  registrar.handleWithEvent(IPC.invoke.ompRpcUiResponse, async (event, input) => {
    const context = await ompSessionContext(event, input);
    if (!input?.response || typeof input.response !== "object" || Array.isArray(input.response)) throw new Error("OMP UI response is invalid");
    ompRpcRuntime!.respondExtensionUi(context.sessionId, input.response);
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.ompMicrophoneAcquire, async (event, input) => {
    const context = await ompSessionContext(event, input);
    if (context.sessionId === OMP_SETTINGS_RPC_SESSION_ID || !ompRpcRuntime!.isRunning(context.sessionId)) {
      throw new Error("当前 OMP 会话未运行，无法申请麦克风权限");
    }
    const owner = liveOwnerFromInvoke(event, getMainWindow());
    if (!dependencies.ompMicrophoneLeases) throw new Error("OMP 麦克风权限服务不可用");
    dependencies.ompMicrophoneLeases.acquire(context.sessionId, owner);
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.ompMicrophoneRelease, async (event, input) => {
    const context = await ompSessionContext(event, input);
    const owner = liveOwnerFromInvoke(event, getMainWindow());
    dependencies.ompMicrophoneLeases?.release(context.sessionId, owner);
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.ompManagementStop, async (event) => {
    registrar.assertMainWindowSender(event);
    await ompRpcRuntime?.stop(OMP_SETTINGS_RPC_SESSION_ID);
    return { ok: true };
  });
  registerSettingsIpc({
    registrar,
    getHost,
    getSidecar,
    dataDir,
    normalizeSettings,
    validateSettingsWrite,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings,
    applyDeveloperMode,
    applyPreventScreenSleep,
    applyKeepAwakeWhileRunning,
    applyUpdatePreference: (preference) => updater.setPreference(preference),
    resolveEffectiveCommandShell,
    liveCallService,
    stopComputerUse: async () => {
      const active = getActiveComputerUseRun();
      if (!active) return;
      const host = getHost();
      if (!host) throw new Error("Computer Use is active but its host is unavailable");
      await host.call("computer.grantRevoke", { reason: "user" });
      await abortAgentRun(active.sessionId);
    },
    ompEngine,
    piEngine,
    openPiReleases: () => safeOpenExternal("https://github.com/vastsa/PI-Desktop/releases"),
    openPiDependencyRepository: () => safeOpenExternal("https://github.com/earendil-works/pi"),
    openOmpReleases: () => safeOpenExternal("https://github.com/can1357/oh-my-pi/releases"),
    openOmpEngineStorageFolder: async () => {
      if (!ompEngine) throw new Error("当前平台不支持 OMP 引擎");
      const directory = await ompEngine.ensureVersionsDirectory();
      const error = await shell.openPath(directory);
      if (error) throw new Error(`无法打开 OMP 引擎存放目录：${error}`);
    },
    isOmpManagementRunning: () => ompRpcRuntime?.isRunning(OMP_SETTINGS_RPC_SESSION_ID) === true,
    onOmpCatalogChanged: () => ompRpcRuntime?.markCatalogStale(),
    emitOmpProgress: (progress) => sendToRenderer(IPC.event.ompEngineProgress, progress),
    emitPiProgress: (progress) => sendToRenderer(IPC.event.piEngineProgress, progress),
    selectOmpBinary: async () => {
      const options: OpenDialogOptions = {
        title: "Select the official oh-my-pi executable",
        properties: ["openFile"],
        filters: [{ name: "oh-my-pi executable", extensions: process.platform === "win32" ? ["exe"] : ["*"] }],
      };
      const parentWindow = getMainWindow();
      const picked = parentWindow
        ? await dialog.showOpenDialog(parentWindow, options)
        : await dialog.showOpenDialog(options);
      return picked.canceled ? null : picked.filePaths[0] ?? null;
    },
  });
  registerConfigSyncIpc({
    registrar,
    getHost,
    sendToRenderer,
  });
  registerBackgroundTasksIpc({
    registrar,
    getHost,
  });
  registerArtifactsIpc({ registrar, getHost });
  registerProviderIpc({
    registrar,
    getHost,
    modelsDevCatalog,
    vendorOAuth,
    logger,
    enrichProvider,
    listRuntimeProviders,
    enrichProviderList,
    bindingForModel,
    onProviderInvalidated: (providerId) => liveCallService?.invalidateProvider(providerId),
  });
  registerJevIpc({ registrar, logger });
  registerWorktreeIpc({
    registrar,
    getHost,
    logger,
    openPath: (path) => shell.openPath(path),
    stripWinLongPrefix,
  });
  registerGitHubPrReviewIpc({
    registrar,
    sessionProjects: sessionProjects ?? new Map(),
    fetchImpl: (url, init) => net.fetch(url, init),
    openExternal: safeOpenExternal,
    secrets: {
      getSecret: async (secretRef) => {
        const host = getHost();
        if (!host) throw new Error("host unavailable");
        const result = await host.call<{ value?: string | null }>("secrets.getForRuntime", { secretRef });
        return typeof result.value === "string" ? result.value : null;
      },
      setSecret: async (secretRef, value) => {
        const host = getHost();
        if (!host) throw new Error("host unavailable");
        await host.call("secrets.set", { secretRef, value });
      },
      deleteSecret: async (secretRef) => {
        const host = getHost();
        if (!host) throw new Error("host unavailable");
        await host.call("secrets.delete", { secretRef });
      },
    },
  });
  const loadComposerTemplatesCached = createComposerTemplateLoader(logger);
  const composerCommandService = registerComposerIpc({
    registrar,
    userMcp,
    refreshUserMcp,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    activeUserSkills,
    disabledBuiltinSkills: runtimeDisabledBuiltinSkills,
    pluginActiveInProject,
    loadComposerTemplatesCached,
  });
  registerWindowIpc({
    setTraySessionPreferences: traySessions.setPreferences,
    registrar,
    dataDir,
    getMainWindow,
    getWorkPanelReservationWidth,
    setWorkPanelReservationWidth,
    setWorkPanelReservation,
    getWorkPanelChatWidthSetter,
    getWindowMinimumSize,
    applyCloseBehavior,
    getCloseBehavior,
    isMacosWindowTranslucent,
    markMenuRendererReady,
    markLifecycleDialogRendererReady,
    respondLifecycleDialog,
    executeNativeMenuAction,
  });
  registerScheduledIpc({
    registrar,
    getHost,
    scheduledRunsBySession,
    isQuitting: dependencies.isQuitting,
    invoke: async (channel, args) => {
      const handler = ipcHandlers.get(channel);
      if (!handler) throw new Error("scheduled prompt handler unavailable");
      return handler(...args);
    },
  });
  registerWorkspaceIpc({
    registrar,
    getMainWindow,
    getHost,
    getSidecar,
    dataDir,
    isDevelopmentBuild,
    plugins,
    browserHost,
    clipboardHistory,
    recordPastedClipboardFiles,
    currentWorkspacePath,
    setCurrentWorkspacePath,
    withGitBranch,
    stripWinLongPrefix,
  });

  registerAgentExtensionIpc({
    handle,
    bridge: agentExtensions,
    window: getMainWindow,
    dialogs: dialog,
    getLocale: getUpdaterLocale,
    getNpmPath: () => readNpmPath(dataDir),
    setNpmPath: (path) => writeNpmPath(dataDir, path),
    importRoot: join(dataDir, "plugins", "imported"),
    loadDevPlugin: async (path) => {
      const currentHost = getHost();
      if (!currentHost) throw new Error("host unavailable");
      const loaded = await currentHost.call<{ plugin: any }>("plugins.loadDev", { path });
      await plugins.loadFromPath(path, loaded.plugin?.permissions ?? [], { development: true });
      if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
      sendToRenderer(IPC.event.pluginChanged, { reason: "importExtension", pluginId: loaded.plugin?.id });
      return loaded;
    },
    runCommand: async (input) => {
      const currentSidecar = getSidecar();
      if (!currentSidecar) throw new Error("agent sidecar unavailable");
      return currentSidecar.call<{ handled: boolean }>("extensions.command.run", input);
    },
  });
  registerAgentIpc({
    registrar,
    ompRpcRuntime,
    managedSessions: createManagedSessionRouter({
      owner: async (sessionId) => {
        const host = getHost();
        if (!host) throw new Error("host unavailable");
        const result = await host.call<{ pluginId: string | null }>("session.managedOwner", { sessionId });
        return result.pluginId;
      },
      projectPath: async (sessionId) => {
        const host = getHost();
        if (!host) return undefined;
        // Only the session's project path is needed, so the read window is left
        // to the host default. Requesting a zero-length window trips the
        // host-core guard ("positive messageLimit") and would fail every
        // managed send before it reached the plugin.
        const result = await host.call<{ session?: { projectPath?: string | null } }>("session.get", {
          id: sessionId,
        });
        return result.session?.projectPath ?? undefined;
      },
      submit: (pluginId, input) => plugins.submitManagedSession(pluginId, input),
      grantAttachment: (pluginId, sessionId, ref) =>
        pluginServices.grantManagedAttachment(pluginId, sessionId, ref),
      dataDir,
    }),
    getHost,
    getSidecar,
    getAgentHostBridge,
    cancelSessionTools: (sessionId: string, reason?: string) => {
      plugins.cancelSessionTools(sessionId, reason);
      userMcp.cancelSessionCalls(sessionId);
    },
    logger,
    agentExtensions,
    persistenceOutbox,
    dataDir,
    activeTurns,
    completionNoticeTurns,
    recordTurnStart,
    isTurnDispatchable,
    activeTurnUsages,
    approvedExecutionIdsBySession,
    claimedExecutionSessions,
    resolveAgentRuntimeLaunch,
    acquireSessionOperation,
    beginManualCompaction,
    endManualCompaction,
    finishTurn,
    lockAbortReason,
    finishApprovedExecution,
    dispatchApprovedPlan,
    dispatchExecutionForProposal,
    emitAgentEvent,
    setNotificationViewingSessionId,
    optionalWorkspaceRoot,
    composerCommandService,
    loadComposerTemplatesCached,
  });

  registerPluginIpc({
    registrar,
    getHost,
    plugins,
    agentExtensions,
    browserHost,
    pluginViews,
    pluginScopes,
    rememberPluginScopes,
    sendToRenderer,
    logger,
  });


  registerMcpIpc({
    registrar,
    getHost,
    userMcp,
    oauth: mcpOAuth,
    currentWorkspacePath,
    refreshUserMcp,
    describeError,
    sendToRenderer,
    searchMcpMarket,
  });


  registerSkillsIpc({
    registrar,
    getHost,
    searchSkillMarket,
    fetchSkillMarketDocument,
    optionalWorkspaceRoot,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    disabledBuiltinSkills,
    stripWinLongPrefix,
    sendToRenderer,
    logger,
  });


  registerAgentImportIpc({
    registrar,
    getHost,
    sendToRenderer,
    refreshUserMcp,
    currentWorkspacePath,
  });

  registerPluginUiIpc({
    registrar,
    plugins,
    browserHost,
    pluginViews,
    pluginPanels,
    pluginActiveInProject,
    currentWorkspacePath,
    getUpdaterLocale,
    getPluginPanelTheme,
    setActivePluginSession,
    settleComposerSuggestion,
  });
  registerPluginLauncherIpc({
    registrar,
    getHost,
    getPluginLauncherWindow,
    plugins,
    localApps,
    getLocale: getUpdaterLocale,
    openPluginMarket,
  });
  registerSpeechIpc({ registrar, speech });

  if (voiceService) {
    registerVoiceIpc({ registrar, voiceService });
  }
  if (liveCallService && liveVoiceWidget) {
    registerLiveVoiceIpc({ registrar, service: liveCallService, getMainWindow, widget: liveVoiceWidget });
  }
  registerComputerUseIpc({ registrar, getHost, abortAgentRun, widget: computerUseWidget });

  registerRemoteHostIpc({ registrar });

  registerMarketIpc({
    registrar,
    getHost,
    plugins,
    agentExtensions,
    optionalWorkspaceRoot,
    pluginActiveInProject,
    sendToRenderer,
  });


  registerDiagnosticsIpc({
    registrar,
    dataDir,
    stripWinLongPrefix,
    isDeveloperMode,
    getMainWindow,
  });


  return async (channel: string, args: readonly unknown[] = []) => {
    const handler = ipcHandlers.get(channel);
    if (!handler) {
      throw Object.assign(new Error(`IPC channel is not available to external agents: ${channel}`), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return handler(...args);
  };
}
