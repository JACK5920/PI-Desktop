import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { agentsForOmpToolCall, getOmpSubagentRoster, recordOmpSubagentRoster, recordOmpSubagentTranscriptOutcome, subscribeOmpSubagentRoster } from "../omp-subagent-roster.mjs";
import { SubagentTranscriptContent } from "./SubagentTranscriptContent";
import { ompSubagentIdentity, ompSubagentIsFallbackModel, ompSubagentIsRetrying, ompSubagentIsWaiting, ompSubagentLifecycleStatus, ompSubagentProgressSummary, ompSubagentResolvedModel, ompSubagentRetryFailure, ompSubagentRetryState, ompSubagentStatusKey, ompSubagentTaskDetail, ompSubagentTaskSummary, ompSubagentTranscriptOutcome } from "../omp-subagent-timeline.mjs";
import { buildOmpSubagentTranscriptTurns, getOmpSubagentConclusion } from "../omp-subagent-transcript.mjs";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useOmpSubagentRosterPolling } from "../omp-subagent-roster-polling";
import { IconArrowDown, IconCopy, IconPanelMaximize } from "../icons";
import { TooltipButton } from "../ui";
import { Markdown } from "../Markdown";
import { OmpSubagentConclusionReader } from "./OmpSubagentConclusionReader";

type OmpAgent = Record<string, any> & { id: string };

