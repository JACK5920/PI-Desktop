import type {
  AgentEventEnvelope,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";
import { applyMessageUpdate } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { createNavigationIntentController } from "../../lib/navigation-intent";
import {
  dedupeSessionMessages,
  durableCoversLiveSessionMessages,
  mergeLiveSessionMessages,
  projectMessageEnd,
  removeLiveSessionMessage,
  upsertLiveSessionMessage,
} from "../../lib/session-transcript";
import { getSessionMessageSnapshot, getSessionToolMessagePositions } from "../../lib/session-transcript-updates";
import { sessionReadLooksEmpty } from "../../lib/session-transcript-read";
import { isAutomationSession } from "../../lib/session-origin";
import { sessionIsArchived, type SessionMeta } from "../../lib/sidebar-preferences";
import {
  normalizeProjectPath,
  sessionMatchesProject,
} from "../../lib/sidebar-session-groups";
import type { ComposerDraftSnapshot } from "../../lib/composer-smart-stop";
import { formatToolValue } from "../../lib/tool-display";
import { recordPaneTranscript } from "../../lib/session-panes";
import type { AppState, SessionHistoryWindow } from "../app-state";
import type { StoreAccess } from "../slices/types";

export const SESSION_TRANSCRIPT_CACHE_LIMIT = 20;
export const SESSION_TRANSCRIPT_PAGE_SIZE = 100;
export const SESSION_TRANSCRIPT_CONTENT_LIMIT = 64 * 1024;
export const PENDING_PROMPT_ATTEMPT_LIMIT = 100;

export type SubmittedComposerDraft = {
  messageCountBeforeSend: number;
  draft: ComposerDraftSnapshot;
  abortResolution?: Promise<boolean>;
  resolveAbort?: (restored: boolean) => void;
};

export type SessionConfiguration = Pick<
  SessionSummary,
  "mode" | "providerId" | "modelId" | "thinkingLevel"
> &
  Partial<
    Pick<SessionSummary, "permissionMode" | "fastMode" | "agentEngine">
  >;

export type SessionSelection = { id: string; intent: number };

export type SessionRuntime = {
  readonly pendingNewSessionRequests: Map<string, Promise<string | null>>;
  readonly sessionTranscriptCache: Map<string, UiMessage[]>;
  readonly liveSessionTranscripts: Set<string>;
  readonly sessionHistoryCache: Map<string, SessionHistoryWindow>;
  readonly submittedComposerDrafts: Map<string, SubmittedComposerDraft>;
  readonly pendingPromptAttempts: Map<string, Map<string, UiMessage>>;
  readonly promptSubmissionStates: Map<string, Map<string, "sending" | "accepted">>;
  readonly pendingSessionConfigurations: Map<string, SessionConfiguration>;
  readonly sessionConfigurationFlushes: Map<string, Promise<void>>;
  beginNavigationIntent: () => number;
  navigationIntentIsCurrent: (intent: number) => boolean;
  newSessionScopeKey: (projectPath?: string | null) => string;
  latestSessionInScope: (
    sessions: SessionSummary[],
    projectPath: string | null,
    sessionMeta: Record<string, SessionMeta>,
  ) => SessionSummary | undefined;
  liveMessageCountForSession: (
    id: string,
    state: Pick<AppState, "activeSessionId" | "messages" | "retainedTranscripts">,
  ) => number;
  cacheSessionTranscript: (
    id: string,
    messages: UiMessage[],
    window?: SessionHistoryWindow,
  ) => void;
  syncTranscriptProjection: (state: AppState, previous: AppState) => void;
  loadSessionDetail: (
    id: string,
    options?: {
      messageBefore?: number;
      messageLimit?: number;
      contentLimit?: number;
    },
  ) => ReturnType<typeof api.getSession>;
  loadFullSessionMessages: (id: string, cache?: boolean) => Promise<UiMessage[] | null>;
  insertOptimisticUserMessage: (sessionId: string, message: UiMessage) => void;
  retractOptimisticUserMessage: (sessionId: string, message: UiMessage) => void;
  markPendingPromptFailed: (sessionId: string, message: UiMessage) => void;
  clearPendingPromptAttempt: (sessionId: string, messageId: string) => void;
  patchSessionMessage: (sessionId: string, messageId: string, patch: Partial<UiMessage>) => void;
  beginPromptSubmission: (sessionId: string, messageId: string) => void;
  acceptPromptSubmission: (sessionId: string, messageId: string) => void;
  promptSubmissionWasAccepted: (sessionId: string, messageId: string) => boolean;
  clearPromptSubmission: (sessionId: string, messageId: string) => void;
  cacheBackgroundTranscriptEvent: (envelope: AgentEventEnvelope) => void;
  mergeSessionConfiguration: (
    current: SessionConfiguration | undefined,
    next: SessionConfiguration,
  ) => SessionConfiguration;
  queueWorkspaceAlignment: <T>(task: () => Promise<T>) => Promise<T>;
  beginSessionSelection: (id: string, intent: number) => SessionSelection;
  isCurrentSessionSelection: (selection: SessionSelection) => boolean;
  isSessionSelectionPending: (sessionId: string) => boolean;
  clearSessionSelection: (selection: SessionSelection) => void;
  isSessionSelectionForIntent: (intent: number) => boolean;
  recordToolStart: (
    toolCallId: string,
    value: {
      toolName: string;
      args: unknown;
      createdAt: string;
      parentToolCallId?: string;
      nestedParentToolCallId?: string;
      agentName?: string;
      engineOrigin?: "pi" | "omp";
    },
  ) => void;
  getToolStart: (toolCallId: string) => {
    toolName: string;
    args: unknown;
    createdAt: string;
    parentToolCallId?: string;
    nestedParentToolCallId?: string;
    agentName?: string;
    engineOrigin?: "pi" | "omp";
  } | undefined;
  removeToolStart: (toolCallId: string) => void;
  nextPlanSyncGeneration: (sessionId: string) => number;
  planSyncGeneration: (sessionId: string) => number;
};

type ToolStart = NonNullable<ReturnType<SessionRuntime["getToolStart"]>>;

export function createSessionRuntime({ get, set }: StoreAccess): SessionRuntime {
  const navigationIntents = createNavigationIntentController();
  let pendingSessionSelection: SessionSelection | null = null;
  let sessionWorkspaceQueue: Promise<unknown> = Promise.resolve();

  const pendingNewSessionRequests = new Map<string, Promise<string | null>>();
  const sessionTranscriptCache = new Map<string, UiMessage[]>();
  // Monotonic per-session projection revision. A session-detail request may be
  // in flight while an edit, stream event, or terminal update changes the
  // renderer-owned transcript. The response is only a valid cache candidate
  // when this revision is unchanged from request start.
  const sessionTranscriptRevisions = new Map<string, number>();
  const liveSessionTranscripts = new Set<string>();
  const sessionHistoryCache = new Map<string, SessionHistoryWindow>();
  const submittedComposerDrafts = new Map<string, SubmittedComposerDraft>();
  const pendingPromptAttempts = new Map<string, Map<string, UiMessage>>();
  const promptSubmissionStates = new Map<string, Map<string, "sending" | "accepted">>();
  const pendingSessionConfigurations = new Map<string, SessionConfiguration>();
  const sessionConfigurationFlushes = new Map<string, Promise<void>>();
  const sessionDetailLoads = new Map<string, ReturnType<typeof api.getSession>>();
  const toolStartsByCallId = new Map<string, ToolStart>();
  const planSyncGenerations = new Map<string, number>();

  function publishSideChatTranscript(id: string, messages: UiMessage[]): void {
    const state = get();
    const matching = Object.values(state.sideChats ?? {}).filter(
      (sideChat) => sideChat.childSessionId === id && sideChat.messages !== messages,
    );
    if (matching.length === 0) return;
    set((current) => {
      let changed = false;
      const sideChats = { ...current.sideChats };
      for (const [sideChatId, sideChat] of Object.entries(sideChats)) {
        if (sideChat.childSessionId !== id || sideChat.messages === messages) continue;
        sideChats[sideChatId] = { ...sideChat, messages };
        changed = true;
      }
      return changed ? { sideChats } : {};
    });
  }

  function cacheSessionTranscript(
    id: string,
    messages: UiMessage[],
    window?: SessionHistoryWindow,
  ): void {
    let normalized = dedupeSessionMessages(messages);
    const attempts = pendingPromptAttempts.get(id);
    if (attempts) {
      for (const [messageId, attempt] of attempts) {
        const current = normalized.find((message) => message.id === messageId && message.role === "user");
        if (current) {
          // A durable row with the same stable ID is authoritative even if a
          // stale renderer projection still carries the local error marker.
          attempts.delete(messageId);
          continue;
        }
        normalized = upsertLiveSessionMessage(normalized, attempt);
      }
      if (attempts.size === 0) pendingPromptAttempts.delete(id);
    }
    sessionTranscriptCache.delete(id);
    sessionTranscriptCache.set(id, normalized);
    sessionTranscriptRevisions.set(id, (sessionTranscriptRevisions.get(id) ?? 0) + 1);
    publishSideChatTranscript(id, normalized);
    if (window) sessionHistoryCache.set(id, window);
    while (sessionTranscriptCache.size > SESSION_TRANSCRIPT_CACHE_LIMIT) {
      const oldestId = sessionTranscriptCache.keys().next().value;
      if (typeof oldestId !== "string") break;
      sessionTranscriptCache.delete(oldestId);
      sessionTranscriptRevisions.delete(oldestId);
      sessionHistoryCache.delete(oldestId);
      liveSessionTranscripts.delete(oldestId);
    }
  }

  function loadSessionDetail(
    id: string,
    options?: {
      messageBefore?: number;
      messageLimit?: number;
      contentLimit?: number;
    },
  ) {
    const active = sessionDetailLoads.get(id);
    if (active && options?.messageBefore === undefined) return active;
    const transcriptRevisionAtStart = sessionTranscriptRevisions.get(id) ?? 0;
    const request = api.getSession(id, options).then((detail) => {
      const loadedSession = detail.session;
      if (loadedSession && options?.messageBefore === undefined) {
        const state = get();
        const liveMessages =
          sessionTranscriptCache.get(id) ?? state.retainedTranscripts[id];
        const projectionChangedDuringRead =
          (sessionTranscriptRevisions.get(id) ?? 0) !== transcriptRevisionAtStart;
        const messages =
          (liveSessionTranscripts.has(id) || state.runningSessions[id] || projectionChangedDuringRead) &&
          liveMessages
            ? preferNewerProjectionMessages(
                loadedSession.messages ?? [],
                liveMessages,
              )
            : loadedSession.messages ?? [];
        // Consumers such as selectSession use the returned detail as well as
        // the cache. Return the reconciled row there too, otherwise the cache
        // is correct but the stale promise result can still overwrite it.
        detail = { ...detail, session: { ...loadedSession, messages } };
        // Never cache a suspiciously empty window (issue #795): hover prefetch
        // would then re-serve that emptiness on every later open, and the
        // session could not recover without a restart.
        if (messages.length > 0 || !sessionReadLooksEmpty(loadedSession)) {
          cacheSessionTranscript(id, messages, {
            messageStart: loadedSession.messageStart ?? 0,
            hasMoreBefore: loadedSession.hasMoreBefore === true,
            contentLimited: options?.contentLimit !== undefined,
          });
        }
      }
      return detail;
    });
    if (options?.messageBefore === undefined) sessionDetailLoads.set(id, request);
    const clear = () => {
      if (
        options?.messageBefore === undefined &&
        sessionDetailLoads.get(id) === request
      ) {
        sessionDetailLoads.delete(id);
      }
    };
    void request.then(clear, clear);
    return request;
  }

  function preferNewerProjectionMessages(
    durableMessages: UiMessage[],
    newerProjection: UiMessage[],
  ): UiMessage[] {
    const merged = mergeLiveSessionMessages(durableMessages, newerProjection);
    const newerById = new Map(newerProjection.map((message) => [message.id, message]));
    let changed = false;
    const preferred = merged.map((message) => {
      const newer = newerById.get(message.id);
      if (!newer || newer === message) return message;
      changed = true;
      return newer;
    });
    return changed ? preferred : merged;
  }

  /** Every canonical writer (streaming, edits, retries) shares this cache boundary. */
  function syncTranscriptProjection(state: AppState, previous: AppState) {
    if (state.messages === previous.messages && state.activeSessionId === previous.activeSessionId) return;
    const id = state.activeSessionId;
    if (!id) return;
    if (state.runningSessions[id] || previous.runningSessions[id]) liveSessionTranscripts.add(id);
    cacheSessionTranscript(id, state.messages, state.sessionHistory[id]);
    if (state.retainedTranscripts[id] === state.messages) return;
    set((current) => current.activeSessionId === id
      ? recordPaneTranscript(current, id, current.messages) : {});
  }

  async function loadFullSessionMessages(id: string, cache = true): Promise<UiMessage[] | null> {
    const previous = sessionTranscriptCache.get(id);
    const detail = await api.getSession(id);
    if (!detail.session) return null;
    const messages = detail.session.messages ?? [];
    if (cache && sessionTranscriptCache.get(id) === previous) cacheSessionTranscript(id, messages, {
        messageStart: 0,
        hasMoreBefore: false,
      });
    return messages;
  }

  function insertOptimisticUserMessage(sessionId: string, message: UiMessage): void {
    const state = get();
    if (state.activeSessionId === sessionId) {
      set((current) => ({
        messages: upsertLiveSessionMessage(current.messages, message),
      }));
      return;
    }
    const cached = sessionTranscriptCache.get(sessionId);
    if (cached) {
      const next = upsertLiveSessionMessage(cached, message);
      sessionTranscriptCache.set(sessionId, next);
      publishSideChatTranscript(sessionId, next);
    }
  }

  function retractOptimisticUserMessage(sessionId: string, message: UiMessage): void {
    const state = get();
    if (state.activeSessionId === sessionId) {
      set((current) =>
        current.messages.includes(message)
          ? { messages: removeLiveSessionMessage(current.messages, message.id) }
          : current,
      );
      return;
    }
    const cached = sessionTranscriptCache.get(sessionId);
    if (cached?.includes(message)) {
      const next = removeLiveSessionMessage(cached, message.id);
      sessionTranscriptCache.set(sessionId, next);
      publishSideChatTranscript(sessionId, next);
    }
  }

  function patchSessionMessage(sessionId: string, messageId: string, patch: Partial<UiMessage>): void {
    const state = get();
    if (state.activeSessionId === sessionId) {
      set((current) => {
        const message = current.messages.find((row) => row.id === messageId);
        if (!message) return {};
        return { messages: upsertLiveSessionMessage(current.messages, { ...message, ...patch }) };
      });
    } else {
      const cached = sessionTranscriptCache.get(sessionId);
      const message = cached?.find((row) => row.id === messageId);
      if (cached && message) cacheSessionTranscript(sessionId, upsertLiveSessionMessage(cached, { ...message, ...patch }));
    }
    const attempt = pendingPromptAttempts.get(sessionId)?.get(messageId);
    if (attempt) pendingPromptAttempts.get(sessionId)?.set(messageId, { ...attempt, ...patch });
  }

  function markPendingPromptFailed(sessionId: string, message: UiMessage): void {
    const attempt: UiMessage = { ...message, status: "error" };
    let attempts = pendingPromptAttempts.get(sessionId);
    if (!attempts) {
      attempts = new Map();
      pendingPromptAttempts.set(sessionId, attempts);
    }
    attempts.delete(attempt.id);
    attempts.set(attempt.id, attempt);
    while ([...pendingPromptAttempts.values()].reduce((total, entries) => total + entries.size, 0) > PENDING_PROMPT_ATTEMPT_LIMIT) {
      const oldestSessionEntry = pendingPromptAttempts.entries().next().value;
      if (!oldestSessionEntry) break;
      const [oldestSessionId, oldestAttempts] = oldestSessionEntry;
      const oldestMessageId = oldestAttempts?.keys().next().value;
      if (typeof oldestSessionId !== "string" || typeof oldestMessageId !== "string") break;
      oldestAttempts.delete(oldestMessageId);
      if (oldestAttempts.size === 0) pendingPromptAttempts.delete(oldestSessionId);
    }
    patchSessionMessage(sessionId, message.id, { ...attempt, status: "error" });
    if (get().activeSessionId === sessionId) {
      const current = get().messages.find((row) => row.id === message.id);
      if (!current) set((state) => ({ messages: upsertLiveSessionMessage(state.messages, attempt) }));
    } else {
      const cached = sessionTranscriptCache.get(sessionId) ?? [];
      if (!cached.some((row) => row.id === message.id)) cacheSessionTranscript(sessionId, [...cached, attempt]);
    }
  }

  function clearPendingPromptAttempt(sessionId: string, messageId: string): void {
    const attempts = pendingPromptAttempts.get(sessionId);
    attempts?.delete(messageId);
    if (attempts?.size === 0) pendingPromptAttempts.delete(sessionId);
  }

  function setPromptSubmissionState(sessionId: string, messageId: string, status: "sending" | "accepted"): void {
    let submissions = promptSubmissionStates.get(sessionId);
    if (!submissions) {
      submissions = new Map();
      promptSubmissionStates.set(sessionId, submissions);
    }
    submissions.delete(messageId);
    submissions.set(messageId, status);
    while ([...promptSubmissionStates.values()].reduce((total, entries) => total + entries.size, 0) > PENDING_PROMPT_ATTEMPT_LIMIT) {
      const oldestSessionEntry = promptSubmissionStates.entries().next().value;
      if (!oldestSessionEntry) break;
      const [oldestSessionId, oldestSubmissions] = oldestSessionEntry;
      const oldestMessageId = oldestSubmissions.keys().next().value;
      if (typeof oldestMessageId !== "string") break;
      oldestSubmissions.delete(oldestMessageId);
      if (oldestSubmissions.size === 0) promptSubmissionStates.delete(oldestSessionId);
    }
  }

  function clearPromptSubmission(sessionId: string, messageId: string): void {
    const submissions = promptSubmissionStates.get(sessionId);
    submissions?.delete(messageId);
    if (submissions?.size === 0) promptSubmissionStates.delete(sessionId);
  }

  function acceptPromptSubmission(sessionId: string, messageId: string): void {
    // Confirmation can arrive after the prompt promise already resolved. Do
    // not recreate a completed submission entry in that late-event case.
    if (promptSubmissionStates.get(sessionId)?.get(messageId) === "sending") {
      setPromptSubmissionState(sessionId, messageId, "accepted");
    }
  }

  function projectTranscriptEvent(current: UiMessage[], envelope: AgentEventEnvelope): UiMessage[] {
    const { event } = envelope;
    let next = current;
    switch (event.type) {
      case "message_start":
        next = upsertLiveSessionMessage(current, event.message);
        break;
      case "message_update": {
        const normalized = dedupeSessionMessages(current);
        const index = getSessionMessageSnapshot(normalized).positions.get(event.message.id);
        const previous = index === undefined ? undefined : normalized[index];
        next = upsertLiveSessionMessage(normalized, applyMessageUpdate(previous, event));
        break;
      }
      case "message_end": {
        next = projectMessageEnd(current, event);
        break;
      }
      case "tool_start":
        next = upsertLiveSessionMessage(current, {
          id: event.toolCallId,
          role: "tool",
          content: "",
          createdAt: new Date(envelope.ts).toISOString(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolArgs: event.args,
          toolStatus: "running",
          status: "streaming",
          ...(envelope.parentToolCallId
            ? { parentToolCallId: envelope.parentToolCallId }
            : {}),
          ...(envelope.nestedParentToolCallId ? { nestedParentToolCallId: envelope.nestedParentToolCallId } : {}),
          ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
        });
        break;
      case "tool_update": {
        if (event.partialResult === undefined) return current;
        const index = getSessionToolMessagePositions(current, event.toolCallId)
          .find((position) => current[position].toolStatus === "running");
        if (index === undefined) return current;
        const existing = current[index];
        next = upsertLiveSessionMessage(current, {
          ...existing,
          content:
            typeof event.partialResult === "string"
              ? event.partialResult
              : formatToolValue(event.partialResult),
          toolResult: event.partialResult,
        });
        break;
      }
      case "tool_end": {
        const toolStart = toolStartsByCallId.get(event.toolCallId);
        const completedAt = new Date(envelope.ts).toISOString();
        const completed: UiMessage = {
          id: event.toolCallId,
          role: "tool",
          content:
            typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result, null, 2),
          createdAt: toolStart?.createdAt ?? completedAt,
          toolCallId: event.toolCallId,
          ...(toolStart?.toolName ? { toolName: toolStart.toolName } : {}),
          ...(toolStart ? { toolArgs: toolStart.args } : {}),
          toolCompletedAt: completedAt,
          toolDurationMs: toolStart
            ? Math.max(0, envelope.ts - Date.parse(toolStart.createdAt))
            : 0,
          toolStatus: event.isError ? "error" : "success",
          toolResult: event.result,
          ...(event.toolUsage ? { toolUsage: event.toolUsage } : {}),
          status: "complete",
          isError: event.isError,
        };
        const existing = current.find(
          (message) => message.toolCallId === event.toolCallId,
        );
        next = existing
          ? upsertLiveSessionMessage(current, {
              ...existing,
              ...completed,
              toolName: existing.toolName ?? completed.toolName,
              toolArgs: existing.toolArgs ?? completed.toolArgs,
              createdAt: existing.createdAt || completed.createdAt,
            })
          : upsertLiveSessionMessage(current, completed);
        break;
      }
      default:
        return current;
    }

    return next;
  }

  function cacheBackgroundTranscriptEvent(envelope: AgentEventEnvelope): void {
    const { sessionId } = envelope;
    const state = get();
    const current =
      sessionTranscriptCache.get(sessionId) ?? state.retainedTranscripts[sessionId];
    if (!current) return;

    const next = projectTranscriptEvent(current, envelope);
    if (next === current) return;
    liveSessionTranscripts.add(sessionId);
    cacheSessionTranscript(
      sessionId,
      next,
      sessionHistoryCache.get(sessionId) ?? state.sessionHistory[sessionId],
    );
  }

  function queueWorkspaceAlignment<T>(task: () => Promise<T>): Promise<T> {
    const next = sessionWorkspaceQueue.then(task, task);
    sessionWorkspaceQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function recordToolStart(toolCallId: string, value: ToolStart): void {
    if (toolStartsByCallId.size >= 512) {
      const oldest = toolStartsByCallId.keys().next().value;
      if (oldest !== undefined) toolStartsByCallId.delete(oldest);
    }
    toolStartsByCallId.set(toolCallId, value);
  }

  return {
    pendingNewSessionRequests,
    sessionTranscriptCache,
    liveSessionTranscripts,
    sessionHistoryCache,
    syncTranscriptProjection,
    submittedComposerDrafts,
    pendingPromptAttempts,
    promptSubmissionStates,
    pendingSessionConfigurations,
    sessionConfigurationFlushes,
    beginNavigationIntent: () => navigationIntents.begin(),
    navigationIntentIsCurrent: (intent) => navigationIntents.isCurrent(intent),
    newSessionScopeKey: (projectPath) =>
      normalizeProjectPath(projectPath) ?? "<temporary>",
    latestSessionInScope: (sessions, projectPath, sessionMeta) =>
      sessions
        .filter(
          (session) =>
            !isAutomationSession(session) &&
            sessionMatchesProject(session, projectPath),
        )
        .sort((a, b) => {
          const aUpdated = Date.parse(a.updatedAt);
          const bUpdated = Date.parse(b.updatedAt);
          const aTime = Number.isFinite(aUpdated) ? aUpdated : 0;
          const bTime = Number.isFinite(bUpdated) ? bUpdated : 0;
          return bTime - aTime || b.id.localeCompare(a.id);
        })
        .find((session) => !sessionIsArchived(session.id, sessionMeta)),
    liveMessageCountForSession: (id, state) =>
      state.activeSessionId === id
        ? state.messages.length
        : sessionTranscriptCache.get(id)?.length ??
          state.retainedTranscripts[id]?.length ??
          0,
    cacheSessionTranscript,
    loadSessionDetail,
    loadFullSessionMessages,
    insertOptimisticUserMessage,
    retractOptimisticUserMessage,
    markPendingPromptFailed,
    clearPendingPromptAttempt,
    patchSessionMessage,
    beginPromptSubmission: (sessionId, messageId) => setPromptSubmissionState(sessionId, messageId, "sending"),
    acceptPromptSubmission,
    promptSubmissionWasAccepted: (sessionId, messageId) => promptSubmissionStates.get(sessionId)?.get(messageId) === "accepted",
    clearPromptSubmission,
    cacheBackgroundTranscriptEvent,
    mergeSessionConfiguration: (current, next) => {
      if (!current) return next;
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(next)) {
        if (value !== undefined) merged[key] = value;
      }
      return merged as SessionConfiguration;
    },
    queueWorkspaceAlignment,
    beginSessionSelection: (id, intent) => {
      const selection = { id, intent };
      pendingSessionSelection = selection;
      return selection;
    },
    isCurrentSessionSelection: (selection) =>
      pendingSessionSelection === selection,
    isSessionSelectionPending: (sessionId) =>
      pendingSessionSelection?.id === sessionId,
    clearSessionSelection: (selection) => {
      if (pendingSessionSelection === selection) pendingSessionSelection = null;
    },
    isSessionSelectionForIntent: (intent) =>
      pendingSessionSelection?.intent === intent,
    recordToolStart,
    getToolStart: (toolCallId) => toolStartsByCallId.get(toolCallId),
    removeToolStart: (toolCallId) => toolStartsByCallId.delete(toolCallId),
    nextPlanSyncGeneration: (sessionId) => {
      const next = (planSyncGenerations.get(sessionId) ?? 0) + 1;
      planSyncGenerations.set(sessionId, next);
      return next;
    },
    planSyncGeneration: (sessionId) => planSyncGenerations.get(sessionId) ?? 0,
  };
}

export function sessionMessagesCoverLiveTail(
  durable: UiMessage[],
  live: UiMessage[] | undefined,
): boolean {
  return durableCoversLiveSessionMessages(durable, live);
}
