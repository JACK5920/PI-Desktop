import i18n from "i18next";
import { sessionAllows } from "../../lib/remote-session-safety";
import { normalizeTranscriptExcerpt } from "../../lib/transcript-selection";
import {
  beginSideChatSend,
  editSideChatDraft,
  failSideChatFork,
  resolveSideChatFork,
  resolveSideChatSend,
} from "../../lib/side-chat-lifecycle";
import {
  draftKeyForSession,
  readComposerDraft,
  writeComposerDraft,
} from "../../lib/composer-draft-cache";
import { sideChatWorkPanelTab } from "../../lib/work-panel-tabs";
import type { AppState, SideChatState } from "../app-state";
import type { SessionDetail } from "@pi-desktop/shared";
import type { StoreAccess } from "./types";

export type SideChatSliceDependencies = StoreAccess & {
  getCachedTranscript: (sessionId: string) => AppState["messages"];
  getSessionDetail: (sessionId: string) => Promise<SessionDetail | null>;
  promoteSideChat: (sessionId: string) => Promise<{ ok: boolean }>;
};

function updateSideChat(
  state: AppState,
  sideChatId: string,
  update: (sideChat: SideChatState) => SideChatState,
): Partial<AppState> {
  const current = state.sideChats[sideChatId];
  if (!current) return {};
  return {
    sideChats: {
      ...state.sideChats,
      [sideChatId]: update(current),
    },
  };
}

export function createSideChatSlice({ get, set, getCachedTranscript, getSessionDetail, promoteSideChat }: SideChatSliceDependencies): Pick<
  AppState,
  | "openSideChat"
  | "reopenSideChat"
  | "setSideChatDraft"
  | "addSideChatReference"
  | "editSideChatReference"
  | "removeSideChatReference"
  | "clearSideChatReferences"
  | "sendSideChatPrompt"
  | "closeSideChat"
  | "promoteSideChatToConversation"