/** OMP-native subagent roster and transcript. Deliberately does not read PI delegation rows. */
export function OmpSubagentBatchTab({ toolCallId, selectedAgentId }: { toolCallId: string; selectedAgentId?: string }) {
  const { t } = useTranslation();
  const readableStatus = (status: unknown) => {
    const key = ompSubagentStatusKey(status);
    return key ? t(`chat.subagentStatus.${key}`) : t("settings.omp.subagentStatusUnknown");
  };
  const agentLifecycleLabel = (agent: OmpAgent) => {
    const status = ompSubagentLifecycleStatus(agent);
    const key = ompSubagentStatusKey(status);
    const retry = ompSubagentRetryState(agent);
    const retryFailure = ompSubagentRetryFailure(agent);
    if (ompSubagentIsRetrying(agent) && retry) return t("settings.omp.subagentRetrying", {
      attempt: retry.attempt,
      max: retry.maxAttempts,
      seconds: Math.ceil(retry.remainingMs / 1000),
      reason: retry.errorMessage || t("settings.omp.subagentRetryReasonUnavailable"),
    });
    if (ompSubagentIsWaiting(agent)) return t("settings.omp.subagentWaitingOnOwnWork");
    if (agent.observedActive === false && retryFailure && ["failed", "aborted"].includes(key)) {
      return t("settings.omp.subagentRetryFailed", { attempt: retryFailure.attempt, reason: retryFailure.errorMessage || t("settings.omp.subagentRetryReasonUnavailable") });
    }
    if (agent.observedActive === false && (!key || key === "running")) {
      return t("settings.omp.subagentNoLongerRunning");
    }
    return readableStatus(status);
  };
  const sessionId = useAppStore((state) => state.activeSessionId);
  const messages = useAppStore((state) => state.messages);
  const [agents, setAgents] = useState<OmpAgent[]>(() => sessionId ? getOmpSubagentRoster(sessionId) as OmpAgent[] : []);
  const [selected, setSelected] = useState<OmpAgent | null>(null);
  const [transcript, setTranscript] = useState<Array<Record<string, any>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [steerText, setSteerText] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [detailView, setDetailView] = useState<"conclusion" | "execution">("conclusion");
  const [readerOpen, setReaderOpen] = useState(false);
  const [conclusionCopied, setConclusionCopied] = useState(false);
  const [showConclusionJump, setShowConclusionJump] = useState(false);
  const nextByte = useRef(0);
  const requestBusy = useRef(false);
  const copyFeedbackTimer = useRef<number | null>(null);
  const conclusionScrollRef = useRef<HTMLDivElement>(null);
  const detailViewId = useId();
  const sourceTool = useMemo(() => messages.find((message) =>
    message.role === "tool" && (message.toolCallId === toolCallId || message.id === toolCallId),
  ), [messages, toolCallId]);
  const requestedTasks = useMemo(() => {
    const args = sourceTool?.toolArgs as Record<string, any> | undefined;
    return Array.isArray(args?.tasks) ? args.tasks : [];
  }, [sourceTool]);
  const { agents: visibleAgents, correlated } = useMemo(() => agentsForOmpToolCall(agents, toolCallId), [agents, toolCallId]);
  const activeCount = visibleAgents.filter((agent) => agent.observedActive !== false).length;
  const selectedAgent = selected ? agents.find((agent) => agent.id === selected.id) ?? selected : null;
  const focusedAgentView = Boolean(selectedAgentId);
  const selectedAgentIndex = selectedAgent ? Math.max(0, visibleAgents.findIndex((agent) => agent.id === selectedAgent.id)) : 0;
  const selectedAgentLabel = selectedAgent ? ompSubagentIdentity(selectedAgent, selectedAgentIndex, t("settings.omp.subagentNumber", { number: selectedAgentIndex + 1 }), visibleAgents) : "";
  const selectedAgentProgress = selectedAgent && selectedAgent.observedActive !== false ? ompSubagentProgressSummary(selectedAgent) : "";
  const selectedAgentModel = selectedAgent ? ompSubagentResolvedModel(selectedAgent) : "";
  const selectedAgentFallback = selectedAgent ? ompSubagentIsFallbackModel(selectedAgent) : false;
  const selectedAgentTask = selectedAgent ? ompSubagentTaskDetail(selectedAgent) : "";
  const selectedAgentTimelineStatus = selectedAgent ? ompSubagentLifecycleStatus(selectedAgent) : "";
  const selectedAgentDeliveryOutput = selectedAgent && typeof selectedAgent.deliveryOutput === "string" ? selectedAgent.deliveryOutput : "";
  const selectedAgentDeliveryStatus = selectedAgent && typeof selectedAgent.deliveryStatus === "string" ? selectedAgent.deliveryStatus : "";
  const selectedAgentDeliveryError = selectedAgent && typeof selectedAgent.deliveryError === "string" ? selectedAgent.deliveryError : "";
  const selectedAgentDeliveryAbortReason = selectedAgent && typeof selectedAgent.deliveryAbortReason === "string" ? selectedAgent.deliveryAbortReason : "";
  const transcriptTurns = useMemo(() => buildOmpSubagentTranscriptTurns(transcript, selectedAgentTimelineStatus, {
    unlinkedResult: t("settings.omp.subagentActionUnlinked"),
    image: t("settings.omp.subagentImageAttachment"),
  }, selectedAgentTask), [transcript, selectedAgentTimelineStatus, selectedAgentTask, t]);
  const conclusion = useMemo(() => getOmpSubagentConclusion(transcriptTurns, selectedAgentDeliveryOutput), [transcriptTurns, selectedAgentDeliveryOutput]);
  const conclusionText = conclusion?.content ?? "";
  const selectedAgentRunning = Boolean(selectedAgent && selectedAgent.observedActive !== false && ["running", "pending", "started"].includes(String(selectedAgent.status ?? "").toLowerCase()));
  const { scrollRef, contentRef, showJump, handleScroll, jumpToLatest, scheduleFollowScroll } = useFollowScroll();
  const updateConclusionJump = useCallback(() => {
    const element = conclusionScrollRef.current;
    const shouldShow = Boolean(element && element.scrollHeight - element.clientHeight - element.scrollTop > 8);
    setShowConclusionJump(shouldShow);
  }, []);
  const jumpConclusionToBottom = useCallback(() => {
    const element = conclusionScrollRef.current;
    if (!element) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    element.scrollTo({ top: Math.max(0, element.scrollHeight - element.clientHeight), behavior });
  }, []);

  useEffect(() => {
    if (!sessionId || !selectedAgent || selectedAgent.observedActive !== false) return;
    const outcome = ompSubagentTranscriptOutcome(transcript);
    if (!outcome) return;
    setAgents(recordOmpSubagentTranscriptOutcome(sessionId, selectedAgent.id, outcome) as OmpAgent[]);
  }, [sessionId, selectedAgent?.id, selectedAgent?.observedActive, transcript]);

  useLayoutEffect(() => { if (detailView === "execution") scheduleFollowScroll(); }, [detailView, scheduleFollowScroll, transcriptTurns]);

  useLayoutEffect(() => {
    if (detailView !== "conclusion") {
      setShowConclusionJump(false);
      return;
    }
    const scroller = conclusionScrollRef.current;
    if (!scroller) return;
    updateConclusionJump();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateConclusionJump);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, [conclusionText, detailView, updateConclusionJump]);

  useEffect(() => () => {
    if (copyFeedbackTimer.current !== null) window.clearTimeout(copyFeedbackTimer.current);
  }, []);

  useEffect(() => {
    setDetailView("conclusion");
    setReaderOpen(false);
    setConclusionCopied(false);
  }, [selectedAgent?.id]);

  // The roster poller is shared per session, so the transcript cards outside
  // this panel keep their status current even when no subagent pane is open.
  useOmpSubagentRosterPolling(sessionId);

  const runNativeAgentCommand = async (command: string, fields: Record<string, unknown>) => {
    if (!sessionId || !selectedAgent?.id || actionBusy) return;
    setActionBusy(true);
    try {
      await api.ompRpcCommand({ sessionId, command, fields });
      const result: any = await api.ompRpcCommand({ sessionId, command: "get_subagents" });
      if (useAppStore.getState().activeSessionId === sessionId) {
        const list = Array.isArray(result?.data?.subagents) ? result.data.subagents : [];
        setAgents(recordOmpSubagentRoster(sessionId, list.filter((agent: any) => typeof agent?.id === "string")) as OmpAgent[]);
      }
      if (command === "steer_subagent") setSteerText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActionBusy(false);
    }
  };

  const refreshRoster = async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const result: any = await api.ompRpcCommand({ sessionId, command: "get_subagents" });
      if (useAppStore.getState().activeSessionId !== sessionId) return;
      setAgents(recordOmpSubagentRoster(sessionId, Array.isArray(result?.data?.subagents) ? result.data.subagents.filter((agent: any) => typeof agent?.id === "string") : []) as OmpAgent[]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!sessionId) { setAgents([]); return; }
    setAgents(getOmpSubagentRoster(sessionId) as OmpAgent[]);
    return subscribeOmpSubagentRoster(sessionId, (roster) => {
      if (useAppStore.getState().activeSessionId === sessionId) setAgents(roster as OmpAgent[]);
    });
  }, [sessionId]);

  useEffect(() => {
    if (!selectedAgentId) return;
    const agent = agents.find((item) => item.id === selectedAgentId);
    if (agent && selected?.id !== selectedAgentId) {
      nextByte.current = 0;
      setTranscript([]);
      setSelected(agent);
    }
  }, [agents, selected?.id, selectedAgentId]);

  useEffect(() => {
    setAgents(sessionId ? getOmpSubagentRoster(sessionId) as OmpAgent[] : []); setSelected(null); setTranscript([]); setError(null); setLoading(false); nextByte.current = 0;
  }, [sessionId, toolCallId]);

  useEffect(() => {
    if (!sessionId || !selected?.id) return;
    let active = true;
    const refreshTranscript = async (replace: boolean) => {
      if (requestBusy.current) return;
      requestBusy.current = true;
      try {
        const fromByte = replace ? 0 : nextByte.current;
        const result: any = await api.ompRpcCommand({ sessionId, command: "get_subagent_messages", fields: { subagentId: selected.id, fromByte } });
        if (!active || useAppStore.getState().activeSessionId !== sessionId) return;
        const data = result?.data;
        const rows = Array.isArray(data?.messages) ? data.messages : [];
        setTranscript((current) => replace || data?.reset ? rows : [...current, ...rows]);
        nextByte.current = typeof data?.nextByte === "number" ? data.nextByte : fromByte;
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { requestBusy.current = false; }
    };
    nextByte.current = 0;
    setTranscript([]);
    void refreshTranscript(true);
    const timer = window.setInterval(() => { void refreshTranscript(false); }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [sessionId, selected?.id]);

  const choose = (agent: OmpAgent) => { nextByte.current = 0; setTranscript([]); setSelected(agent); };
  const copyConclusion = async () => {
    if (!conclusionText) return;
    try {
      await navigator.clipboard.writeText(conclusionText);
      setConclusionCopied(true);
      if (copyFeedbackTimer.current !== null) window.clearTimeout(copyFeedbackTimer.current);
      copyFeedbackTimer.current = window.setTimeout(() => setConclusionCopied(false), 1800);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const handleDetailTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "conclusion"
      : event.key === "End" ? "execution"
        : event.key === "ArrowRight" ? (detailView === "conclusion" ? "execution" : "conclusion")
          : (detailView === "execution" ? "conclusion" : "execution");
    setDetailView(next);
    requestAnimationFrame(() => document.getElementById(`${detailViewId}-${next}-tab`)?.focus());
  };
  return <section className={`omp-native-agent-panel omp-native-agent-panel-workspace${focusedAgentView ? " is-focused-agent" : ""}`} aria-label={focusedAgentView ? selectedAgentLabel : t("settings.omp.subagentManager")}>
    {!focusedAgentView
      ? <header><strong>{t("settings.omp.subagentManager")}</strong><span>{t("settings.omp.runningSubagents", { count: activeCount })}</span><button type="button" onClick={() => void refreshRoster()} disabled={loading}>{t("common.refresh")}</button></header>
      : selectedAgent ? <header className="omp-native-agent-focused-header"><div><strong>{selectedAgentLabel}</strong><span>{agentLifecycleLabel(selectedAgent)}</span></div><button type="button" onClick={() => void refreshRoster()} disabled={loading}>{t("common.refresh")}</button></header> : null}
    {!focusedAgentView && requestedTasks.length ? <details className="omp-native-requested-tasks"><summary>{t("settings.omp.requestedTasks", { count: requestedTasks.length })}</summary><ol>{requestedTasks.map((task: any, index: number) => <li key={String(task?.name ?? task?.id ?? index)} title={String(task?.name ?? task?.agent ?? task?.description ?? task?.task ?? `${index + 1}`)}>{ompSubagentTaskSummary({ task: String(task?.name ?? task?.agent ?? task?.description ?? task?.task ?? `${index + 1}`) })}</li>)}</ol><small>{t("settings.omp.requestedTasksNotConfirmed")}</small></details> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!focusedAgentView && agents.length > 0 && !correlated ? <p className="omp-native-agent-unlinked-note">{t("settings.omp.noCorrelatedSubagents")}</p> : null}
    {!focusedAgentView && visibleAgents.length ? <div className="omp-native-agent-list">{visibleAgents.map((agent, index) => {
      const identity = ompSubagentIdentity(agent, index, t("settings.omp.subagentNumber", { number: index + 1 }), visibleAgents);
      const taskSummary = ompSubagentTaskSummary(agent);
      const taskDetail = ompSubagentTaskDetail(agent);
      const progress = agent.observedActive === false ? "" : ompSubagentProgressSummary(agent);
      const resolvedModel = ompSubagentResolvedModel(agent);
      const fallbackModel = ompSubagentIsFallbackModel(agent);
      return <button type="button" key={agent.id} className={selected?.id === agent.id ? "is-selected" : ""} onClick={() => choose(agent)} title={[identity, taskDetail, progress].filter(Boolean).join(" · ")}>
        <strong>{identity}</strong>
        <small>{agentLifecycleLabel(agent)}{fallbackModel ? ` · ${t("settings.omp.subagentFallbackModel")}` : ""}{progress ? ` · ${progress}` : ""}</small>
        {resolvedModel ? <small className="omp-native-agent-model">{resolvedModel}</small> : null}
        {taskSummary ? <span className="omp-native-agent-task-summary">{taskSummary}</span> : null}
      </button>;
    })}</div> : !focusedAgentView ? <p>{agents.length ? t("settings.omp.noCorrelatedSubagents") : t("settings.omp.noSubagents")}</p> : null}
    {selectedAgent ? <div className="subagent-transcript-tab omp-native-agent-transcript-view">
      {!focusedAgentView ? <header className="subagent-transcript-agent-header"><strong>{selectedAgentLabel}</strong><span>{agentLifecycleLabel(selectedAgent)}</span></header> : null}
      {focusedAgentView ? <div className="omp-native-agent-live-status" role="status" aria-live="polite">
        <span className={`omp-native-agent-status-dot${selectedAgentRunning ? " is-running" : ""}`} aria-hidden="true" />
        <span title={agentLifecycleLabel(selectedAgent)}>{agentLifecycleLabel(selectedAgent)}</span>
        {selectedAgentFallback ? <span>{t("settings.omp.subagentFallbackModel")}</span> : null}
        {selectedAgentModel ? <span title={selectedAgentModel}>{selectedAgentModel}</span> : null}
        {selectedAgentProgress ? <span className="omp-native-agent-live-progress">{selectedAgentProgress}</span> : null}
      </div> : null}
      <div className="omp-native-agent-detail-tabs" role="tablist" aria-label={t("settings.omp.subagentDetailViews")} onKeyDown={handleDetailTabKeyDown}>
        <button type="button" id={`${detailViewId}-conclusion-tab`} data-omp-detail-tab="conclusion" role="tab" aria-selected={detailView === "conclusion"} aria-controls={`${detailViewId}-panel`} tabIndex={detailView === "conclusion" ? 0 : -1} onClick={() => setDetailView("conclusion")}>{t("settings.omp.subagentViewConclusion")}</button>
        <button type="button" id={`${detailViewId}-execution-tab`} data-omp-detail-tab="execution" role="tab" aria-selected={detailView === "execution"} aria-controls={`${detailViewId}-panel`} tabIndex={detailView === "execution" ? 0 : -1} onClick={() => setDetailView("execution")}>{t("settings.omp.subagentViewExecution")}</button>
      </div>
      <div id={`${detailViewId}-panel`} className="omp-native-agent-detail-panel" role="tabpanel" aria-labelledby={`${detailViewId}-${detailView}-tab`}>
        {detailView === "conclusion" ? <section className="omp-native-agent-conclusion-view" aria-label={t("settings.omp.subagentDelivery")}>
          <header className="omp-native-agent-conclusion-toolbar">
            <div>
              <strong>{t("settings.omp.subagentDelivery")}</strong>
              {conclusion?.source === "transcript" ? <span>{t("settings.omp.subagentConclusionFromTranscript")}</span> : null}
              {selectedAgentDeliveryStatus && selectedAgentDeliveryStatus !== selectedAgentTimelineStatus
                ? <small title={t("settings.omp.subagentDeliveryRawStatus")}>{selectedAgentDeliveryStatus}</small>
                : null}
            </div>
            <div className="omp-native-agent-conclusion-actions">
              <TooltipButton type="button" tooltip={conclusionCopied ? t("settings.omp.subagentConclusionCopied") : t("settings.omp.subagentConclusionCopy")} ariaLabel={conclusionCopied ? t("settings.omp.subagentConclusionCopied") : t("settings.omp.subagentConclusionCopy")} disabled={!conclusionText} onClick={() => void copyConclusion()}>
                <IconCopy size={15} />
              </TooltipButton>
              <TooltipButton type="button" tooltip={t("settings.omp.subagentConclusionExpand")} ariaLabel={t("settings.omp.subagentConclusionExpand")} disabled={!conclusionText} onClick={() => setReaderOpen(true)}>
                <IconPanelMaximize size={15} />
              </TooltipButton>
            </div>
          </header>
          <div ref={conclusionScrollRef} className="omp-native-agent-conclusion-scroll" onScroll={updateConclusionJump} tabIndex={0}>
            {conclusionText
              ? <article className="prose-chat selectable"><Markdown source={conclusionText} /></article>
              : selectedAgentDeliveryError
                ? <p role="alert" className="omp-native-agent-conclusion-empty is-error">{selectedAgentDeliveryError}</p>
                : selectedAgentDeliveryAbortReason
                  ? <p className="omp-native-agent-conclusion-empty">{selectedAgentDeliveryAbortReason}</p>
                  : <p className="omp-native-agent-conclusion-empty" role="status">{t("settings.omp.subagentConclusionEmpty")}</p>}
          </div>
          {selectedAgent?.deliveryOutputTruncated ? <small className="omp-native-agent-conclusion-note">{t("settings.omp.subagentDeliveryTruncated")}</small> : null}
        </section> : <div ref={scrollRef} className="subagent-transcript-scroll omp-native-agent-transcript" data-scroll-owner="follow" onScroll={handleScroll} role="log" aria-live="polite" aria-label={t("settings.omp.subagentExecutionTimeline")} tabIndex={0}>
          <div ref={contentRef}><SubagentTranscriptContent turns={transcriptTurns} emptyLabel={t("settings.omp.subagentTranscriptEmpty")} isRunning={selectedAgentRunning} compactTasks={!focusedAgentView} /></div>
        </div>}
      </div>
      {detailView === "execution" && showJump ? <TooltipButton type="button" className="jump-latest-btn subagent-transcript-jump" tooltip={t("chat.scrollToBottom")} ariaLabel={t("chat.scrollToBottom")} onClick={jumpToLatest}><IconArrowDown size={14} /></TooltipButton> : null}
      {detailView === "conclusion" && showConclusionJump ? <TooltipButton type="button" className="jump-latest-btn subagent-result-jump" tooltip={t("chat.scrollToBottom")} ariaLabel={t("chat.scrollToBottom")} onClick={jumpConclusionToBottom}><IconArrowDown size={14} /></TooltipButton> : null}
      <footer className="subagent-transcript-composer omp-native-agent-workpanel-actions">
        {selectedAgentRunning ? <>
          <input value={steerText} onChange={(event) => setSteerText(event.target.value)} placeholder={t("settings.omp.steerSubagentPlaceholder")} onKeyDown={(event) => { if (event.key === "Enter" && steerText.trim() && !actionBusy) { event.preventDefault(); void runNativeAgentCommand("steer_subagent", { subagentId: selectedAgent.id, message: steerText.trim() }); } }} />
          <button type="button" disabled={!steerText.trim() || actionBusy} onClick={() => void runNativeAgentCommand("steer_subagent", { subagentId: selectedAgent.id, message: steerText.trim() })}>{actionBusy ? t("common.loading") : t("settings.omp.steerSubagent")}</button>
          <button type="button" disabled={actionBusy} onClick={() => void runNativeAgentCommand("cancel_subagent", { subagentId: selectedAgent.id })}>{t("settings.omp.cancelSubagent")}</button>
        </> : <span className="omp-native-agent-status" title={agentLifecycleLabel(selectedAgent)}>{t("settings.omp.subagentStatusLabel", { status: agentLifecycleLabel(selectedAgent) })}</span>}
      </footer>
    </div> : null}
    {readerOpen && selectedAgent && conclusionText
      ? <OmpSubagentConclusionReader title={selectedAgentLabel} content={conclusionText} copied={conclusionCopied} onCopy={() => void copyConclusion()} onClose={() => setReaderOpen(false)} />
      : null}
  </section>;
}
