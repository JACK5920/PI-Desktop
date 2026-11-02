import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DiffFile, DiffLine, WorkspaceDiff } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { addBranchReviewFeedback } from "../../lib/branch-review-feedback";
import { composerDraftBridge } from "../../features/chat/composer/plugins/draft-bridge";
import { useChatSessionCapability } from "../../hooks/use-chat-session-capability";
import { useAppStore } from "../../stores/app-store";
import { Button, Select, cx } from "../ui";
import { IconBranch, IconRefresh } from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

export function BranchReviewTab() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const workspacePath = useAppStore((state) => state.workspace?.path);
  const showToast = useAppStore((state) => state.showToast);
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const scopeKey = JSON.stringify([sessionId ?? "", workspacePath ?? ""]);
  const [diffState, setDiffState] = useState<{
    scopeKey: string;
    baseRef?: string;
    value: WorkspaceDiff;
  } | null>(null);
  const [requestedBase, setRequestedBase] = useState<{ scopeKey: string; ref: string } | null>(null);
  const requestedBaseRef = requestedBase?.scopeKey === scopeKey ? requestedBase.ref : undefined;
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState<{ scopeKey: string; baseRef?: string } | null>(null);
  const [addingFeedback, setAddingFeedback] = useState<string | null>(null);
  const requestId = useRef(0);
  const diff = diffState?.scopeKey === scopeKey && diffState.baseRef === requestedBaseRef
    ? diffState.value
    : null;
  const activeBaseRef = requestedBaseRef ?? diff?.branchReview?.baseRef ?? "";
  const error = errorState?.scopeKey === scopeKey && errorState.baseRef === requestedBaseRef;

  const refresh = useCallback(async (baseRef?: string) => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setErrorState(null);
    try {
      const result = await api.workspaceDiff({
        ...(sessionId ? { sessionId } : {}),
        ...(baseRef ? { baseRef } : {}),
        includeBases: true,
      });
      if (currentRequest === requestId.current) {
        setDiffState({ scopeKey, ...(baseRef ? { baseRef } : {}), value: result });
      }
      return result;
    } catch {
      if (currentRequest === requestId.current) {
        setErrorState({ scopeKey, ...(baseRef ? { baseRef } : {}) });
      }
      throw new Error("Branch diff could not be loaded");
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [scopeKey, sessionId]);

  useEffect(() => {
    void refresh(requestedBaseRef).catch(() => undefined);
  }, [refresh, requestedBaseRef, workspacePath]);

  const files = useMemo(() => diff?.files ?? [], [diff]);

  const addFeedback = async (file: DiffFile, line: DiffLine) => {
    if (!sessionId || !localToolsAllowed || !file.anchorRevision || !activeBaseRef) return;
    const requestKey = `${file.path}:${line.oldLine ?? ""}:${line.newLine ?? ""}`;
    if (addingFeedback) return;
    setAddingFeedback(requestKey);
    try {
      const outcome = await addBranchReviewFeedback({
        sessionId,
        baseRef: activeBaseRef,
        path: file.path,
        anchorRevision: file.anchorRevision,
        line,
        prompt: t("panel.branchReview.feedbackPrompt"),
      }, {
        loadDiff: async (baseRef) => {
          return api.workspaceDiff({ sessionId, baseRef, includeBases: true });
        },
        appendDraft: (targetSessionId, text) =>
          composerDraftBridge.appendTextForSession(targetSessionId, text),
      });
      if (outcome === "stale") {
        showToast(t("panel.branchReview.stale"), { variant: "error" });
        void refresh(requestedBaseRef).catch(() => undefined);
        return;
      }
      showToast(t("panel.branchReview.feedbackAdded"), { variant: "success" });
    } catch {
      showToast(t("panel.branchReview.feedbackFailed"), { variant: "error" });
    } finally {
      setAddingFeedback(null);
    }
  };

  if (!diff && !error) {
    return <WorkTabEmpty icon={IconBranch} title={t("panel.files.loading")} />;
  }
  if (!diff) {
    return (
      <WorkTabEmpty icon={IconBranch} title={t("panel.branchReview.loadFailed")}>
        <Button size="sm" onClick={() => void refresh(requestedBaseRef).catch(() => undefined)}>
          {t("panel.branchReview.refresh")}
        </Button>
      </WorkTabEmpty>
    );
  }
  if (!diff.repo) {
    return <WorkTabEmpty icon={IconBranch} title={t("panel.branchReview.noRepository")} />;
  }
  if (diff.baseError === "no_head") {
    return <WorkTabEmpty icon={IconBranch} title={t("panel.branchReview.noCommits")} />;
  }
  if (!diff.baseOptions?.length) {
    return <WorkTabEmpty icon={IconBranch} title={t("panel.branchReview.noBases")} />;
  }

  const isStaleBase = diff.baseError === "no_merge_base" || diff.baseError === "invalid_base";
  const currentBranch = diff.currentBranch === "detached"
    ? t("panel.branchReview.detached")
    : diff.currentBranch ?? t("panel.branchReview.detached");
  return (
    <div className="branch-review-tab">
      <div className="branch-review-toolbar">
        <div className="branch-review-base-select">
          <label htmlFor="branch-review-base">{t("panel.branchReview.base")}</label>
          <Select
            id="branch-review-base"
            value={activeBaseRef}
            aria-label={t("panel.branchReview.base")}
            disabled={loading}
            onChange={(event) => {
              setRequestedBase({ scopeKey, ref: event.target.value });
            }}
          >
            {diff.baseOptions.map((base) => (
              <option key={base.ref} value={base.ref}>{base.name}</option>
            ))}
          </Select>
        </div>
        <span className="branch-review-current-branch">
          {t("panel.branchReview.current", { branch: currentBranch })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="branch-review-refresh"
          aria-label={t("panel.branchReview.refresh")}
          title={t("panel.branchReview.refresh")}
          disabled={loading}
          onClick={() => void refresh(requestedBaseRef).catch(() => undefined)}
        >
          <IconRefresh size={14} />
          {t("panel.branchReview.refresh")}
        </Button>
      </div>
      {isStaleBase ? (
        <WorkTabEmpty icon={IconBranch} title={t("panel.branchReview.noMergeBase")} />
      ) : files.length === 0 ? (
        <WorkTabEmpty icon={IconBranch} title={t("panel.branchReview.clean")} />
      ) : (
        <div className="branch-review-scroll">
          {error && (
            <div className="branch-review-note" role="status">{t("panel.branchReview.loadFailed")}</div>
          )}
          {diff.truncated && (
            <div className="branch-review-note">{t("panel.branchReview.truncated")}</div>
          )}
          {files.map((file) => (
            <section className="branch-review-file" key={`${file.path}:${file.anchorRevision ?? ""}`}>
              <header className="branch-review-file-header">
                <code>{file.path}</code>
                <span className="branch-review-file-status">{t(`panel.review.status.${file.status}`)}</span>
                <span className="diff-counts">
                  <span className="diff-count-add">+{file.additions}</span>
                  <span className="diff-count-del">−{file.deletions}</span>
                </span>
              </header>
              {file.binary ? (
                <div className="review-change-note">{t("panel.review.binary")}</div>
              ) : file.tooLarge ? (
                <div className="review-change-note">{t("panel.review.tooLarge")}</div>
              ) : file.hunks.length === 0 ? (
                <div className="review-change-note">{t("panel.review.noLineDetails")}</div>
              ) : (
                <div className="branch-review-diff">
                  {file.hunks.map((hunk, hunkIndex) => (
                    <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
                      <div className="diff-line hunk"><span className="diff-line-text">{hunk.header}</span></div>
                      {hunk.lines.map((line, lineIndex) => {
                        const lineName = t("panel.branchReview.addFeedbackAtLine", {
                          path: file.path,
                          line: line.newLine ?? line.oldLine ?? "?",
                        });
                        const key = `${line.oldLine ?? "o"}:${line.newLine ?? "n"}:${lineIndex}`;
                        return (
                          <div className={cx("diff-line", line.type, "branch-review-line")} key={key}>
                            <span className="branch-review-line-number old">{line.oldLine ?? ""}</span>
                            <span className="branch-review-line-number new">{line.newLine ?? ""}</span>
                            <span className="diff-line-sign" aria-hidden>
                              {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                            </span>
                            <span className="diff-line-text">{line.text}</span>
                            {sessionId && localToolsAllowed && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="branch-review-line-feedback"
                                aria-label={lineName}
                                title={lineName}
                                disabled={!file.anchorRevision || addingFeedback !== null || loading || error}
                                onClick={() => void addFeedback(file, line)}
                              >
                                {t("panel.branchReview.addFeedback")}
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
