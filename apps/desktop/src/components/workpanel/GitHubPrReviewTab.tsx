import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  GitHubDiffSide,
  GitHubPrReviewAuthStatus,
  GitHubPullRequestDetailResult,
  GitHubPullRequestListResult,
  GitHubPullRequestReviewEvent,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { githubPrFeedbackText, parseGitHubPatch } from "../../lib/github-pr-review";
import { composerDraftBridge } from "../../features/chat/composer/plugins/draft-bridge";
import { isRemoteSession } from "../../lib/remote-session-safety";
import { useAppStore } from "../../stores/app-store";
import { Button, Checkbox, Field, Input, OverlayBackdrop, Select, Textarea, portalOverlay } from "../ui";
import { IconPullRequest, IconRefresh } from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

type WriteDraft = {
  kind: "line-comment" | "review";
  sessionId: string;
  number: number;
  headSha: string;
  body: string;
  path?: string;
  line?: number;
  side?: GitHubDiffSide;
  event?: GitHubPullRequestReviewEvent;
};

export function GitHubPrReviewTab() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const session = useAppStore((state) => state.sessions.find((item) => item.id === state.activeSessionId));
  const workspacePath = useAppStore((state) => state.workspace?.path);
  const showToast = useAppStore((state) => state.showToast);
  const scopeKey = JSON.stringify([sessionId ?? "", workspacePath ?? ""]);
  const [listState, setListState] = useState<{ scope: string; value: GitHubPullRequestListResult } | null>(null);
  const [detailState, setDetailState] = useState<{ scope: string; value: GitHubPullRequestDetailResult } | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"list" | "detail" | null>(null);
  const [addingFeedback, setAddingFeedback] = useState(false);
  const [authStatus, setAuthStatus] = useState<GitHubPrReviewAuthStatus | null>(null);
  const [authConfigOpen, setAuthConfigOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [writeDraft, setWriteDraft] = useState<WriteDraft | null>(null);
  const [writeBusy, setWriteBusy] = useState(false);
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const requestId = useRef(0);
  const authAttempt = useRef(0);
  const activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;
  const list = listState?.scope === scopeKey ? listState.value : null;
  const detail = detailState?.scope === scopeKey ? detailState.value : null;
  const isRemote = isRemoteSession(session);

  useEffect(() => {
    requestId.current += 1;
    setListState(null);
    setDetailState(null);
    setSelectedNumber(null);
    setLoading(false);
    setError(null);
    setWriteDraft(null);
    setApprovalConfirmed(false);
  }, [scopeKey]);

  useEffect(() => {
    if (!sessionId || !workspacePath || isRemote) {
      setAuthStatus(null);
      return;
    }
    let active = true;
    void api.githubPrReviewAuthStatus().then((status) => {
      if (!active) return;
      setAuthStatus(status);
      if (status.pending) {
        const attempt = ++authAttempt.current;
        setAuthBusy(true);
        void api.githubPrReviewAuthWait().then((complete) => {
          if (active && authAttempt.current === attempt) setAuthStatus(complete);
        }).catch(() => {
          if (active && authAttempt.current === attempt) {
            void api.githubPrReviewAuthStatus().then(setAuthStatus).catch(() => undefined);
          }
        }).finally(() => {
          if (active && authAttempt.current === attempt) setAuthBusy(false);
        });
      }
    }).catch(() => {
      if (active) setAuthStatus(null);
    });
    return () => { active = false; };
  }, [isRemote, scopeKey, sessionId, workspacePath]);

  const loadPullRequests = useCallback(async () => {
    if (!sessionId || !workspacePath || isRemote) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setDetailState(null);
    setSelectedNumber(null);
    setWriteDraft(null);
    try {
      const value = await api.githubPullRequestList(sessionId);
      if (id !== requestId.current || activeScope.current !== scopeKey) return;
      setListState({ scope: scopeKey, value });
    } catch {
      if (id === requestId.current && activeScope.current === scopeKey) setError("list");
    } finally {
      if (id === requestId.current && activeScope.current === scopeKey) setLoading(false);
    }
  }, [isRemote, scopeKey, sessionId, workspacePath]);

  const selectPullRequest = useCallback(async (number: number) => {
    if (!sessionId || !list || !Number.isSafeInteger(number) || number < 1) return;
    const id = ++requestId.current;
    setSelectedNumber(number);
    setDetailState(null);
    setWriteDraft(null);
    setApprovalConfirmed(false);
    setLoading(true);
    setError(null);
    try {
      const value = await api.githubPullRequestDetail({ sessionId, number });
      if (id === requestId.current && activeScope.current === scopeKey) setDetailState({ scope: scopeKey, value });
    } catch {
      if (id === requestId.current && activeScope.current === scopeKey) setError("detail");
    } finally {
      if (id === requestId.current && activeScope.current === scopeKey) setLoading(false);
    }
  }, [list, scopeKey, sessionId]);

  const addFeedback = (fileIndex: number, lineIndex: number, hunkIndex: number) => {
    if (!sessionId || !detail || addingFeedback) return;
    const file = detail.files[fileIndex];
    const line = file && parseGitHubPatch(file.patch)[hunkIndex]?.lines[lineIndex];
    if (!file || !line) return;
    setAddingFeedback(true);
    try {
      composerDraftBridge.appendTextForSession(
        sessionId,
        githubPrFeedbackText(detail, file, line, t("panel.githubPrReview.feedbackPrompt")),
      );
      showToast(t("panel.githubPrReview.feedbackAdded"), { variant: "success" });
    } catch {
      showToast(t("panel.githubPrReview.feedbackFailed"), { variant: "error" });
    } finally {
      setAddingFeedback(false);
    }
  };

  const saveAppCredentials = async () => {
    if (!clientId.trim() || !clientSecret) return;
    setAuthBusy(true);
    try {
      const status = await api.githubPrReviewAuthConfigure({ clientId: clientId.trim(), clientSecret });
      setAuthStatus(status);
      setClientSecret("");
      setAuthConfigOpen(false);
      showToast(t("panel.githubPrReview.auth.saved"), { variant: "success" });
    } catch {
      showToast(t("panel.githubPrReview.auth.configureFailed"), { variant: "error" });
    } finally {
      setAuthBusy(false);
    }
  };

  const startSignIn = async () => {
    const attempt = ++authAttempt.current;
    setAuthBusy(true);
    try {
      setAuthStatus(await api.githubPrReviewAuthStart());
      const status = await api.githubPrReviewAuthWait();
      if (authAttempt.current !== attempt) return;
      setAuthStatus(status);
      showToast(t("panel.githubPrReview.auth.connected"), { variant: "success" });
      void loadPullRequests();
    } catch {
      if (authAttempt.current === attempt) {
        const status = await api.githubPrReviewAuthStatus().catch(() => null);
        if (status) setAuthStatus(status);
        showToast(t("panel.githubPrReview.auth.signInFailed"), { variant: "error" });
      }
    } finally {
      if (authAttempt.current === attempt) setAuthBusy(false);
    }
  };

  const cancelSignIn = async () => {
    authAttempt.current += 1;
    setAuthBusy(false);
    setAuthStatus(await api.githubPrReviewAuthCancel().catch(() => null));
  };

  const disconnect = async () => {
    setAuthBusy(true);
    try {
      setAuthStatus(await api.githubPrReviewAuthDisconnect());
      showToast(t("panel.githubPrReview.auth.disconnected"), { variant: "success" });
    } catch {
      showToast(t("panel.githubPrReview.auth.signInFailed"), { variant: "error" });
    } finally {
      setAuthBusy(false);
    }
  };

  const clearAppConfiguration = async () => {
    setAuthBusy(true);
    try {
      setAuthStatus(await api.githubPrReviewAuthClearConfiguration());
      setClientId("");
      setClientSecret("");
      setAuthConfigOpen(false);
      showToast(t("panel.githubPrReview.auth.configurationCleared"), { variant: "success" });
    } catch {
      showToast(t("panel.githubPrReview.auth.configureFailed"), { variant: "error" });
    } finally {
      setAuthBusy(false);
    }
  };

  const openLineComment = (fileIndex: number, lineIndex: number, hunkIndex: number) => {
    if (!sessionId || !detail || !authStatus?.connected) return;
    const file = detail.files[fileIndex];
    const line = file && parseGitHubPatch(file.patch)[hunkIndex]?.lines[lineIndex];
    const lineNumber = line?.newLine ?? line?.oldLine;
    if (!file || !line || !lineNumber) return;
    setApprovalConfirmed(false);
    setWriteDraft({
      kind: "line-comment",
      sessionId,
      number: detail.pullRequest.number,
      headSha: detail.pullRequest.headSha,
      path: file.path,
      line: lineNumber,
      side: line.type === "del" ? "LEFT" : "RIGHT",
      body: "",
    });
  };

  const openReviewSubmission = () => {
    if (!sessionId || !detail || !authStatus?.connected) return;
    setApprovalConfirmed(false);
    setWriteDraft({
      kind: "review",
      sessionId,
      number: detail.pullRequest.number,
      headSha: detail.pullRequest.headSha,
      event: "COMMENT",
      body: "",
    });
  };

  const submitExternalWrite = async () => {
    if (!writeDraft || !writeDraft.body.trim() || writeBusy) return;
    if (writeDraft.event === "APPROVE" && !approvalConfirmed) return;
    if (writeDraft.sessionId !== sessionId || !detail || writeDraft.headSha !== detail.pullRequest.headSha) {
      setWriteDraft(null);
      showToast(t("panel.githubPrReview.write.stale"), { variant: "error" });
      return;
    }
    setWriteBusy(true);
    try {
      if (writeDraft.kind === "line-comment") {
        await api.githubPrReviewComment({
          sessionId: writeDraft.sessionId,
          number: writeDraft.number,
          headSha: writeDraft.headSha,
          path: writeDraft.path ?? "",
          line: writeDraft.line ?? 0,
          side: writeDraft.side ?? "RIGHT",
          body: writeDraft.body,
        });
      } else {
        await api.githubPrReviewSubmit({
          sessionId: writeDraft.sessionId,
          number: writeDraft.number,
          headSha: writeDraft.headSha,
          event: writeDraft.event ?? "COMMENT",
          body: writeDraft.body,
        });
      }
      setWriteDraft(null);
      setApprovalConfirmed(false);
      showToast(t("panel.githubPrReview.write.sent"), { variant: "success" });
    } catch {
      showToast(t("panel.githubPrReview.write.failed"), { variant: "error" });
    } finally {
      setWriteBusy(false);
    }
  };

  if (!sessionId) {
    return <WorkTabEmpty icon={IconPullRequest} title={t("panel.githubPrReview.noSession")} />;
  }
  if (isRemote) {
    return <WorkTabEmpty icon={IconPullRequest} title={t("panel.githubPrReview.localOnly")} />;
  }
  if (!workspacePath) {
    return <WorkTabEmpty icon={IconPullRequest} title={t("panel.githubPrReview.noWorkspace")} />;
  }

  const writeTarget = writeDraft?.kind === "line-comment"
    ? `${writeDraft.path}:${writeDraft.line} · ${writeDraft.headSha}`
    : writeDraft ? `${list?.repository.fullName ?? ""} #${writeDraft.number} · ${writeDraft.headSha}` : "";
  const writeTitle = writeDraft?.kind === "line-comment"
    ? t("panel.githubPrReview.write.lineTitle")
    : t("panel.githubPrReview.write.reviewTitle");
  const writeAction = writeDraft?.kind === "line-comment"
    ? t("panel.githubPrReview.write.postComment")
    : t(`panel.githubPrReview.write.events.${(writeDraft?.event ?? "COMMENT").toLowerCase()}`);

  return (
    <div className="github-pr-review-tab">
      <section className="github-pr-auth-card" aria-label={t("panel.githubPrReview.auth.title")}>
        <div className="github-pr-auth-heading">
          <strong>{t("panel.githubPrReview.auth.title")}</strong>
          {authStatus?.connected && <span className="github-pr-auth-account">{t("panel.githubPrReview.auth.signedIn", { login: authStatus.login })}</span>}
        </div>
        <p className="github-pr-review-note">{t("panel.githubPrReview.auth.description")}</p>
        {authStatus?.pending ? (
          <div className="github-pr-auth-actions">
            <span role="status">{t("panel.githubPrReview.auth.waiting")}</span>
            <Button size="sm" variant="ghost" onClick={() => void cancelSignIn()}>{t("panel.githubPrReview.auth.cancel")}</Button>
          </div>
        ) : authStatus?.connected && !authConfigOpen ? (
          <div className="github-pr-auth-actions">
            <Button size="sm" variant="ghost" disabled={authBusy} onClick={() => void disconnect()}>{t("panel.githubPrReview.auth.signOut")}</Button>
            <Button size="sm" variant="ghost" disabled={authBusy} onClick={() => setAuthConfigOpen(true)}>{t("panel.githubPrReview.auth.reconfigure")}</Button>
          </div>
        ) : authStatus?.configured && !authConfigOpen ? (
          <div className="github-pr-auth-actions">
            <Button size="sm" onClick={() => void startSignIn()} disabled={authBusy}>{t("panel.githubPrReview.auth.signIn")}</Button>
            <Button size="sm" variant="ghost" disabled={authBusy} onClick={() => setAuthConfigOpen(true)}>{t("panel.githubPrReview.auth.reconfigure")}</Button>
          </div>
        ) : (
          <div className="github-pr-auth-setup">
            <Field label={t("panel.githubPrReview.auth.clientId")}>
              <Input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label={t("panel.githubPrReview.auth.clientSecret")}>
              <Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" spellCheck={false} />
            </Field>
            <details className="github-pr-auth-help">
              <summary>{t("panel.githubPrReview.auth.setupHelp")}</summary>
              <p>{t("panel.githubPrReview.auth.setupInstructions")}</p>
            </details>
            <div className="github-pr-auth-actions">
              <Button size="sm" disabled={authBusy || !clientId.trim() || !clientSecret} onClick={() => void saveAppCredentials()}>{t("panel.githubPrReview.auth.save")}</Button>
              {authStatus?.configured && <Button size="sm" variant="ghost" disabled={authBusy} onClick={() => setAuthConfigOpen(false)}>{t("panel.githubPrReview.auth.cancel")}</Button>}
              {authStatus?.configured && <Button size="sm" variant="ghost" disabled={authBusy} onClick={() => void clearAppConfiguration()}>{t("panel.githubPrReview.auth.clearConfiguration")}</Button>}
            </div>
          </div>
        )}
      </section>

      <div className="github-pr-review-toolbar">
        <div className="github-pr-review-source">
          <IconPullRequest size={15} />
          <span>{list?.repository.fullName ?? t("panel.githubPrReview.repository")}</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="github-pr-review-refresh"
          aria-label={t("panel.githubPrReview.load")}
          title={t("panel.githubPrReview.load")}
          disabled={loading}
          onClick={() => void loadPullRequests()}
        >
          <IconRefresh size={14} />
          {t("panel.githubPrReview.load")}
        </Button>
      </div>
      <p className="github-pr-review-note">{t("panel.githubPrReview.accessNote")}</p>

      {!list && error !== "list" && !loading && (
        <WorkTabEmpty icon={IconPullRequest} title={t("panel.githubPrReview.loadPrompt")}>
          <Button size="sm" onClick={() => void loadPullRequests()}>{t("panel.githubPrReview.load")}</Button>
        </WorkTabEmpty>
      )}
      {loading && !detail && <WorkTabEmpty icon={IconPullRequest} title={t("panel.githubPrReview.loading")} />}
      {error === "list" && !list && (
        <WorkTabEmpty icon={IconPullRequest} title={t("panel.githubPrReview.loadFailed")}>
          <p className="github-pr-review-note">{t("panel.githubPrReview.auth.privateHint")}</p>
          <Button size="sm" onClick={() => void loadPullRequests()}>{t("panel.githubPrReview.retry")}</Button>
        </WorkTabEmpty>
      )}
      {list && list.pullRequests.length === 0 && (
        <WorkTabEmpty icon={IconPullRequest} title={t("panel.githubPrReview.noOpenPullRequests")} />
      )}
      {list && list.pullRequests.length > 0 && (
        <div className="github-pr-review-content">
          <Select
            aria-label={t("panel.githubPrReview.selectPullRequest")}
            value={selectedNumber?.toString() ?? ""}
            disabled={loading}
            onChange={(event) => void selectPullRequest(Number(event.target.value))}
          >
            <option value="">{t("panel.githubPrReview.selectPullRequest")}</option>
            {list.pullRequests.map((pullRequest) => (
              <option key={pullRequest.number} value={pullRequest.number}>
                #{pullRequest.number} · {pullRequest.title}
              </option>
            ))}
          </Select>
          {error === "list" && <div className="github-pr-review-note" role="status">{t("panel.githubPrReview.loadFailed")}</div>}
          {error === "detail" && <div className="github-pr-review-note" role="status">{t("panel.githubPrReview.detailFailed")}</div>}
          {detail && (
            <>
              <div className="github-pr-review-summary">
                <strong>#{detail.pullRequest.number} {detail.pullRequest.title}</strong>
                <span>{t("panel.githubPrReview.branchPair", { base: detail.pullRequest.baseRef, head: detail.pullRequest.headRef })}</span>
                <span>{t("panel.githubPrReview.author", { author: detail.pullRequest.author })}</span>
                <span className={`github-pr-check-state is-${detail.checksState}`}>
                  {t(`panel.githubPrReview.checks.${detail.checksState}`)}
                </span>
                <Button size="sm" disabled={!authStatus?.connected || loading} onClick={openReviewSubmission}>
                  {t("panel.githubPrReview.write.reviewAction")}
                </Button>
              </div>
              {detail.filesTruncated && <div className="github-pr-review-note">{t("panel.githubPrReview.filesTruncated")}</div>}
              {detail.files.length === 0 ? (
                <div className="github-pr-review-note">{t("panel.githubPrReview.noFiles")}</div>
              ) : (
                <div className="github-pr-review-scroll">
                  {detail.files.map((file, fileIndex) => {
                    const hunks = parseGitHubPatch(file.patch);
                    return (
                      <section className="github-pr-review-file" key={`${file.path}:${fileIndex}`}>
                        <header className="github-pr-review-file-header">
                          <code>{file.path}</code>
                          <span>{t(`panel.review.status.${file.status === "removed" ? "deleted" : file.status === "changed" ? "modified" : file.status}`)}</span>
                          <span className="diff-counts">
                            <span className="diff-count-add">+{file.additions}</span>
                            <span className="diff-count-del">−{file.deletions}</span>
                          </span>
                        </header>
                        {hunks.length === 0 ? (
                          <div className="review-change-note">{t("panel.githubPrReview.noPatch")}</div>
                        ) : (
                          <div className="branch-review-diff">
                            {hunks.map((hunk, hunkIndex) => (
                              <div className="diff-hunk" key={`${hunk.header}:${hunkIndex}`}>
                                <div className="diff-line hunk"><span className="diff-line-text">{hunk.header}</span></div>
                                {hunk.lines.map((line, lineIndex) => (
                                  <div className={`diff-line ${line.type} github-pr-review-line`} key={`${line.oldLine ?? "o"}:${line.newLine ?? "n"}:${lineIndex}`}>
                                    <span className="branch-review-line-number old">{line.oldLine ?? ""}</span>
                                    <span className="branch-review-line-number new">{line.newLine ?? ""}</span>
                                    <span className="diff-line-sign" aria-hidden>{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span>
                                    <span className="diff-line-text">{line.text}</span>
                                    {line.type !== "context" && (
                                      <div className="github-pr-review-line-actions">
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="branch-review-line-feedback"
                                          aria-label={t("panel.githubPrReview.addFeedbackAtLine", { path: file.path, line: line.newLine ?? line.oldLine ?? "?" })}
                                          disabled={addingFeedback}
                                          onClick={() => addFeedback(fileIndex, lineIndex, hunkIndex)}
                                        >
                                          {t("panel.githubPrReview.addFeedback")}
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          disabled={!authStatus?.connected}
                                          onClick={() => openLineComment(fileIndex, lineIndex, hunkIndex)}
                                        >
                                          {t("panel.githubPrReview.write.commentAction")}
                                        </Button>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {writeDraft && portalOverlay(
        <OverlayBackdrop
          className="overlay github-pr-write-overlay"
          role="presentation"
          onClick={(event) => {
            if (!writeBusy && event.target === event.currentTarget) setWriteDraft(null);
          }}
        >
          <section
            className="dialog github-pr-write-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="github-pr-write-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="github-pr-write-heading">
              <h2 id="github-pr-write-title">{writeTitle}</h2>
              <Button size="sm" variant="ghost" disabled={writeBusy} onClick={() => setWriteDraft(null)}>{t("panel.githubPrReview.write.cancel")}</Button>
            </div>
            <p className="github-pr-review-note">{t("panel.githubPrReview.write.externalWarning")}</p>
            <div className="github-pr-write-target"><code>{writeTarget}</code></div>
            {writeDraft.kind === "review" && (
              <Field label={t("panel.githubPrReview.write.event")}>
                <Select
                  value={writeDraft.event ?? "COMMENT"}
                  onChange={(event) => {
                    setApprovalConfirmed(false);
                    setWriteDraft((current) => current ? { ...current, event: event.target.value as GitHubPullRequestReviewEvent } : current);
                  }}
                >
                  {(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const).map((event) => (
                    <option key={event} value={event}>{t(`panel.githubPrReview.write.events.${event.toLowerCase()}`)}</option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t("panel.githubPrReview.write.body")}>
              <Textarea
                rows={5}
                maxLength={20_000}
                value={writeDraft.body}
                onChange={(event) => setWriteDraft((current) => current ? { ...current, body: event.target.value } : current)}
              />
            </Field>
            <div className="github-pr-write-preview">
              <strong>{t("panel.githubPrReview.write.preview")}</strong>
              <div>{writeDraft.body || t("panel.githubPrReview.write.emptyPreview")}</div>
            </div>
            {writeDraft.event === "APPROVE" && (
              <Checkbox
                checked={approvalConfirmed}
                onChange={(event) => setApprovalConfirmed(event.target.checked)}
                label={t("panel.githubPrReview.write.approveConfirmation", { number: writeDraft.number })}
              />
            )}
            <div className="github-pr-write-actions">
              <Button variant="ghost" disabled={writeBusy} onClick={() => setWriteDraft(null)}>{t("panel.githubPrReview.write.cancel")}</Button>
              <Button
                variant="primary"
                disabled={writeBusy || !writeDraft.body.trim() || (writeDraft.event === "APPROVE" && !approvalConfirmed)}
                onClick={() => void submitExternalWrite()}
              >
                {writeBusy ? t("panel.githubPrReview.loading") : writeAction}
              </Button>
            </div>
          </section>
        </OverlayBackdrop>,
      )}
    </div>
  );
}
