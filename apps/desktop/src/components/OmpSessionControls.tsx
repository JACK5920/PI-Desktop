import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { flattenOmpSessionTree, normalizeOmpForkableMessages, normalizeOmpSessionControlState, ompQueuePromotionPayload, ompQueueRemovalPayload } from "./omp-session-controls.mjs";
import { IconMore } from "./icons";
import { TooltipButton } from "./ui";

type QueueSnapshot = { steering: string[]; followUp: string[] };
type CacheWarmingMode = "off" | "streaming" | "idle";
type CacheWarmingEvent = {
  type: "cache_warming_start" | "cache_warming_end";
  phase?: "streaming" | "idle";
  provider?: string;
  model?: string;
  outcome?: "hit" | "miss" | "error" | "aborted";
  warmingStopReason?: string;
};
type OmpState = {
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  interruptMode?: "immediate" | "wait";
  autoCompactionEnabled?: boolean;
  supportsBashExcludeFromContext?: boolean;
  hasPendingAsyncWork?: boolean;
  queuedMessages?: QueueSnapshot;
  sessionName?: string;
  sessionFile?: string;
  sessionId?: string;
  leaseState?: "held" | "free" | "unknown";
  messageCount?: number;
};
type OmpStats = {
  totalMessages?: number;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  premiumRequests?: number;
  tokens?: { total?: number };
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
};

async function stageOmpTreeImages(sessionId: string, images: Array<{ dataUrl: string; mimeType: string }>) {
  if (!images.length) return [];
  const payload = images.map((image, index) => {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/]+=*)$/i.exec(image.dataUrl);
    if (!match || match[1].toLowerCase() !== image.mimeType.toLowerCase()) throw new Error("OMP 图片无法安全恢复到输入框");
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
    const ext = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice("image/".length);
    return { name: `omp-tree-input-${index + 1}.${ext}`, mimeType: image.mimeType, data: bytes.buffer };
  });
  const saved = await api.pasteFiles(sessionId, payload);
  if (saved.files.length !== images.length) throw new Error("OMP 图片没有全部恢复到输入框");
  return saved.files.map((file) => ({ path: file.path, name: file.name, kind: "image" as const, mimeType: file.mimeType }));
}

/** OMP-owned session controls. Queue/settings/status are read from and mutated
 * through OMP RPC; this panel never uses PI's queue or permission state. */