> {
  const pendingSends = new Map<string, Promise<boolean>>();
  const normalizeComment = (comment: string | undefined) => {
    const normalized = comment?.replace(/\r\n?/g, "\n").trim();
    return normalized || undefined;
  };
  const transferReferencesToChild = (sideChatId: string, childSessionId: string) => {
    set((state) => {
      const sideChat = state.sideChats[sideChatId];
      const references = sideChat?.references ?? [];
      if (!sideChat || references.length === 0) return {};
      const current = state.responseAnnotations[childSessionId] ?? [];
      const ids = new Set(current.map((reference) => reference.id));
      const next = [...current, ...references.filter((reference) => !ids.has(reference.id))];
      return {
        sideChats: {
          ...state.sideChats,
          [sideChatId]: { ...sideChat, references: [] },
        },
        responseAnnotations: {
          ...state.responseAnnotations,
          [childSessionId]: next,
        },
      };
    });
  };

  const closeSideChat = (sideChatId: string) => {
    const current = get().sideChats[sideChatId];
    if (!current) return;
    set((state) => {
      const sideChats = { ...state.sideChats };
      delete sideChats[sideChatId];
      return { sideChats };
    });
    get().closeWorkPanelTab(sideChatId, current.parentSessionId);
  };

  return {
    openSideChat: (parentSessionId, sourceMessageId, excerpt, sourceMessageIds) => {
      const state = get();
      const session = state.sessions.find((candidate) => candidate.id === parentSessionId);
      if (
        !session ||
        !sessionAllows(session, "canEditMessages") ||
        !sessionAllows(session, "canPrompt")
      ) return null;
      const transcript = state.activeSessionId === parentSessionId
        ? state.messages
        : state.retainedTranscripts[parentSessionId] ?? getCachedTranscript(parentSessionId);
      const source = transcript.find((message) => message.id === sourceMessageId);
      const normalizedSourceIds = sourceMessageIds?.length
        ? [...new Set(sourceMessageIds)]
        : [sourceMessageId];
      if (
        normalizedSourceIds[0] !== sourceMessageId ||
        normalizedSourceIds.some((id) =>
          transcript.find((message) => message.id === id)?.role !== "assistant",
        ) ||
        !source || source.status === "streaming" || !excerpt.trim()
      ) {
        return null;
      }

      const sideChatId = `side-chat:${crypto.randomUUID()}`;
      const sideChat: SideChatState = {
        id: sideChatId,
        parentSessionId,
        sourceMessageId,
        ...(normalizedSourceIds.length > 1 ? { sourceMessageIds: normalizedSourceIds } : {}),
        excerpt: excerpt.trim(),
        references: [],
        messages: [],
        operationId: 0,
        status: "draft",
        draftText: "",
      };
      set((current) => ({ sideChats: { ...current.sideChats, [sideChatId]: sideChat } }));
      get().openWorkPanelTabForSession(parentSessionId, sideChatWorkPanelTab(sideChatId));
      return sideChatId;
    },

    reopenSideChat: async (childSessionId) => {
      const detail = await getSessionDetail(childSessionId);
      const origin = detail?.sideChat;
      if (!detail || !origin || origin.promoted) return;
      const latest = get();
      const parent = latest.sessions.find((session) => session.id === origin.parentSessionId);
      if (!parent || !sessionAllows(parent, "canPrompt")) return;
      if (latest.activeSessionId !== origin.parentSessionId) {
        await latest.selectSession(origin.parentSessionId);
        if (!get().sessions.some((session) => session.id === origin.parentSessionId)) return;
      }
      const sideChatId = `side-chat:${childSessionId}`;
      const sideChat: SideChatState = {
        id: sideChatId,
        parentSessionId: origin.parentSessionId,
        sourceMessageId: origin.sourceMessageId,
        sourceMessageIds: [origin.sourceMessageId],
        excerpt: origin.excerpt,
        references: [],
        childSessionId,
        messages: detail.messages,
        operationId: 0,
        status: "ready",
        draftText: "",
      };
      set((state) => ({
        sideChats: { ...state.sideChats, [sideChatId]: sideChat },
        sessions: [detail, ...state.sessions.filter((session) => session.id !== childSessionId)],
      }));
      get().openWorkPanelTabForSession(origin.parentSessionId, sideChatWorkPanelTab(sideChatId));
    },

    setSideChatDraft: (sideChatId, text) => {
      set((state) => updateSideChat(state, sideChatId, (sideChat) => ({
        ...sideChat,
        ...editSideChatDraft(sideChat, text),
      })));
    },

    addSideChatReference: (sideChatId, sourceMessageId, rawExcerpt, anchor, sourceMessageIds) => {
      const state = get();
      const sideChat = state.sideChats[sideChatId];
      if (!sideChat || !sessionAllows(
        state.sessions.find((session) => session.id === sideChat.parentSessionId),
        "canEditMessages",
      )) return null;
      const excerpt = normalizeTranscriptExcerpt(rawExcerpt);
      if (!excerpt) return null;
      const transcript = sideChat.parentSessionId === state.activeSessionId
        ? state.messages
        : state.retainedTranscripts[sideChat.parentSessionId] ?? getCachedTranscript(sideChat.parentSessionId);
      const normalizedSourceIds = sourceMessageIds?.length
        ? [...new Set(sourceMessageIds)]
        : [sourceMessageId];
      if (
        normalizedSourceIds[0] !== sourceMessageId ||
        normalizedSourceIds.some((id) =>
          transcript.find((message) => message.id === id)?.role !== "assistant",
        )
      ) return null;
      const validAnchor = anchor &&
        Number.isSafeInteger(anchor.anchorStart) &&
        Number.isSafeInteger(anchor.anchorEnd) &&
        anchor.anchorStart >= 0 &&
        anchor.anchorEnd > anchor.anchorStart
        ? anchor
        : undefined;
      const childReferences = sideChat.childSessionId
        ? state.responseAnnotations[sideChat.childSessionId] ?? []
        : [];
      const current = [...(sideChat.references ?? []), ...childReferences];
      const duplicate = current.find((reference) =>
        reference.sourceMessageId === sourceMessageId &&
        (reference.sourceSessionId ?? sideChat.parentSessionId) === sideChat.parentSessionId &&
        reference.excerpt === excerpt &&
        (reference.sourceMessageIds ?? [reference.sourceMessageId]).length === normalizedSourceIds.length &&
        (reference.sourceMessageIds ?? [reference.sourceMessageId]).every(
          (id, index) => id === normalizedSourceIds[index],
        ) &&
        reference.anchorStart === validAnchor?.anchorStart &&
        reference.anchorEnd === validAnchor?.anchorEnd,
      );
      if (duplicate) return duplicate.id;
      const referenceId = crypto.randomUUID();
      const reference = {
        id: referenceId,
        sourceSessionId: sideChat.parentSessionId,
        sourceMessageId,
        ...(normalizedSourceIds.length > 1 ? { sourceMessageIds: normalizedSourceIds } : {}),
        excerpt,
        ...(validAnchor ?? {}),
      };
      set((latest) => updateSideChat(latest, sideChatId, (currentSideChat) => ({
        ...currentSideChat,
        references: [...(currentSideChat.references ?? []), reference],
      })));
      return referenceId;
    },

    editSideChatReference: (sideChatId, referenceId, comment) => {
      const state = get();
      const sideChat = state.sideChats[sideChatId];
      if (!sideChat || !sessionAllows(
        state.sessions.find((session) => session.id === sideChat.parentSessionId),
        "canEditMessages",
      )) return;
      const normalized = normalizeComment(comment);
      set((latest) => updateSideChat(latest, sideChatId, (current) => ({
        ...current,
        references: (current.references ?? []).map((reference) =>
          reference.id === referenceId
            ? { ...reference, ...(normalized ? { comment: normalized } : { comment: undefined }) }
            : reference,
        ),
      })));
    },

    removeSideChatReference: (sideChatId, referenceId) => {
      const state = get();
      const sideChat = state.sideChats[sideChatId];
      if (!sideChat || !sessionAllows(
        state.sessions.find((session) => session.id === sideChat.parentSessionId),
        "canEditMessages",
      )) return;
      set((latest) => updateSideChat(latest, sideChatId, (current) => ({
        ...current,
        references: (current.references ?? []).filter((reference) => reference.id !== referenceId),
      })));
    },

    clearSideChatReferences: (sideChatId) => {
      const state = get();
      const sideChat = state.sideChats[sideChatId];
      if (!sideChat || !sessionAllows(
        state.sessions.find((session) => session.id === sideChat.parentSessionId),
        "canEditMessages",
      )) return;
      set((latest) => updateSideChat(latest, sideChatId, (current) => ({ ...current, references: [] })));
    },

    sendSideChatPrompt: (sideChatId, content) => {
      const existing = pendingSends.get(sideChatId);
      if (existing) return existing;
      const before = get().sideChats[sideChatId];
      if (!before) return Promise.resolve(false);
      const started = beginSideChatSend(before, content);
      if (!started) return Promise.resolve(false);
      set((state) => updateSideChat(state, sideChatId, (sideChat) => ({
        ...sideChat,
        ...started.state,
      })));

      const pending = (async () => {
        let childSessionId = started.state.childSessionId;
        if (started.shouldFork) {
          try {
            childSessionId = await get().forkAssistantMessageInSession(
              before.parentSessionId,
              before.sourceMessageId,
              before.excerpt,
            ) ?? undefined;
          } catch (error) {
            const current = get().sideChats[sideChatId];
            const failed = current
              ? failSideChatFork(
                current,
                started.operationId,
                error instanceof Error ? error.message : String(error),
              )
              : null;
            if (failed) {
              set((state) => updateSideChat(state, sideChatId, (sideChat) => ({ ...sideChat, ...failed })));
            }
            return false;
          }
          if (!childSessionId) {
            const current = get().sideChats[sideChatId];
            const failed = current
              ? failSideChatFork(current, started.operationId, i18n.t("chat.sideChatForkFailed"))
              : null;
            if (failed) {
              set((state) => updateSideChat(state, sideChatId, (sideChat) => ({ ...sideChat, ...failed })));
            }
            return false;
          }

          const current = get().sideChats[sideChatId];
          const forked = current
            ? resolveSideChatFork(current, started.operationId, childSessionId)
            : null;
          if (forked) {
            set((state) => updateSideChat(state, sideChatId, (sideChat) => ({
              ...sideChat,
              ...forked,
              messages: getCachedTranscript(childSessionId!) ?? [],
            })));
          }
        }

        if (!childSessionId) return false;
        transferReferencesToChild(sideChatId, childSessionId);
        try {
          const accepted = await get().sendPrompt(
            content,
            { text: content, fileReferences: [] },
            childSessionId,
          );
          const current = get().sideChats[sideChatId];
          const resolved = current
            ? resolveSideChatSend(
              current,
              started.operationId,
              accepted,
              accepted ? undefined : i18n.t("chat.sideChatSendFailed"),
            )
            : null;
          if (resolved) {
            set((state) => updateSideChat(state, sideChatId, (sideChat) => ({ ...sideChat, ...resolved })));
          }
          return accepted;
        } catch (error) {
          const current = get().sideChats[sideChatId];
          const resolved = current
            ? resolveSideChatSend(
              current,
              started.operationId,
              false,
              error instanceof Error ? error.message : String(error),
            )
            : null;
          if (resolved) {
            set((state) => updateSideChat(state, sideChatId, (sideChat) => ({ ...sideChat, ...resolved })));
          }
          return false;
        }
      })();
      pendingSends.set(sideChatId, pending);
      void pending.then(
        () => { if (pendingSends.get(sideChatId) === pending) pendingSends.delete(sideChatId); },
        () => { if (pendingSends.get(sideChatId) === pending) pendingSends.delete(sideChatId); },
      );
      return pending;
    },

    closeSideChat,

    promoteSideChatToConversation: async (sideChatId) => {
      const pendingSend = pendingSends.get(sideChatId);
      if (pendingSend) await pendingSend;

      const current = get().sideChats[sideChatId];
      if (!current?.childSessionId) return;
      const { childSessionId, draftText } = current;
      const childSummary = get().sessions.find((session) => session.id === childSessionId);
      if (childSummary?.sideChat && !childSummary.sideChat.promoted) {
        let promoted: { ok: boolean };
        try {
          promoted = await promoteSideChat(childSessionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => updateSideChat(state, sideChatId, (sideChat) => ({ ...sideChat, error: message })));
          return;
        }
        if (!promoted.ok) return;
        set((state) => ({
          sessions: state.sessions.map((session) => session.id === childSessionId && session.sideChat
            ? { ...session, sideChat: { ...session.sideChat, promoted: true } }
            : session),
        }));
      }
      if (draftText.trim()) {
        const draftKey = draftKeyForSession(childSessionId);
        const state = get();
        const pendingPrefill = state.composerPrefill?.sessionId === childSessionId
          ? state.composerPrefill
          : undefined;
        const cachedDraft = readComposerDraft(draftKey);
        const existingText = pendingPrefill?.text ?? cachedDraft?.text ?? "";
        const separator = existingText.length === 0
          ? ""
          : existingText.endsWith("\n") ? "\n" : "\n\n";
        const promotedDraft = {
          text: `${existingText}${separator}${draftText}`,
          fileReferences: (pendingPrefill?.fileReferences ?? cachedDraft?.fileReferences ?? [])
            .map((reference) => ({ ...reference })),
        };
        writeComposerDraft(draftKey, promotedDraft);
        if (pendingPrefill) {
          set({ composerPrefill: { sessionId: childSessionId, ...promotedDraft } });
        }
      }
      closeSideChat(sideChatId);
      await get().selectSession(childSessionId);
    },
  };
}
