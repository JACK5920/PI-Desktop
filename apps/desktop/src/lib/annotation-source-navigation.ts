import type { ParsedResponseAnnotation } from "./response-annotations";

export type AnnotationSourceTarget = {
  sessionId: string;
  messageId: string;
  query: string;
  anchorStart?: number;
  anchorEnd?: number;
};

/** Navigate to an exact excerpt only when its captured rendered-text range is valid. */
export function annotationSourceTarget(
  sessionId: string,
  annotation: Pick<ParsedResponseAnnotation, "sourceMessageId" | "excerpt" | "anchorStart" | "anchorEnd">,
): AnnotationSourceTarget {
  const hasAnchor = Number.isSafeInteger(annotation.anchorStart) &&
    Number.isSafeInteger(annotation.anchorEnd) &&
    (annotation.anchorStart as number) >= 0 &&
    (annotation.anchorEnd as number) > (annotation.anchorStart as number);
  return {
    sessionId,
    messageId: annotation.sourceMessageId,
    // Legacy or malformed references still land on their source message, but
    // never guess which repeated passage the user meant.
    query: hasAnchor ? annotation.excerpt : "",
    ...(hasAnchor
      ? { anchorStart: annotation.anchorStart, anchorEnd: annotation.anchorEnd }
      : {}),
  };
}