export function OmpSessionControls({ sessionId, t }: { sessionId: string | null; t: TFunction }) {
  const showToast = useAppStore((state) => state.showToast);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<OmpState>({});
  const [busy, setBusy] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [autoRetrySelection, setAutoRetrySelection] = useState<boolean | null>(null);
  const [cacheWarmingMode, setCacheWarmingMode] = useState<CacheWarmingMode | null>(null);
  const [cacheWarmingEvent, setCacheWarmingEvent] = useState<CacheWarmingEvent | null>(null);
  const [bash, setBash] = useState("");
  const [bashExcludeFromContext, setBashExcludeFromContext] = useState(false);
  const [bashOutput, setBashOutput] = useState("");
  const [compactInstructions, setCompactInstructions] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [treeRows, setTreeRows] = useState<Array<{ id: string; parentId: string | null; type: string; role: string | null; depth: number; active: boolean; label: string | null; summary: string }>>([]);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedTreeEntry, setSelectedTreeEntry] = useState<string | null>(null);
  const [branchLabel, setBranchLabel] = useState("");
  const [forkableMessages, setForkableMessages] = useState<Array<{ entryId: string; text: string }>>([]);
  const [forkableMessagesLoading, setForkableMessagesLoading] = useState(false);
  const [stats, setStats] = useState<OmpStats>({});
  const [statsLoading, setStatsLoading] = useState(false);
  const sessionRef = useRef(sessionId);
  const refreshGenerationRef = useRef(0);
  const treeGenerationRef = useRef(0);
  const statsGenerationRef = useRef(0);
  const forkableMessagesGenerationRef = useRef(0);
  sessionRef.current = sessionId;

  const refresh = async (id = sessionId) => {
    if (!id) return;
    const generation = ++refreshGenerationRef.current;
    const response: any = await api.ompRpcCommand({ sessionId: id, command: "get_state" });
    if (generation !== refreshGenerationRef.current || sessionRef.current !== id) return;
    const nativeSessionId = typeof response?.data?.sessionId === "string" ? response.data.sessionId : "";
    let leaseState: OmpState["leaseState"] = "unknown";
    if (nativeSessionId) {
      try {
        const lease: any = await api.ompRpcCommand({ sessionId: id, command: "get_session_lease", fields: { sessionIds: [nativeSessionId] } });
        if (generation !== refreshGenerationRef.current || sessionRef.current !== id) return;
        const held = Array.isArray(lease?.data?.held) ? lease.data.held : [];
        const unknown = Array.isArray(lease?.data?.unknown) ? lease.data.unknown : [];
        leaseState = held.includes(nativeSessionId) ? "held" : unknown.includes(nativeSessionId) ? "unknown" : "free";
      } catch {
        leaseState = "unknown";
      }
    }
    const next = { ...normalizeOmpSessionControlState(response?.data), sessionId: nativeSessionId, leaseState } as OmpState;
    setState(next);
    setSessionName(String(next.sessionName ?? ""));
  };

  const refreshTree = async (id = sessionId) => {
    if (!id || treeLoading) return;
    const generation = ++treeGenerationRef.current;
    setTreeLoading(true);
    try {
      const response: any = await api.ompRpcCommand({ sessionId: id, command: "get_tree" });
      if (sessionRef.current !== id || generation !== treeGenerationRef.current) return;
      const tree = flattenOmpSessionTree(response?.data);
      setTreeRows(tree.rows);
      setTreeTruncated(tree.truncated);
    } finally {
      if (generation === treeGenerationRef.current) setTreeLoading(false);
    }
  };

  const refreshStats = async (id = sessionId) => {
    if (!id || statsLoading) return;
    const generation = ++statsGenerationRef.current;
    setStatsLoading(true);
    try {
      const response: any = await api.ompRpcCommand({ sessionId: id, command: "get_session_stats" });
      if (sessionRef.current !== id || generation !== statsGenerationRef.current) return;
      const data = response?.data && typeof response.data === "object" ? response.data : {};
      setStats({
        ...(Number.isSafeInteger(data.totalMessages) ? { totalMessages: data.totalMessages } : {}),
        ...(Number.isSafeInteger(data.userMessages) ? { userMessages: data.userMessages } : {}),
        ...(Number.isSafeInteger(data.assistantMessages) ? { assistantMessages: data.assistantMessages } : {}),
        ...(Number.isSafeInteger(data.toolCalls) ? { toolCalls: data.toolCalls } : {}),
        ...(Number.isSafeInteger(data.premiumRequests) ? { premiumRequests: data.premiumRequests } : {}),
        ...(Number.isSafeInteger(data.tokens?.total) ? { tokens: { total: data.tokens.total } } : {}),
        ...(typeof data.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0 ? { cost: data.cost } : {}),
        ...(data.contextUsage && typeof data.contextUsage === "object" ? { contextUsage: {
          ...(Number.isFinite(data.contextUsage.tokens) ? { tokens: data.contextUsage.tokens } : {}),
          ...(Number.isFinite(data.contextUsage.contextWindow) && data.contextUsage.contextWindow > 0 ? { contextWindow: data.contextUsage.contextWindow } : {}),
          ...(Number.isFinite(data.contextUsage.percent) ? { percent: data.contextUsage.percent } : {}),
        } } : {}),
      });
    } finally {
      if (generation === statsGenerationRef.current) setStatsLoading(false);
    }
  };

  const refreshForkableMessages = async (id = sessionId) => {
    if (!id || forkableMessagesLoading) return;
    const generation = ++forkableMessagesGenerationRef.current;
    setForkableMessagesLoading(true);
    try {
      const response: any = await api.ompRpcCommand({ sessionId: id, command: "get_branch_messages" });
      if (sessionRef.current !== id || generation !== forkableMessagesGenerationRef.current) return;
      setForkableMessages(normalizeOmpForkableMessages(response?.data));
    } finally { if (generation === forkableMessagesGenerationRef.current) setForkableMessagesLoading(false); }
  };

  const saveBranchLabel = async () => {
    if (!sessionId || !selectedTreeEntry || busy) return;
    const label = branchLabel.trim().slice(0, 120);
    setBusy(true);
    try {
      await api.ompRpcCommand({ sessionId, command: "set_label", fields: { entryId: selectedTreeEntry, label } });
      await refreshTree(sessionId);
      showToast(t("settings.omp.branchLabelSaved"), { variant: "success" });
    } catch (error) { showToast(error instanceof Error ? error.message : String(error), { variant: "error" }); }
    finally { setBusy(false); }
  };

  const forkSelectedEntry = async () => {
    if (!sessionId || !selectedTreeEntry || busy || isBusy || state.hasPendingAsyncWork === true || !selectedTreeRow || !["user", "assistant"].includes(selectedTreeRow.role ?? "")) return;
    setBusy(true);
    try {
      const result = await api.forkOmpSession({ sessionId, entryId: selectedTreeEntry });
      useAppStore.getState().syncNativeSessionTranscript(sessionId, result.parentMessages);
      await useAppStore.getState().refreshSessions();
      await useAppStore.getState().selectSession(result.session.id);
      showToast(t("settings.omp.sessionForkCreated"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally { setBusy(false); }
  };

  const navigateSelectedEntry = async () => {
    if (!sessionId || !selectedTreeEntry || busy || isBusy || state.hasPendingAsyncWork === true || !selectedTreeRow || !["user", "assistant"].includes(selectedTreeRow.role ?? "")) return;
    setBusy(true);
    try {
      const result = await api.navigateOmpTree({ sessionId, entryId: selectedTreeEntry });
      if (result.cancelled) return;
      useAppStore.getState().syncNativeSessionTranscript(sessionId, result.messages);
      if (typeof result.editorText === "string") {
        let fileReferences: Array<{ path: string; name: string; kind: "image"; mimeType: string }> = [];
        try {
          fileReferences = await stageOmpTreeImages(sessionId, result.editorImages ?? []);
        } catch (error) {
          if (result.previousLeafId) {
            const rollback = await api.navigateOmpTree({ sessionId, entryId: result.previousLeafId });
            if (!rollback.cancelled) useAppStore.getState().syncNativeSessionTranscript(sessionId, rollback.messages);
          }
          throw error;
        }
        useAppStore.setState({ composerPrefill: { sessionId, text: result.editorText, fileReferences } });
      }
      await Promise.all([refresh(sessionId), refreshTree(sessionId)]);
      showToast(t("settings.omp.branchNavigationSaved"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally { setBusy(false); }
  };

  useEffect(() => {
    refreshGenerationRef.current += 1;
    treeGenerationRef.current += 1;
    statsGenerationRef.current += 1;
    forkableMessagesGenerationRef.current += 1;
    setOpen(false); setState({}); setBashOutput(""); setBash(""); setBashExcludeFromContext(false); setBashRunning(false); setAutoRetrySelection(null); setCacheWarmingMode(null); setCacheWarmingEvent(null); setTreeRows([]); setTreeTruncated(false); setTreeLoading(false); setStats({}); setStatsLoading(false); setSelectedTreeEntry(null); setBranchLabel(""); setForkableMessages([]); setForkableMessagesLoading(false);
    if (sessionId) void refresh(sessionId).catch(() => undefined);
  }, [sessionId]);

  useEffect(() => {
    if (!open || !sessionId) return;
    return api.onOmpRpcEvent((event) => {
      if (event.sessionId !== sessionId) return;
      const frame = event.frame as Record<string, any>;
      if (frame.type === "queue_update") {
        setState((current) => ({ ...current, queuedMessages: {
          steering: Array.isArray(frame.steering) ? frame.steering : [],
          followUp: Array.isArray(frame.followUp) ? frame.followUp : [],
        } }));
      }
      if (frame.type === "cache_warming_start" || frame.type === "cache_warming_end") {
        setCacheWarmingEvent({
          type: frame.type,
          ...(frame.phase === "streaming" || frame.phase === "idle" ? { phase: frame.phase } : {}),
          ...(typeof frame.provider === "string" ? { provider: frame.provider } : {}),
          ...(typeof frame.model === "string" ? { model: frame.model } : {}),
          ...(frame.outcome === "hit" || frame.outcome === "miss" || frame.outcome === "error" || frame.outcome === "aborted" ? { outcome: frame.outcome } : {}),
          ...(typeof frame.warmingStopReason === "string" ? { warmingStopReason: frame.warmingStopReason } : {}),
        });
      }
      if (frame.type === "agent_start" || frame.type === "agent_end" || frame.type === "session_settled" || frame.type === "manual_compaction_start" || frame.type === "manual_compaction_end") {
        void refresh(sessionId).catch(() => undefined);
      }
    });
  }, [open, sessionId]);

  const run = async (command: string, fields: Record<string, unknown> = {}) => {
    if (!sessionId || busy) return null;
    setBusy(true);
    try {
      const response: any = await api.ompRpcCommand({ sessionId, command, fields });
      await refresh(sessionId);
      return response?.data ?? {};
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      return null;
    } finally { setBusy(false); }
  };

  const removeQueued = async (queue: "steering" | "followUp", message: string) => {
    // OMP matches the first exact user-authored text in the selected queue.
    // Keep this action explicit because duplicate queue text removes one item.
    const result = await run("remove_queued_message", ompQueueRemovalPayload(queue, message));
    if (result?.removed === false) showToast(t("settings.omp.queuedMessageAlreadyDelivered"), { variant: "info" });
  };

  const deliverQueuedAndContinue = async () => {
    const result = await run("abort_and_deliver_queue");
    if (result?.aborted === false) showToast(t("settings.omp.noQueuedMessageToDeliver"), { variant: "info" });
  };

  const toggle = async (command: string, value: string | boolean) => {
    await run(command, typeof value === "boolean" ? { enabled: value } : { mode: value });
  };

  const setAutoRetry = async (enabled: boolean) => {
    if (busy) return;
    const result = await run("set_auto_retry", { enabled });
    if (result !== null) setAutoRetrySelection(enabled);
  };

  const setCacheWarming = async (mode: CacheWarmingMode) => {
    const result = await run("set_cache_warming", { mode });
    if (result && (result.mode === "off" || result.mode === "streaming" || result.mode === "idle")) {
      setCacheWarmingMode(result.mode);
    }
  };

  const executeBash = async () => {
    const command = bash.trim();
    if (!command || !sessionId || busy) return;
    setBashRunning(true);
    setBashOutput("");
    try {
      const response: any = await api.ompRpcCommand({ sessionId, command: "bash", fields: {
        command,
        ...(bashExcludeFromContext && state.supportsBashExcludeFromContext === true ? { excludeFromContext: true } : {}),
      } });
      const data = response?.data;
      setBashOutput(typeof data?.output === "string" ? data.output : JSON.stringify(data ?? response, null, 2));
      setBash("");
    } catch (error) { showToast(error instanceof Error ? error.message : String(error), { variant: "error" }); }
    finally { setBashRunning(false); void refresh(sessionId).catch(() => undefined); }
  };

  const exportSession = async () => {
    const result = await run("export_html");
    const savedPath = typeof result?.savedPath === "string" ? result.savedPath : null;
    showToast(savedPath ? t("settings.omp.sessionExported", { path: savedPath }) : t("settings.omp.sessionExportNoPath"), { variant: savedPath ? "success" : "info" });
  };

  const handoff = async () => {
    const result = await run("handoff");
    if (result === null) return;
    showToast(typeof result?.savedPath === "string" ? t("settings.omp.sessionHandoffSaved", { path: result.savedPath }) : t("settings.omp.sessionHandoffEmpty"), { variant: "info" });
  };

  const copyLastAssistantText = async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      const response: any = await api.ompRpcCommand({ sessionId, command: "get_last_assistant_text" });
      const text = typeof response?.data?.text === "string" ? response.data.text : "";
      if (!text) { showToast(t("settings.omp.noLastAssistantText"), { variant: "info" }); return; }
      await navigator.clipboard.writeText(text);
      showToast(t("settings.omp.lastAssistantCopied"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally { setBusy(false); }
  };

  const queue = state.queuedMessages ?? { steering: [], followUp: [] };
  const isBusy = state.isStreaming === true || state.isCompacting === true;
  const selectedTreeRow = treeRows.find((row) => row.id === selectedTreeEntry);
  const canForkSelectedTreeRow = !!selectedTreeRow && ["user", "assistant"].includes(selectedTreeRow.role ?? "");

  return <div className="omp-native-command-picker omp-session-controls">
    <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("settings.omp.sessionControls")} ariaLabel={t("settings.omp.sessionControls")} aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (next) void Promise.all([refresh(), refreshTree(), refreshStats(), refreshForkableMessages()]).catch((error) => showToast(error instanceof Error ? error.message : String(error), { variant: "error" })); }}><IconMore size={15} aria-hidden="true" /></TooltipButton>
    {open ? <section className="omp-session-panel" aria-label={t("settings.omp.sessionControls")}>
      <header><strong>{t("settings.omp.sessionControls")}</strong><button type="button" disabled={busy} onClick={() => void refresh().catch((error) => showToast(error instanceof Error ? error.message : String(error), { variant: "error" }))}>{t("common.refresh")}</button></header>
      <div className="omp-session-summary"><span>{state.sessionName || t("settings.omp.unnamedSession")}</span><small>{t("settings.omp.sessionMessageCount", { count: Number(state.messageCount) || 0 })}</small><small>{isBusy ? t("settings.omp.sessionBusy") : t("settings.omp.sessionIdle")}</small></div>
      <section className="omp-session-section"><strong>{t("settings.omp.sessionQueue")}</strong>
        {([ ["steering", queue.steering], ["followUp", queue.followUp] ] as const).map(([queueName, items]) => items.map((message, index) => <div className="omp-session-queue-item" key={`${queueName}-${index}-${message}`}><span><small>{queueName === "steering" ? t("settings.omp.steeringQueue") : t("settings.omp.followUpQueue")}</small>{message}</span><button type="button" disabled={busy} onClick={() => void removeQueued(queueName, message)}>{t("settings.omp.removeQueuedMessage")}</button>{queueName === "followUp" ? <button type="button" disabled={busy} onClick={() => void run("promote_queued_message", ompQueuePromotionPayload(message))}>{t("settings.omp.promoteQueuedMessage")}</button> : null}</div>))}
        {!queue.steering.length && !queue.followUp.length ? <small>{t("settings.omp.queueEmpty")}</small> : null}
      </section>
      <section className="omp-session-section omp-session-tree" aria-label={t("settings.omp.sessionTree")}>
        <span className="omp-session-inline"><strong>{t("settings.omp.sessionTree")}</strong><button type="button" disabled={treeLoading} onClick={() => void refreshTree().catch((error) => showToast(error instanceof Error ? error.message : String(error), { variant: "error" }))}>{treeLoading ? t("common.loading") : t("common.refresh")}</button></span>
        <small>{t("settings.omp.sessionTreeReadOnly")}</small>
        {treeRows.length ? <ol>{treeRows.map((row) => <li key={row.id} className={row.active ? "is-active" : ""} style={{ paddingInlineStart: Math.min(row.depth, 12) * 12 }}><button type="button" aria-current={selectedTreeEntry === row.id ? "true" : undefined} onClick={() => { setSelectedTreeEntry(row.id); setBranchLabel(row.label ?? ""); }}><span>{row.active ? "● " : ""}{row.label || ((row.role ? row.role + " · " : "") + row.type)}</span><small>{row.summary || row.id}</small></button></li>)}</ol> : <small>{treeLoading ? t("common.loading") : t("settings.omp.sessionTreeEmpty")}</small>}
        {treeTruncated ? <small>{t("settings.omp.sessionTreeTruncated")}</small> : null}
        {selectedTreeEntry ? <>
          <span className="omp-session-inline"><input aria-label={t("settings.omp.branchLabel")} value={branchLabel} onChange={(event) => setBranchLabel(event.target.value)} maxLength={120} placeholder={t("settings.omp.branchLabelPlaceholder")} /><button type="button" disabled={busy} onClick={() => void saveBranchLabel()}>{t("common.save")}</button></span>
          <span className="omp-session-inline omp-session-tree-actions">
            <button type="button" disabled={busy || treeLoading || isBusy || state.hasPendingAsyncWork === true || selectedTreeRow?.active === true || !canForkSelectedTreeRow} title={!canForkSelectedTreeRow ? t("settings.omp.sessionTreeActionsUnavailable") : undefined} onClick={() => void navigateSelectedEntry()}>{t("settings.omp.navigateToEntry")}</button>
            <button type="button" disabled={busy || treeLoading || isBusy || state.hasPendingAsyncWork === true || !canForkSelectedTreeRow} title={!canForkSelectedTreeRow ? t("settings.omp.sessionForkUnavailable") : undefined} onClick={() => void forkSelectedEntry()}>{t("settings.omp.forkFromEntry")}</button>
          </span>
        </> : null}
        <div className="omp-session-forkable-messages" aria-live="polite"><strong>{t("settings.omp.forkableMessages")}</strong>{forkableMessagesLoading ? <small>{t("common.loading")}</small> : forkableMessages.length ? forkableMessages.map((message) => <p key={message.entryId}><b>{message.entryId}</b>{message.text ? ": " + message.text : ""}</p>) : <small>{t("settings.omp.noForkableMessages")}</small>}</div>
      </section>
      <section className="omp-session-section" aria-label={t("settings.omp.sessionStats")}>
        <span className="omp-session-inline"><strong>{t("settings.omp.sessionStats")}</strong><button type="button" disabled={statsLoading} onClick={() => void refreshStats().catch((error) => showToast(error instanceof Error ? error.message : String(error), { variant: "error" }))}>{statsLoading ? t("common.loading") : t("common.refresh")}</button></span>
        <small>{t("settings.omp.sessionStatsSummary", {
          messages: Number(stats.totalMessages ?? state.messageCount) || 0,
          toolCalls: Number(stats.toolCalls) || 0,
          tokens: Number(stats.tokens?.total) || 0,
          cost: typeof stats.cost === "number" ? stats.cost.toFixed(4) : "—",
        })}</small>
        <button type="button" disabled={busy} onClick={() => void copyLastAssistantText()}>{t("settings.omp.copyLastAssistantText")}</button>
        {typeof stats.contextUsage?.percent === "number" ? <small>{t("settings.omp.sessionContextUsage", { percent: Math.max(0, Math.min(100, stats.contextUsage.percent)).toFixed(1), tokens: Number(stats.contextUsage.tokens) || 0, window: Number(stats.contextUsage.contextWindow) || 0 })}</small> : null}
      </section>
      <section className="omp-session-section"><strong>{t("settings.omp.sessionBehavior")}</strong>
        <label>{t("settings.omp.steeringMode")}<select value={state.steeringMode ?? "one-at-a-time"} disabled={busy} onChange={(event) => void toggle("set_steering_mode", event.target.value)}><option value="one-at-a-time">{t("settings.omp.oneAtATime")}</option><option value="all">{t("settings.omp.deliverAll")}</option></select></label>
        <label>{t("settings.omp.followUpMode")}<select value={state.followUpMode ?? "one-at-a-time"} disabled={busy} onChange={(event) => void toggle("set_follow_up_mode", event.target.value)}><option value="one-at-a-time">{t("settings.omp.oneAtATime")}</option><option value="all">{t("settings.omp.deliverAll")}</option></select></label>
        <label>{t("settings.omp.interruptMode")}<select value={state.interruptMode ?? "immediate"} disabled={busy} onChange={(event) => void toggle("set_interrupt_mode", event.target.value)}><option value="immediate">{t("settings.omp.interruptImmediately")}</option><option value="wait">{t("settings.omp.interruptAfterStep")}</option></select></label>
        <label><input type="checkbox" checked={state.autoCompactionEnabled !== false} disabled={busy} onChange={(event) => void toggle("set_auto_compaction", event.target.checked)} />{t("settings.omp.autoCompaction")}</label>
        <label>{t("settings.omp.cacheWarming")}<select aria-label={t("settings.omp.cacheWarming")} value={cacheWarmingMode ?? ""} disabled={busy} onChange={(event) => { if (event.target.value === "off" || event.target.value === "streaming" || event.target.value === "idle") void setCacheWarming(event.target.value); }}><option value="" disabled>{t("settings.omp.cacheWarmingUnreported")}</option><option value="off">{t("settings.omp.cacheWarmingOff")}</option><option value="streaming">{t("settings.omp.cacheWarmingStreaming")}</option><option value="idle">{t("settings.omp.cacheWarmingIdle")}</option></select></label>
        <small>{t("settings.omp.cacheWarmingHint")}</small>
        {cacheWarmingEvent ? <small role="status">{cacheWarmingEvent.type === "cache_warming_start"
          ? t("settings.omp.cacheWarmingRunning", { phase: t(`settings.omp.cacheWarmingPhase.${cacheWarmingEvent.phase ?? "streaming"}`), provider: cacheWarmingEvent.provider ?? "—", model: cacheWarmingEvent.model ?? "—" })
          : t("settings.omp.cacheWarmingFinished", { phase: t(`settings.omp.cacheWarmingPhase.${cacheWarmingEvent.phase ?? "streaming"}`), outcome: t(`settings.omp.cacheWarmingOutcome.${cacheWarmingEvent.outcome ?? "error"}`), provider: cacheWarmingEvent.provider ?? "—", model: cacheWarmingEvent.model ?? "—", reason: cacheWarmingEvent.warmingStopReason ? ` — ${cacheWarmingEvent.warmingStopReason}` : "" })}</small> : null}
        <div className="omp-session-retry"><span>{t("settings.omp.autoRetry")}</span><small>{autoRetrySelection === null ? t("settings.omp.retryStateUnreported") : autoRetrySelection ? t("settings.omp.retryEnabledForSession") : t("settings.omp.retryDisabledForSession")}</small><span className="omp-session-inline"><button type="button" disabled={busy} aria-pressed={autoRetrySelection === true} onClick={() => void setAutoRetry(true)}>{t("settings.omp.enableAutoRetry")}</button><button type="button" disabled={busy} aria-pressed={autoRetrySelection === false} onClick={() => void setAutoRetry(false)}>{t("settings.omp.disableAutoRetry")}</button></span></div>
      </section>
      <section className="omp-session-section"><strong>{t("settings.omp.sessionActions")}</strong>
        {state.sessionId ? <small role="status">{t("settings.omp.sessionLease", { state: t(`settings.omp.sessionLeaseState.${state.leaseState ?? "unknown"}`) })}</small> : null}
        {isBusy && (queue.steering.length > 0 || queue.followUp.length > 0) ? <button type="button" disabled={busy} onClick={() => void deliverQueuedAndContinue()}>{t("settings.omp.abortAndDeliverQueued")}</button> : null}
        {!isBusy && (Number(state.messageCount) || 0) > 0 ? <button type="button" disabled={busy} onClick={() => void run("resume")}>{t("settings.omp.resumeNativeSession")}</button> : null}
        <label>{t("settings.omp.renameNativeSession")}<span className="omp-session-inline"><input value={sessionName} onChange={(event) => setSessionName(event.target.value)} maxLength={120} /><button type="button" disabled={busy || !sessionName.trim()} onClick={() => void run("set_session_name", { name: sessionName.trim() })}>{t("common.save")}</button></span></label>
        <label>{t("settings.omp.compactInstructions")}<input value={compactInstructions} onChange={(event) => setCompactInstructions(event.target.value)} placeholder={t("settings.omp.compactInstructionsOptional")} /></label>
        <button type="button" disabled={busy || isBusy} onClick={() => void run("compact", compactInstructions.trim() ? { customInstructions: compactInstructions.trim() } : {})}>{state.isCompacting ? t("settings.omp.compacting") : t("settings.omp.compactNow")}</button>
        {state.hasPendingAsyncWork ? <button type="button" disabled={busy} onClick={() => void run("abort_retry")}>{t("settings.omp.abortRetry")}</button> : null}
        <div className="omp-session-inline"><button type="button" disabled={busy || isBusy} onClick={() => void exportSession()}>{t("settings.omp.exportSession")}</button><button type="button" disabled={busy || isBusy} onClick={() => void handoff()}>{t("settings.omp.createHandoff")}</button></div>
      </section>
      <section className="omp-session-section"><strong>{t("settings.omp.nativeBash")}</strong><small>{t("settings.omp.nativeBashHint")}</small><label><input type="checkbox" checked={bashExcludeFromContext} disabled={state.supportsBashExcludeFromContext !== true || busy || bashRunning} onChange={(event) => setBashExcludeFromContext(event.target.checked)} />{t("settings.omp.bashExcludeFromContext")}</label>{state.supportsBashExcludeFromContext !== true ? <small>{t("settings.omp.bashExcludeFromContextUnsupported")}</small> : null}<span className="omp-session-inline"><input value={bash} onChange={(event) => setBash(event.target.value)} placeholder={t("settings.omp.nativeBashPlaceholder")} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void executeBash(); } }} /><button type="button" disabled={bashRunning || !bash.trim()} onClick={() => void executeBash()}>{bashRunning ? t("settings.omp.bashRunning") : t("settings.omp.runBash")}</button></span>{bashRunning ? <button type="button" disabled={busy} onClick={() => void run("abort_bash")}>{t("settings.omp.abortBash")}</button> : null}{bashOutput ? <pre className="omp-session-bash-output">{bashOutput}</pre> : null}</section>
    </section> : null}
  </div>;
}
