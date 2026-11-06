import type { ParsedResponseAnnotation } from "../../../lib/response-annotations";
import { useTranslation } from "react-i18next";

export function MessageAnnotationSummary({
  annotations,
}: {
  annotations: readonly ParsedResponseAnnotation[];
}) {
  const { t } = useTranslation();
  if (annotations.length === 0) return null;

  return (
    <details className="message-annotation-summary" data-testid="message-annotation-summary">
      <summary>{t("chat.sentAnnotationReferences", { count: annotations.length })}</summary>
      <ol className="message-annotation-summary-list">
        {annotations.map((annotation, index) => (
          <li key={`${annotation.sourceMessageId}-${index}`} className="message-annotation-summary-item">
            <blockquote>{annotation.excerpt}</blockquote>
            {annotation.comment ? <p>{annotation.comment}</p> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
