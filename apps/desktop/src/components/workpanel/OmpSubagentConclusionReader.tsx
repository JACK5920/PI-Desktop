import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { IconClose, IconCopy } from "../icons";
import { Markdown } from "../Markdown";
import { OverlayBackdrop, TooltipButton } from "../ui";

/** Large, focus-managed reading surface for a long OMP subagent handoff. */
export function OmpSubagentConclusionReader({
  title,
  content,
  copied,
  onCopy,
  onClose,
}: {
  title: string;
  content: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      requestAnimationFrame(() => { if (previouslyFocused?.isConnected) previouslyFocused.focus(); });
    };
  }, []);

  const dialog = <OverlayBackdrop className="overlay omp-subagent-conclusion-overlay" role="presentation"
    onClick={() => closeRef.current()}>
    <section ref={dialogRef} className="dialog omp-subagent-conclusion-reader" role="dialog" aria-modal="true"
      aria-labelledby="omp-subagent-conclusion-reader-title" onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
        if (event.key !== "Tab") return;
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
        if (!controls?.length) return;
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className="omp-subagent-conclusion-reader-header">
        <div>
          <h2 id="omp-subagent-conclusion-reader-title">{title}</h2>
          <span>{t("settings.omp.subagentConclusionReaderHint")}</span>
        </div>
        <div className="omp-subagent-conclusion-reader-actions">
          <TooltipButton type="button" tooltip={copied ? t("settings.omp.subagentConclusionCopied") : t("settings.omp.subagentConclusionCopy")}
            ariaLabel={copied ? t("settings.omp.subagentConclusionCopied") : t("settings.omp.subagentConclusionCopy")}
            onClick={onCopy}><IconCopy size={16} /></TooltipButton>
          <TooltipButton type="button" tooltip={t("common.close")} ariaLabel={t("common.close")} onClick={onClose}>
            <IconClose size={17} />
          </TooltipButton>
        </div>
      </header>
      <div className="omp-subagent-conclusion-reader-scroll" tabIndex={0}>
        <article className="prose-chat selectable"><Markdown source={content} /></article>
      </div>
    </section>
  </OverlayBackdrop>;

  return createPortal(dialog, document.body);
}
