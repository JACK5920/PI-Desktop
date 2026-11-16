import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ArtifactSummary } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useChatFileMenu } from "../../hooks/use-chat-file-menu";
import { selectCurrentArtifacts } from "../../lib/turn-artifact-presentation";
import { Button, Input, cx } from "../ui";
import { ContextMenu } from "../ContextMenu";
import { IconCheck, IconFileText, IconFolderOpen, IconSearch } from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

type Artifact = ArtifactSummary;

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
}

function matchesArtifact(artifact: Artifact, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || artifact.path.toLocaleLowerCase().includes(normalized);
}

export function ArtifactsTab() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const messageCount = useAppStore((state) => state.messages.length);
  const openFile = useAppStore((state) => state.openFileInWorkPanel);
  const navigateTranscript = useAppStore((state) => state.navigateTranscript);
  const showToast = useAppStore((state) => state.showToast);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactsSessionId, setArtifactsSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"current" | "all" | "confirmed" | "detected" | "deleted">("current");
  const [recordsTotal, setRecordsTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const { fileMenu, openFileMenu, closeFileMenu } = useChatFileMenu();

  useEffect(() => {
    let alive = true;
    const epoch = ++requestEpoch.current;
    if (!sessionId) {
      setArtifacts([]);
      setArtifactsSessionId(null);
      setRecordsTotal(0);
      setHasMore(false);
      setFailed(false);
      setLoading(false);
      return () => { alive = false; };
    }
    setLoading(true);
    setFailed(false);
    void api.listArtifacts(sessionId, 200, undefined, 0).then((result) => {
      if (!alive || requestEpoch.current !== epoch) return;
      setArtifacts(result.artifacts);
      setArtifactsSessionId(sessionId);
      setRecordsTotal(result.total);
      setHasMore(result.hasMore);
    }).catch(() => {
      if (alive && requestEpoch.current === epoch) setFailed(true);
    }).finally(() => {
      if (alive && requestEpoch.current === epoch) setLoading(false);
    });
    return () => { alive = false; };
  }, [sessionId, messageCount]);

  const sessionArtifacts = artifactsSessionId === sessionId ? artifacts : [];
  const currentArtifacts = useMemo(() => selectCurrentArtifacts(sessionArtifacts), [sessionArtifacts]);
  const sourceArtifacts = filter === "current" ? currentArtifacts : sessionArtifacts;
  const visible = useMemo(
    () => sourceArtifacts.filter((artifact) => matchesArtifact(artifact, query) && (
      filter === "current" ||
      filter === "all" ||
      (filter === "confirmed" && artifact.source === "host_tool") ||
      (filter === "detected" && artifact.source === "workspace_diff") ||
      (filter === "deleted" && (!artifact.existsNow || !artifact.existsAfter))
    )),
    [sourceArtifacts, query, filter],
  );
  const reveal = useCallback(async (artifact: Artifact) => {
    try {
      await api.fsReveal(artifact.path, artifact.sessionId);
    } catch {
      showToast(t("chat.fileRevealFailed"), { variant: "error" });
    }
  }, [showToast, t]);
  const copyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(path);
      window.setTimeout(() => setCopied((current) => current === path ? null : current), 1400);
    } catch {
      setCopied(null);
    }
  }, []);

  const loadMore = useCallback(() => {
    if (!sessionId || loading || !hasMore) return;
    const epoch = requestEpoch.current;
    setLoading(true);
    void api.listArtifacts(sessionId, 200, undefined, artifacts.length).then((result) => {
      if (requestEpoch.current !== epoch || artifactsSessionId !== sessionId) return;
      setArtifacts((current) => {
        const known = new Set(current.map((artifact) => artifact.id));
        return [...current, ...result.artifacts.filter((artifact) => !known.has(artifact.id))];
      });
      setRecordsTotal(result.total);
      setHasMore(result.hasMore);
    }).catch(() => { if (requestEpoch.current === epoch) setFailed(true); }).finally(() => { if (requestEpoch.current === epoch) setLoading(false); });
  }, [sessionId, loading, hasMore, artifacts.length, artifactsSessionId]);

  if (!sessionId) return <WorkTabEmpty icon={IconFolderOpen} title={t("panel.artifacts.noSession")} />;

  return (
    <div className="artifacts-tab">
      <div className="artifacts-toolbar">
        <div className="artifacts-heading">
          <strong>{t("panel.artifacts.title")}</strong>
          <span>{t("panel.artifacts.recordsCount", { shown: sessionArtifacts.length, total: recordsTotal })}</span>
        </div>
        <label className="artifacts-search">
          <IconSearch size={14} aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("panel.artifacts.search")}
            aria-label={t("panel.artifacts.search")}
          />
        </label>
        <label className="artifacts-filter">
          <span className="sr-only">{t("panel.artifacts.filter")}</span>
          <select value={filter} onChange={(event) => setFilter(event.currentTarget.value as typeof filter)} aria-label={t("panel.artifacts.filter")}>
            <option value="current">{t("panel.artifacts.filterCurrent")}</option>
            <option value="all">{t("panel.artifacts.filterAll")}</option>
            <option value="confirmed">{t("panel.artifacts.filterConfirmed")}</option>
            <option value="detected">{t("panel.artifacts.filterDetected")}</option>
            <option value="deleted">{t("panel.artifacts.filterDeleted")}</option>
          </select>
        </label>
      </div>
      {loading ? <div className="artifacts-empty">{t("panel.artifacts.loading")}</div> : null}
      {!loading && failed ? <WorkTabEmpty icon={IconFolderOpen} title={t("panel.artifacts.loadFailed")} /> : null}
      {!loading && !failed && visible.length === 0 ? (
        <WorkTabEmpty icon={IconFolderOpen} title={query ? t("panel.artifacts.noMatches") : t("panel.artifacts.empty")} />
      ) : null}
      <div className="artifacts-scroll" role="list" aria-label={t("panel.artifacts.title")}>
        {visible.map((artifact) => {
          const name = fileName(artifact.path);
          return (
            <article
              className="artifact-row"
              key={artifact.id}
              role="listitem"
            >
              <button
                className="artifact-main"
                type="button"
                title={t("panel.artifacts.open", { name })}
                disabled={!artifact.existsNow}
                onClick={() => openFile(artifact.path)}
                onContextMenu={(event) => openFileMenu(event, { path: artifact.path })}
              >
                <IconFileText size={16} />
                <span className="artifact-labels">
                  <strong>{name}</strong>
                  <span title={artifact.path}>{artifact.path}</span>
                </span>
              </button>
              <div className="artifact-meta">
                <span className={cx("artifact-operation", `is-${artifact.op}`)}>
                  {t(`panel.artifacts.operation.${artifact.op}`, { defaultValue: artifact.op })}
                </span>
                <span>{artifact.source === "workspace_diff" ? t("panel.artifacts.detected") : t("panel.artifacts.confirmed")}</span>
                {artifact.confidence === "unverified" ? <span>{t("panel.artifacts.unverified")}</span> : null}
                {artifact.previousPath ? <span title={artifact.previousPath}>{t("panel.artifacts.renamedFrom", { path: fileName(artifact.previousPath) })}</span> : null}
                {artifact.turnId ? <span>{t("panel.artifacts.fromTask")}</span> : null}
                {artifact.turnStatus === "aborted" || artifact.turnStatus === "interrupted" || artifact.turnStatus === "failed" ? (
                  <span className="artifact-partial-status">{t("panel.artifacts.partialStatus")}</span>
                ) : null}
                <time dateTime={artifact.updatedAt}>{new Date(artifact.updatedAt).toLocaleString()}</time>
              </div>
              <div className="artifact-actions">
                {artifact.sourceMessageId ? (
                  <Button variant="ghost" size="sm" onClick={() => void navigateTranscript({ sessionId: artifact.sessionId, messageId: artifact.sourceMessageId!, query: "" })} title={t("panel.artifacts.openSource")}>
                    {t("panel.artifacts.openSource")}
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" disabled={!artifact.existsNow} onClick={() => void reveal(artifact)} title={t("panel.artifacts.reveal")}>
                  <IconFolderOpen size={14} />{t("panel.artifacts.reveal")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void copyPath(artifact.path)} title={t("panel.artifacts.copyPath")}>
                  {copied === artifact.path ? <IconCheck size={14} /> : null}
                  {copied === artifact.path ? t("chat.copied") : t("panel.artifacts.copyPath")}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      {hasMore ? <div className="artifacts-load-more"><Button variant="ghost" size="sm" disabled={loading} onClick={loadMore}>{t("panel.artifacts.loadMore")}</Button></div> : null}
      <ContextMenu state={fileMenu} onClose={closeFileMenu} />
    </div>
  );
}
