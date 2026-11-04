import { sessionAllows } from "../../lib/remote-session-safety";
import { transcriptMessagesForSession } from "../../lib/response-annotations";
import { normalizeTranscriptExcerpt } from "../../lib/transcript-selection";
import type { ResponseAnnotation } from "../../lib/response-annotations";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";

function sameAnnotation(left: ResponseAnnotation, right: ResponseAnnotation): boolean {
  return left.id === right.id &&
    left.sourceMessageId === right.sourceMessageId &&
    left.excerpt === right.excerpt &&
    left.comment === right.comment;
}

function normalizeComment(comment: string | undefined): string | undefined {
  const normalized = comment?.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : undefined;
}

export function createAnnotationSlice({ get, set }: StoreAccess): Pick<
  AppState,
  | "addResponseAnnotation"
  | "editResponseAnnotation"
  | "removeResponseAnnotation"
  | "clearResponseAnnotations"
  | "consumeAcceptedAnnotations"
> {
  return {
    addResponseAnnotation: (sessionId, sourceMessageId, rawExcerpt) => {
      const state = get();
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!sessionAllows(session, "canEditMessages")) return null;
      const excerpt = normalizeTranscriptExcerpt(rawExcerpt);
      if (!excerpt) return null;
      const sourceMessages = transcriptMessagesForSession(state, sessionId);
      const sourceMessage = sourceMessages.find((message) => message.id === sourceMessageId);
      if (sourceMessage?.role !== "assistant") return null;
      const current = state.responseAnnotations[sessionId] ?? [];
      const existing = current.find((item) =>
        item.sourceMessageId === sourceMessageId && item.excerpt === excerpt,
      );
      if (existing) return existing.id;
      const annotation: ResponseAnnotation = {
        id: crypto.randomUUID(),
        sourceMessageId,
        excerpt,
      };
      set((latest) => ({
        responseAnnotations: {
          ...latest.responseAnnotations,
          [sessionId]: [...(latest.responseAnnotations[sessionId] ?? []), annotation],
        },
      }));
      return annotation.id;
    },

    editResponseAnnotation: (sessionId, annotationId, comment) => {
      const state = get();
      if (!sessionAllows(state.sessions.find((item) => item.id === sessionId), "canEditMessages")) return;
      const current = state.responseAnnotations[sessionId] ?? [];
      if (!current.some((item) => item.id === annotationId)) return;
      const normalized = normalizeComment(comment);
      set((latest) => ({
        responseAnnotations: {
          ...latest.responseAnnotations,
          [sessionId]: (latest.responseAnnotations[sessionId] ?? []).map((item) =>
            item.id === annotationId
              ? { ...item, ...(normalized ? { comment: normalized } : { comment: undefined }) }
              : item,
          ),
        },
      }));
    },

    removeResponseAnnotation: (sessionId, annotationId) => {
      const state = get();
      if (!sessionAllows(state.sessions.find((item) => item.id === sessionId), "canEditMessages")) return;
      set((latest) => {
        const remaining = (latest.responseAnnotations[sessionId] ?? []).filter(
          (item) => item.id !== annotationId,
        );
        const responseAnnotations = { ...latest.responseAnnotations };
        if (remaining.length) responseAnnotations[sessionId] = remaining;
        else delete responseAnnotations[sessionId];
        return { responseAnnotations };
      });
    },

    clearResponseAnnotations: (sessionId) => {
      const state = get();
      if (!sessionAllows(state.sessions.find((item) => item.id === sessionId), "canEditMessages")) return;
      set((latest) => {
        if (!latest.responseAnnotations[sessionId]) return {};
        const responseAnnotations = { ...latest.responseAnnotations };
        delete responseAnnotations[sessionId];
        return { responseAnnotations };
      });
    },

    consumeAcceptedAnnotations: (sessionId, submittedSnapshot) => {
      if (!submittedSnapshot.length) return;
      set((latest) => {
        const current = latest.responseAnnotations[sessionId] ?? [];
        const unchangedSubmitted = new Set(
          submittedSnapshot
            .filter((snapshot) => current.some((item) => sameAnnotation(item, snapshot)))
            .map((item) => item.id),
        );
        if (!unchangedSubmitted.size) return {};
        const remaining = current.filter((item) => !unchangedSubmitted.has(item.id));
        const responseAnnotations = { ...latest.responseAnnotations };
        if (remaining.length) responseAnnotations[sessionId] = remaining;
        else delete responseAnnotations[sessionId];
        return { responseAnnotations };
      });
    },
  };
}
