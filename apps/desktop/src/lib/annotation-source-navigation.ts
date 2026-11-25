import type { ParsedResponseAnnotation } from "./response-annotations";

export type AnnotationSourceTarget = {
  sessionId: string;
  messageId: string;
  query: string;
  anchorStart?: number;
  anchorEnd?: number;
};

type AnnotationSourceNavigatorState = {
  activeSessionId?: string | null;
  selectSession: (sessionId: string) => Promise<void>;
  navigateTranscript: (target: AnnotationSourceTarget) => Promise<void>;
};

/** Navigate to an exact excerpt only when its captured rendered-text range is valid. */
export function annotationSourceTarget(
  sessionId: string,
  annotation: Pick<ParsedResponseAnnotation, "sourceSessionId" | "sourceMessageId" | "excerpt" | "anchorStart" | "anchorEnd">,
): AnnotationSourceTarget {
  const hasAnchor = Number.isSafeInteger(annotation.anchorStart) &&
    Number.isSafeInteger(annotation.anchorEnd) &&
    (annotation.anchorStart as number) >= 0 &&
    (annotation.anchorEnd as number) > (annotation.anchorStart as number);
  return {
    sessionId: annotation.sourceSessionId ?? sessionId,
    messageId: annotation.sourceMessageId,
    // Legacy or malformed references still land on their source message, but
    // never guess which repeated passage the user meant.
    query: hasAnchor ? annotation.excerpt : "",
    ...(hasAnchor
      ? { anchorStart: annotation.anchorStart, anchorEnd: annotation.anchorEnd }
      : {}),
  };
}

/** Activate the owning conversation before navigating to a cross-session reference. */
export async function navigateToAnnotationSource(
  target: AnnotationSourceTarget,
  getState: () => AnnotationSourceNavigatorState,
): Promise<boolean> {
  let state = getState();
  if (state.activeSessionId !== target.sessionId) {
    await state.selectSession(target.sessionId);
    state = getState();
  }
  if (state.activeSessionId !== target.sessionId) return false;
  await state.navigateTranscript(target);
  return true;
}
