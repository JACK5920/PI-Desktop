import i18n from "i18next";
import { sessionAllows } from "../../lib/remote-session-safety";
import {
  beginSideChatSend,
  editSideChatDraft,
  failSideChatFork,
  resolveSideChatFork,
  resolveSideChatSend,
} from "../../lib/side-chat-lifecycle";
import { sideChatWorkPanelTab } from "../../lib/work-panel-tabs";
import type { AppState, SideChatState } from "../app-state";
import type { StoreAccess } from "./types";

export type SideChatSliceDependencies = StoreAccess & {
  getCachedTranscript: (sessionId: string) => AppState["messages"];
};

function quotedDraft(excerpt: string): string {
  return `${excerpt.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
}

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

export function createSideChatSlice({ get, set, getCachedTranscript }: SideChatSliceDependencies): Pick<
  AppState,
  | "openSideChat"
  | "setSideChatDraft"
  | "sendSideChatPrompt"
  | "closeSideChat"
  | "promoteSideChatToConversation"
> {
  const pendingSends = new Map<string, Promise<boolean>>();

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
    openSideChat: (parentSessionId, sourceMessageId, excerpt) => {
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
      if (!source || source.role !== "assistant" || source.status === "streaming" || !excerpt.trim()) {
        return null;
      }

      const sideChatId = `side-chat:${crypto.randomUUID()}`;
      const sideChat: SideChatState = {
        id: sideChatId,
        parentSessionId,
        sourceMessageId,
        excerpt: excerpt.trim(),
        messages: [],
        operationId: 0,
        status: "draft",
        draftText: quotedDraft(excerpt.trim()),
      };
      set((current) => ({ sideChats: { ...current.sideChats, [sideChatId]: sideChat } }));
      get().openWorkPanelTabForSession(parentSessionId, sideChatWorkPanelTab(sideChatId));
      return sideChatId;
    },

    setSideChatDraft: (sideChatId, text) => {
      set((state) => updateSideChat(state, sideChatId, (sideChat) => ({
        ...sideChat,
        ...editSideChatDraft(sideChat, text),
      })));
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
      const current = get().sideChats[sideChatId];
      if (!current?.childSessionId) return;
      closeSideChat(sideChatId);
      await get().selectSession(current.childSessionId);
    },
  };
}
