import { useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { ompSubagentImageSource } from "./omp-subagent-image.mjs";
import { applyOmpSubagentFrame, recordOmpSubagentRoster } from "./omp-subagent-roster.mjs";
import { ompSubagentsFromTaskFrame } from "../../electron/shared/omp-subagent-progress.mjs";
import { hasOmpTodoSnapshot, mergeOmpTodoMetadata, normalizeEditableOmpTodos, sameOmpTodoCore, updateEditableOmpTodoTask } from "./omp-todo-edit.mjs";
import { OmpSessionControls } from "./OmpSessionControls";
import { IconBot, IconChat, IconListChecks, IconMic, IconMicOff, IconTerminal, IconVolume } from "./icons";
import { Textarea, TooltipButton } from "./ui";

export function OmpSubagentMessage({ message, t }: { message: Record<string, any>; t: TFunction }) {
  const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
  const timestamp = typeof message.timestamp === "number" ? new Date(message.timestamp).toLocaleTimeString() : null;
  return <article className="omp-native-agent-message">
    <header><strong>{String(message.role ?? "")}</strong>{timestamp ? <time>{timestamp}</time> : null}</header>
    {content.map((part: any, index: number) => {
      if (typeof part?.text === "string" && (part.type === "text" || !part.type)) return <p className="omp-native-agent-message-text" key={index}>{part.text}</p>;
      if (part?.type === "thinking" && typeof part.thinking === "string") return <details className="omp-native-agent-message-detail" key={index}><summary>{t("settings.omp.subagentThinking")}</summary><p>{part.thinking}</p></details>;
      if (part?.type === "toolCall" || part?.type === "tool_call") {
        const name = String(part.name ?? part.toolName ?? "tool");
        const args = part.arguments ?? part.input ?? {};
        return <details className="omp-native-agent-tool-call" key={index}><summary>{t("settings.omp.subagentToolCall", { tool: name })}</summary><pre>{typeof args === "string" ? args : JSON.stringify(args, null, 2)}</pre></details>;
      }
      if (part?.type === "image") {
        const src = ompSubagentImageSource(part);
        return src
          ? <img className="omp-native-agent-image" key={index} src={src} alt={t("settings.omp.subagentImageAttachment")} loading="lazy" />
          : <span className="omp-native-agent-attachment" key={index}>{t("settings.omp.subagentImageAttachment")}</span>;
      }
      return null;
    })}
  </article>;
}

/** Native OMP RPC voice/dictation controls. Audio capture and transcription
 * remain owned by OMP; this component only presents its public RPC-UI surface. */
export function OmpNativeControls({ sessionId, t }: { sessionId: string | null; t: TFunction }) {
  const showToast = useAppStore((state) => state.showToast);
  const [live, setLive] = useState(false);
  const [liveConnecting, setLiveConnecting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [levels, setLevels] = useState({ input: 0, output: 0 });
  const [dictating, setDictating] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [commands, setCommands] = useState<Array<{ name: string; description?: string }>>([]);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [ompGoal, setOmpGoal] = useState<Record<string, any> | null>(null);
  const [ompTodos, setOmpTodos] = useState<Array<Record<string, any>>>([]);
  const [todoHistoryLoaded, setTodoHistoryLoaded] = useState(false);
  const [todoEdit, setTodoEdit] = useState<{ phaseIndex: number; taskIndex: number; content: string; status: string; details: string; notes: string } | null>(null);
  const [todoEditBusy, setTodoEditBusy] = useState(false);
  const [goalObjective, setGoalObjective] = useState("");
  const [goalTokenBudget, setGoalTokenBudget] = useState("");
  const [goalBusy, setGoalBusy] = useState(false);
  const [btwOpen, setBtwOpen] = useState(false);
  const [btwQuestion, setBtwQuestion] = useState("");
  const [btwFollowupRecordId, setBtwFollowupRecordId] = useState<string | null>(null);
  const [btwSelectedRecordId, setBtwSelectedRecordId] = useState<string | null>(null);
  const [btwSubmitting, setBtwSubmitting] = useState(false);
  const btwSubmittingRef = useRef(false);
  const btwSelectedRecordIdRef = useRef<string | null>(null);
  const btwHistoryRefreshRef = useRef(false);
  const btwHistoryRefreshPendingRef = useRef(false);
  const [btwRecords, setBtwRecords] = useState<Array<Record<string, any>>>([]);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const agentsOpenRef = useRef(false);
  const [agents, setAgents] = useState<Array<Record<string, any>>>([]);
  const [selectedAgent, setSelectedAgent] = useState<Record<string, any> | null>(null);
  const [agentMessages, setAgentMessages] = useState<Array<Record<string, any>>>([]);
  const [agentNextByte, setAgentNextByte] = useState<number | null>(null);
  const selectedAgentRef = useRef<Record<string, any> | null>(null);
  const agentNextByteRef = useRef<number | null>(null);
  const agentTranscriptReadRef = useRef(false);
  const agentTranscriptPendingRef = useRef<{ sessionId: string; agentId: string; mode: "replace" | "append" } | null>(null);
  const [steerText, setSteerText] = useState("");
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerSessionRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  agentsOpenRef.current = agentsOpen;
  btwSelectedRecordIdRef.current = btwSelectedRecordId;
  selectedAgentRef.current = selectedAgent;
  agentNextByteRef.current = agentNextByte;

  useEffect(() => {
    selectedAgentRef.current = null;
    agentNextByteRef.current = null;
    agentTranscriptPendingRef.current = null;
    setLive(false); setLiveConnecting(false); setMuted(false); setLevels({ input: 0, output: 0 }); setDictating(false); setTranscript("");
    setCommands([]); setCommandsOpen(false); setTasksOpen(false); setOmpGoal(null); setOmpTodos([]); setTodoHistoryLoaded(false); setGoalObjective(""); setGoalTokenBudget(""); setGoalBusy(false); setBtwOpen(false); setBtwQuestion(""); setBtwFollowupRecordId(null); setBtwRecords([]);
    setTodoEdit(null); setTodoEditBusy(false);
    btwSelectedRecordIdRef.current = null; setBtwSelectedRecordId(null); btwSubmittingRef.current = false; setBtwSubmitting(false); btwHistoryRefreshRef.current = false; btwHistoryRefreshPendingRef.current = false;
    setAgentsOpen(false); setAgents([]); setSelectedAgent(null); setAgentMessages([]); setAgentNextByte(null); setSteerText("");
    if (!sessionId) return;
    let active = true;
    const unsubscribe = api.onOmpRpcEvent((event) => {
      if (event.sessionId !== sessionId) return;
      const frame = event.frame as Record<string, any>;
      applyOmpSubagentFrame(sessionId, frame);
      const taskResultAgents = ompSubagentsFromTaskFrame(frame);
      if (taskResultAgents.length) recordOmpSubagentRoster(sessionId, taskResultAgents);
      if (frame.type === "live_phase") {
        setLive(!["error"].includes(frame.phase));
        setMuted(frame.phase === "muted");
      }
      if (frame.type === "live_levels") setLevels({ input: Number(frame.input) || 0, output: Number(frame.output) || 0 });
      if (frame.type === "live_end") {
        setLive(false); setMuted(false); setLevels({ input: 0, output: 0 });
        void closeBrowserPeer(false, event.sessionId);
      }
      if (frame.type === "dictation_state") setDictating(frame.state !== "idle");
      if (frame.type === "dictation_transcript") setTranscript(String(frame.text ?? ""));
      if (frame.type === "dictation_end") {
        setDictating(false);
        const text = String(frame.text ?? "").trim();
        setTranscript("");
        if (text) useAppStore.setState({ composerPrefill: { sessionId, text, fileReferences: [], append: true } });
        if (frame.error) showToast(String(frame.error), { variant: "error" });
      }
      if (frame.type === "available_commands_update" && Array.isArray(frame.commands)) {
        setCommands(frame.commands.filter((command: any) => typeof command?.name === "string"));
      }
      if (frame.type === "session_info_update" && typeof frame.title === "string" && frame.title.trim()) {
        const state = useAppStore.getState();
        if (state.activeSessionId === sessionId) {
          const currentTitle = state.sessions.find((item) => item.id === sessionId)?.title;
          if (currentTitle !== frame.title.trim()) void state.renameSession(sessionId, frame.title.trim()).catch(() => undefined);
        }
      }
      if (frame.type === "goal_updated") setOmpGoal(frame.goal ?? null);
      if (frame.type === "todo_auto_clear") {
        // OMP owns todo policy and may clear the snapshot asynchronously. Read
        // the canonical state instead of guessing from the notification shape.
        void api.ompRpcCommand({ sessionId, command: "get_state" }).then((result: any) => {
          if (!active || useAppStore.getState().activeSessionId !== sessionId) return;
          const state = result?.data ?? {};
          setOmpGoal(state.goal?.goal ?? null);
          const phases = Array.isArray(state.todoPhases) ? state.todoPhases : [];
          setOmpTodos(phases);
          setTodoHistoryLoaded(phases.length === 0);
        }).catch(() => undefined);
      }
      if (frame.type.startsWith("subagent_")) {
        void api.ompRpcCommand({ sessionId, command: "get_subagents" }).then((result: any) => {
          const list = Array.isArray(result?.data?.subagents) ? result.data.subagents : [];
          setAgents(recordOmpSubagentRoster(sessionId, list));
          const selectedId = selectedAgentRef.current?.id;
          if (selectedId) {
            const selected = list.find((agent: any) => agent.id === selectedId) ?? null;
            selectedAgentRef.current = selected;
            setSelectedAgent(selected);
            if (selected) void refreshSelectedAgentTranscript(sessionId, selectedId, "append");
            else { agentNextByteRef.current = null; setAgentNextByte(null); setAgentMessages([]); }
          }
        }).catch(() => undefined);
      }
      if (frame.type === "process_exit") { setLive(false); setDictating(false); void closeBrowserPeer(false, event.sessionId); }
      if (frame.type === "btw_delta" || frame.type === "btw_record") {
        void refreshBtwHistory().catch(() => undefined);
      }
    });
    // Register the event listener first, then enable forwarding, then fetch the
    // canonical active+archived snapshot. This avoids the attach-time gap where
    // a fast Task batch could spawn before the renderer was listening.
    void (async () => {
      await api.ompRpcCommand({ sessionId, command: "set_subagent_subscription", fields: { level: "events" } });
      if (!active || useAppStore.getState().activeSessionId !== sessionId) return;
      const result: any = await api.ompRpcCommand({ sessionId, command: "get_subagents" });
      if (!active || useAppStore.getState().activeSessionId !== sessionId) return;
      const list = Array.isArray(result?.data?.subagents) ? result.data.subagents : [];
      setAgents(recordOmpSubagentRoster(sessionId, list.filter((agent: any) => typeof agent?.id === "string")));
    })().catch(() => undefined);
    void api.ompRpcCommand({ sessionId, command: "get_available_commands" }).then((result: any) => {
      const list = result?.data?.commands;
      if (Array.isArray(list)) setCommands(list.filter((command: any) => typeof command?.name === "string"));
    }).catch(() => undefined);
    void api.ompRpcCommand({ sessionId, command: "get_state" }).then((result: any) => {
      const state = result?.data ?? {};
      if (!active || useAppStore.getState().activeSessionId !== sessionId) return;
      setOmpGoal(state.goal?.goal ?? null);
      const phases = Array.isArray(state.todoPhases) ? state.todoPhases : [];
      setOmpTodos(phases);
      setTodoHistoryLoaded(phases.length === 0);
    }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
      if (sessionId) void api.ompRpcCommand({ sessionId, command: "set_subagent_subscription", fields: { level: "off" } }).catch(() => undefined);
      if (sessionId) void closeBrowserPeer(true, sessionId);
    };
  }, [sessionId, showToast]);

  if (!sessionId) return null;
  const run = async (command: string, fields: Record<string, unknown> = {}) => {
    try { await api.ompRpcCommand({ sessionId, command, fields }); return true; }
    catch (cause) { showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }); return false; }
  };
  const closeBrowserPeer = async (stopRemote: boolean, targetSessionId: string) => {
    if (peerSessionRef.current !== targetSessionId) return;
    const peer = peerRef.current;
    const stream = streamRef.current;
    peerRef.current = null; streamRef.current = null; peerSessionRef.current = null;
    try { peer?.close(); } catch { /* already closed */ }
    stream?.getTracks().forEach((track) => track.stop());
    if (audioRef.current) audioRef.current.srcObject = null;
    if (stopRemote) await api.ompRpcCommand({ sessionId: targetSessionId, command: "live_stop" }).catch(() => undefined);
    await api.releaseOmpMicrophone({ sessionId: targetSessionId }).catch(() => undefined);
    setLive(false); setMuted(false); setLevels({ input: 0, output: 0 });
  };
  const startBrowserLive = async () => {
    if (!sessionId || peerRef.current || liveConnecting || live || dictating) return;
    setLiveConnecting(true);
    let lease = false;
    let stream: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    try {
      await api.acquireOmpMicrophone({ sessionId });
      lease = true;
      peerSessionRef.current = sessionId;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (peerSessionRef.current !== sessionId) throw new Error("WebRTC 语音连接已取消");
      if (useAppStore.getState().activeSessionId !== sessionId) throw new Error("当前会话已切换，已取消语音连接");
      peer = new RTCPeerConnection();
      peerSessionRef.current = sessionId;
      peerRef.current = peer;
      streamRef.current = stream;
      peer.createDataChannel("oai-events");
      peer.ontrack = (event) => {
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void audioRef.current.play().catch(() => undefined);
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer?.connectionState === "failed" || peer?.connectionState === "closed") void closeBrowserPeer(true, sessionId);
      };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== "complete") {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WebRTC ICE gathering timed out")), 12_000);
          const check = () => {
            if (peer?.iceGatheringState === "complete") { clearTimeout(timeout); peer.removeEventListener("icegatheringstatechange", check); resolve(); }
          };
          peer?.addEventListener("icegatheringstatechange", check);
        });
      }
      const response: any = await api.ompRpcCommand({ sessionId, command: "live_connect", fields: { sdpOffer: peer.localDescription?.sdp ?? "" } });
      const sdpAnswer = response?.data?.sdpAnswer;
      if (typeof sdpAnswer !== "string" || !sdpAnswer) throw new Error("OMP did not return a WebRTC answer");
      await peer.setRemoteDescription({ type: "answer", sdp: sdpAnswer });
      setLive(true); setMuted(false);
    } catch (cause) {
      peer?.close(); stream?.getTracks().forEach((track) => track.stop());
      if (peerRef.current === peer) { peerRef.current = null; streamRef.current = null; peerSessionRef.current = null; }
      if (lease) await api.releaseOmpMicrophone({ sessionId }).catch(() => undefined);
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    } finally {
      setLiveConnecting(false);
    }
  };
  const toggleLive = async () => {
    if (liveConnecting) {
      if (peerSessionRef.current === sessionId) await closeBrowserPeer(true, sessionId!);
      else { setLiveConnecting(false); await run("live_stop"); }
      return;
    }
    if (dictating) return;
    if (live) {
      if (peerRef.current) { await closeBrowserPeer(true, sessionId!); return; }
      if (await run("live_stop")) { setLive(false); setMuted(false); }
      return;
    }
    setLiveConnecting(true);
    try { if (await run("live_start")) setLive(true); }
    finally { setLiveConnecting(false); }
  };
  const toggleMute = async () => {
    const next = !muted;
    if (await run("live_mute", { muted: next })) {
      streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
      setMuted(next);
    }
  };
  const toggleDictation = async () => {
    if (live || liveConnecting) return;
    if (dictating) { await run("dictation_stop"); return; }
    setTranscript("");
    if (await run("dictation_start", { captureId: crypto.randomUUID() })) setDictating(true);
  };
  const chooseCommand = (command: { name: string }) => {
    const currentSessionId = useAppStore.getState().activeSessionId;
    if (currentSessionId !== sessionId) return;
    useAppStore.setState({ composerPrefill: { sessionId, text: `/${command.name} `, fileReferences: [], append: true } });
    setCommandsOpen(false);
  };
  const refreshNativeTasks = async (includeTodoHistory = true) => {
    const targetSessionId = sessionId;
    if (!targetSessionId) return;
    const result: any = await api.ompRpcCommand({ sessionId: targetSessionId, command: "get_state" });
    if (useAppStore.getState().activeSessionId !== targetSessionId) return;
    const phases = Array.isArray(result?.data?.todoPhases) ? result.data.todoPhases : [];
    let todos = phases;
    if (includeTodoHistory && phases.length) {
      const treeResult: any = await api.ompRpcCommand({ sessionId: targetSessionId, command: "get_tree" });
      if (useAppStore.getState().activeSessionId !== targetSessionId) return;
      const merged = mergeOmpTodoMetadata(phases, treeResult?.data?.tree, treeResult?.data?.leafId);
      if (!merged) {
        setTodoHistoryLoaded(false);
        throw new Error(t("settings.omp.nativeTodosHistoryUnavailable"));
      }
      todos = merged;
      setTodoHistoryLoaded(true);
    } else setTodoHistoryLoaded(phases.length === 0);
    setOmpGoal(result?.data?.goal?.goal ?? null);
    setOmpTodos(todos);
  };
  const todoEditable = todoHistoryLoaded && normalizeEditableOmpTodos(ompTodos) !== null;
  const saveTodoEdit = async () => {
    if (!todoEdit || todoEditBusy || !todoEditable) return;
    setTodoEditBusy(true);
    try {
      const phases = updateEditableOmpTodoTask(ompTodos, todoEdit.phaseIndex, todoEdit.taskIndex, {
        content: todoEdit.content,
        status: todoEdit.status,
        details: todoEdit.details,
        notes: todoEdit.notes,
      });
      const result: any = await api.ompRpcCommand({ sessionId, command: "set_todos", fields: { phases } });
      const saved = result?.data?.todoPhases;
      if (!sameOmpTodoCore(phases, saved)) {
        await refreshNativeTasks(true);
        throw new Error(t("settings.omp.nativeTodosSaveMismatch"));
      }
      const treeResult: any = await api.ompRpcCommand({ sessionId, command: "get_tree" });
      if (!hasOmpTodoSnapshot(treeResult?.data?.tree, treeResult?.data?.leafId, phases)) {
        await refreshNativeTasks(true);
        throw new Error(t("settings.omp.nativeTodosPersistenceUnverified"));
      }
      if (useAppStore.getState().activeSessionId !== sessionId) return;
      const merged = mergeOmpTodoMetadata(saved, treeResult?.data?.tree, treeResult?.data?.leafId);
      if (!merged) throw new Error(t("settings.omp.nativeTodosPersistenceUnverified"));
      setOmpTodos(merged);
      setTodoHistoryLoaded(true);
      setTodoEdit(null);
      showToast(t("settings.omp.nativeTodosSaved"), { variant: "success" });
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
        await refreshNativeTasks(true).catch(() => undefined);
    } finally {
      setTodoEditBusy(false);
    }
  };

  const runGoalOperation = async (op: "create" | "resume" | "pause" | "drop") => {
    if (goalBusy || !sessionId) return;
    setGoalBusy(true);
    try {
      const objective = goalObjective.trim();
      const tokenBudget = Number(goalTokenBudget);
      if (op === "create" && !objective) return;
      if (op === "create" && goalTokenBudget && (!Number.isInteger(tokenBudget) || tokenBudget < 1)) throw new Error(t("settings.omp.goalBudgetInvalid"));
      const result: any = await api.ompRpcCommand({ sessionId, command: "goal", fields: {
        op,
        ...(op === "create" ? { objective, ...(goalTokenBudget ? { token_budget: tokenBudget } : {}) } : {}),
      } });
      setOmpGoal(result?.data?.goal ?? null);
      setGoalObjective("");
      await refreshNativeTasks(true);
    } catch (cause) { showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }); }
    finally { setGoalBusy(false); }
  };
  const refreshBtwHistory = async () => {
    if (btwHistoryRefreshRef.current) { btwHistoryRefreshPendingRef.current = true; return; }
    btwHistoryRefreshRef.current = true;
    try {
      const result: any = await api.ompRpcCommand({ sessionId: sessionId!, command: "get_btw_history" });
      const records = Array.isArray(result?.data?.records) ? result.data.records : [];
      setBtwRecords(records);
      const currentId = btwSelectedRecordIdRef.current;
      const nextId = currentId && records.some((record: any) => record.id === currentId) ? currentId : records[0]?.id ?? null;
      btwSelectedRecordIdRef.current = nextId;
      setBtwSelectedRecordId(nextId);
    } finally {
      btwHistoryRefreshRef.current = false;
      if (btwHistoryRefreshPendingRef.current) {
        btwHistoryRefreshPendingRef.current = false;
        void refreshBtwHistory().catch(() => undefined);
      }
    }
  };
  const openBtw = async () => {
    const next = !btwOpen;
    setBtwOpen(next);
    if (!next) return;
    try { await refreshBtwHistory(); }
    catch (cause) { showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }); }
  };
  const askBtw = async () => {
    const question = btwQuestion.trim();
    if (!question || btwSubmittingRef.current || btwRecords.some((record) => record.status === "running")) return;
    btwSubmittingRef.current = true;
    setBtwSubmitting(true);
    try {
      const response: any = await api.ompRpcCommand({ sessionId, command: "btw", fields: { question, ...(btwFollowupRecordId ? { recordId: btwFollowupRecordId } : {}) } });
      setBtwQuestion("");
      const responseRecordId = typeof response?.data?.record?.id === "string" ? response.data.record.id : btwFollowupRecordId;
      setBtwFollowupRecordId(null);
      const result: any = await api.ompRpcCommand({ sessionId, command: "get_btw_history" });
      const records = Array.isArray(result?.data?.records) ? result.data.records : [];
      setBtwRecords(records);
      const nextId = responseRecordId && records.some((record: any) => record.id === responseRecordId) ? responseRecordId : records[0]?.id ?? null;
      btwSelectedRecordIdRef.current = nextId;
      setBtwSelectedRecordId(nextId);
    } catch (cause) { showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }); }
    finally { btwSubmittingRef.current = false; setBtwSubmitting(false); }
  };
  const selectBtwRecord = (record: Record<string, any>) => {
    const id = String(record.id);
    btwSelectedRecordIdRef.current = id;
    setBtwSelectedRecordId(id);
  };
  const followUpBtwRecord = (record: Record<string, any>) => {
    const id = String(record.id);
    selectBtwRecord(record);
    setBtwFollowupRecordId(id);
  };
  const cancelBtwRecord = async (record: Record<string, any>) => {
    try {
      await api.ompRpcCommand({ sessionId, command: "btw_cancel", fields: { recordId: record.id } });
      const result: any = await api.ompRpcCommand({ sessionId, command: "get_btw_history" });
      setBtwRecords(Array.isArray(result?.data?.records) ? result.data.records : []);
    } catch (cause) { showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }); }
  };
  const refreshAgents = async () => {
    try {
      const result: any = await api.ompRpcCommand({ sessionId, command: "get_subagents" });
      const list = Array.isArray(result?.data?.subagents) ? result.data.subagents : [];
      setAgents(recordOmpSubagentRoster(sessionId!, list));
      const selectedId = selectedAgentRef.current?.id;
      if (selectedId) {
        const selected = list.find((agent: any) => agent.id === selectedId) ?? null;
        selectedAgentRef.current = selected;
        setSelectedAgent(selected);
        if (!selected) { agentNextByteRef.current = null; setAgentNextByte(null); setAgentMessages([]); }
      }
    } catch (cause) { showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }); }
  };
  const refreshSelectedAgentTranscript = async (targetSessionId: string, agentId: string, mode: "replace" | "append") => {
    if (agentTranscriptReadRef.current) {
      const current = agentTranscriptPendingRef.current;
      agentTranscriptPendingRef.current = current?.sessionId === targetSessionId && current.agentId === agentId
        ? { ...current, mode: current.mode === "replace" || mode === "replace" ? "replace" : "append" }
        : { sessionId: targetSessionId, agentId, mode };
      return;
    }
    agentTranscriptReadRef.current = true;
    try {
      const fromByte = mode === "replace" ? 0 : agentNextByteRef.current ?? 0;
      const result: any = await api.ompRpcCommand({ sessionId: targetSessionId, command: "get_subagent_messages", fields: { subagentId: agentId, fromByte } });
      const data = result?.data;
      if (selectedAgentRef.current?.id !== agentId || useAppStore.getState().activeSessionId !== targetSessionId) return;
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      setAgentMessages((current) => data?.reset || mode === "replace" ? messages : [...current, ...messages]);
      const nextByte = typeof data?.nextByte === "number" ? data.nextByte : null;
      agentNextByteRef.current = nextByte;
      setAgentNextByte(nextByte);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    } finally {
      agentTranscriptReadRef.current = false;
      const pending = agentTranscriptPendingRef.current;
      agentTranscriptPendingRef.current = null;
      if (pending && useAppStore.getState().activeSessionId === pending.sessionId && selectedAgentRef.current?.id === pending.agentId) {
        void refreshSelectedAgentTranscript(pending.sessionId, pending.agentId, pending.mode);
      }
    }
  };
  const selectAgent = async (agent: Record<string, any>) => {
    selectedAgentRef.current = agent;
    setSelectedAgent(agent);
    agentNextByteRef.current = 0;
    setAgentMessages([]);
    setAgentNextByte(null);
    await refreshSelectedAgentTranscript(sessionId!, String(agent.id), "replace");
  };
  const loadMoreAgentMessages = async () => {
    const selected = selectedAgentRef.current;
    if (!selected || agentNextByteRef.current === null) return;
    await refreshSelectedAgentTranscript(sessionId!, String(selected.id), "append");
  };
  const runAgentCommand = async (command: string, fields: Record<string, unknown>) => {
    try { await api.ompRpcCommand({ sessionId, command, fields }); await refreshAgents(); }
    catch (cause) { showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }); }
  };
  const toggleAgentsPanel = async () => {
    const next = !agentsOpenRef.current;
    agentsOpenRef.current = next;
    setAgentsOpen(next);
    if (next) await refreshAgents();
  };
  const selectedBtwRecord = btwRecords.find((record) => String(record.id) === btwSelectedRecordId) ?? btwRecords[0] ?? null;
  const btwHasRunningRecord = btwRecords.some((record) => record.status === "running");
  const btwStatusLabel = (status: unknown) => {
    switch (status) {
      case "running": return t("settings.omp.btwStatusRunning");
      case "complete": return t("settings.omp.btwStatusComplete");
      case "cancelled": return t("settings.omp.btwStatusCancelled");
      case "error": return t("settings.omp.btwStatusError");
      case "interrupted": return t("settings.omp.btwStatusInterrupted");
      default: return String(status ?? "");
    }
  };
  const nativeGoalStatusLabel = (status: unknown) => {
    switch (status) {
      case "active": return t("settings.omp.goalStatusActive");
      case "paused": return t("settings.omp.goalStatusPaused");
      case "budget-limited": return t("settings.omp.goalStatusBudgetLimited");
      case "complete": return t("settings.omp.goalStatusComplete");
      case "dropped": return t("settings.omp.goalStatusDropped");
      default: return String(status ?? "");
    }
  };

  return <div className="omp-native-controls" aria-label={t("settings.omp.nativeVoiceControls")}>
    <OmpSessionControls sessionId={sessionId} t={t} />
    <audio ref={audioRef} autoPlay className="sr-only" />
    <TooltipButton type="button" className={`icon-btn icon-btn-square${live || liveConnecting ? " is-active" : ""}`} disabled={dictating} tooltip={liveConnecting ? t("settings.omp.cancelLiveVoice") : live ? t("settings.omp.stopLiveVoice") : t("settings.omp.startLiveVoice")} ariaLabel={liveConnecting ? t("settings.omp.cancelLiveVoice") : live ? t("settings.omp.stopLiveVoice") : t("settings.omp.startLiveVoice")} onClick={toggleLive}>
      {live && muted ? <IconMicOff size={15} aria-hidden="true" /> : <IconMic size={15} aria-hidden="true" />}
    </TooltipButton>
    {!live && !liveConnecting ? <TooltipButton type="button" className="icon-btn icon-btn-square" disabled={dictating} tooltip={t("settings.omp.startLiveVoiceWebRtc")} ariaLabel={t("settings.omp.startLiveVoiceWebRtc")} onClick={() => void startBrowserLive()}><IconVolume size={15} aria-hidden="true" /></TooltipButton> : null}
    {live ? <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={muted ? t("settings.omp.unmuteLiveVoice") : t("settings.omp.muteLiveVoice")} ariaLabel={muted ? t("settings.omp.unmuteLiveVoice") : t("settings.omp.muteLiveVoice")} onClick={toggleMute}><IconMicOff size={15} aria-hidden="true" /></TooltipButton> : null}
    {live && !peerRef.current ? <div className="omp-live-levels" aria-label={t("settings.omp.liveAudioLevels")}><meter min="0" max="1" value={levels.input} aria-label={t("settings.omp.liveInputLevel")} /><meter min="0" max="1" value={levels.output} aria-label={t("settings.omp.liveOutputLevel")} /></div> : null}
    <TooltipButton type="button" className={`icon-btn icon-btn-square${dictating ? " is-active" : ""}`} disabled={live || liveConnecting} tooltip={dictating ? t("settings.omp.stopDictation") : t("settings.omp.startDictation")} ariaLabel={dictating ? t("settings.omp.stopDictation") : t("settings.omp.startDictation")} onClick={toggleDictation}><IconMic size={15} aria-hidden="true" /></TooltipButton>
    <div className="omp-native-command-picker">
      <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("settings.omp.nativeCommands")} ariaLabel={t("settings.omp.nativeCommands")} aria-expanded={commandsOpen} onClick={() => setCommandsOpen((open) => !open)}><IconTerminal size={15} aria-hidden="true" /></TooltipButton>
      {commandsOpen ? <div className="omp-native-command-menu" role="menu" aria-label={t("settings.omp.nativeCommands")}>
        {commands.length ? commands.map((command) => <button key={command.name} type="button" role="menuitem" onClick={() => chooseCommand(command)}><code>/{command.name}</code>{command.description ? <small>{command.description}</small> : null}</button>) : <span role="status">{t("settings.omp.noNativeCommands")}</span>}
      </div> : null}
    </div>
    <div className="omp-native-command-picker">
      <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("settings.omp.nativeTasks")} ariaLabel={t("settings.omp.nativeTasks")} aria-expanded={tasksOpen} onClick={() => { const next = !tasksOpen; setTasksOpen(next); if (next) void refreshNativeTasks(true).catch((cause) => showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" })); }}><IconListChecks size={15} aria-hidden="true" /></TooltipButton>
      {tasksOpen ? <section className="omp-native-tasks-panel" aria-label={t("settings.omp.nativeTasks")}>
        <header><strong>{t("settings.omp.nativeTasks")}</strong><button type="button" onClick={() => void refreshNativeTasks(true).catch((cause) => showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }))}>{t("common.refresh")}</button></header>
        <section className="omp-native-goal-card"><strong>{t("settings.omp.nativeGoal")}</strong>
          {ompGoal ? <>
            <p>{String(ompGoal.objective ?? "")}</p>
            <div className="omp-native-goal-meta"><span>{nativeGoalStatusLabel(ompGoal.status)}</span><span>{t("settings.omp.goalUsage", { tokens: Number(ompGoal.tokensUsed) || 0, seconds: Math.floor(Number(ompGoal.timeUsedSeconds) || 0) })}</span></div>
            {Number(ompGoal.tokenBudget) > 0 ? <div className="omp-native-goal-budget"><progress max={100} value={Math.min(100, Math.round((Number(ompGoal.tokensUsed) / Number(ompGoal.tokenBudget)) * 100))} /><small>{Number(ompGoal.tokensUsed) || 0} / {Number(ompGoal.tokenBudget)} {t("settings.omp.tokens")}</small></div> : null}
            <div className="omp-native-goal-actions">{ompGoal.status === "active" ? <button type="button" disabled={goalBusy} onClick={() => void runGoalOperation("pause")}>{t("settings.omp.pauseNativeGoal")}</button> : ompGoal.status === "paused" ? <button type="button" disabled={goalBusy} onClick={() => void runGoalOperation("resume")}>{t("settings.omp.resumeNativeGoal")}</button> : null}<button type="button" disabled={goalBusy} onClick={() => void runGoalOperation("drop")}>{t("settings.omp.dropNativeGoal")}</button></div>
          </> : <>
            <input value={goalObjective} onChange={(event) => setGoalObjective(event.target.value)} placeholder={t("settings.omp.nativeGoalPlaceholder")} />
            <input type="number" min="1" step="1" value={goalTokenBudget} onChange={(event) => setGoalTokenBudget(event.target.value)} placeholder={t("settings.omp.goalTokenBudgetOptional")} />
            <button type="button" disabled={goalBusy || !goalObjective.trim()} onClick={() => void runGoalOperation("create")}>{t("settings.omp.createNativeGoal")}</button>
          </>}
        </section>
        <section className="omp-native-todo-card"><header><strong>{t("settings.omp.nativeTodos")}</strong></header>
          {ompTodos.length ? ompTodos.map((phase, phaseIndex) => <div className="omp-native-todo-phase" key={String(phase.name) + phaseIndex}><b>{String(phase.name ?? "")}</b>{(Array.isArray(phase.tasks) ? phase.tasks : []).map((task: any, taskIndex: number) => {
            const activeTodoEdit = todoEdit?.phaseIndex === phaseIndex && todoEdit.taskIndex === taskIndex ? todoEdit : null;
            return activeTodoEdit ? <div className="omp-native-todo-edit-row" key={phaseIndex + "-" + taskIndex}>
              <input aria-label={t("settings.omp.todoTaskContent")} value={activeTodoEdit.content} onChange={(event) => setTodoEdit({ ...activeTodoEdit, content: event.target.value })} />
              <select aria-label={t("settings.omp.todoTaskStatus")} value={activeTodoEdit.status} onChange={(event) => setTodoEdit({ ...activeTodoEdit, status: event.target.value })}>
                <option value="pending">{t("settings.omp.todoStatusPending")}</option>
                <option value="in_progress">{t("settings.omp.todoStatusInProgress")}</option>
                <option value="completed">{t("settings.omp.todoStatusCompleted")}</option>
                <option value="abandoned">{t("settings.omp.todoStatusAbandoned")}</option>
              </select>
              <Textarea aria-label={t("settings.omp.todoTaskDetails")} rows={2} value={activeTodoEdit.details} placeholder={t("settings.omp.todoTaskDetails")} onChange={(event) => setTodoEdit({ ...activeTodoEdit, details: event.target.value })} />
              <Textarea aria-label={t("settings.omp.todoTaskNotes")} rows={2} value={activeTodoEdit.notes} placeholder={t("settings.omp.todoTaskNotes")} onChange={(event) => setTodoEdit({ ...activeTodoEdit, notes: event.target.value })} />
              <button type="button" disabled={todoEditBusy || !activeTodoEdit.content.trim()} onClick={() => void saveTodoEdit()}>{todoEditBusy ? t("common.loading") : t("common.save")}</button>
              <button type="button" disabled={todoEditBusy} onClick={() => setTodoEdit(null)}>{t("common.cancel")}</button>
            </div> : <div className="omp-native-todo-row" key={phaseIndex + "-" + taskIndex}>
              <div className="omp-native-todo-copy">
                <p data-status={String(task.status ?? "")}><span aria-hidden="true">{task.status === "completed" ? "✓" : task.status === "in_progress" ? "◉" : task.status === "abandoned" ? "–" : "○"}</span>{String(task.content ?? "")}</p>
                {typeof task.details === "string" && task.details.trim() ? <small className="omp-native-todo-details">{task.details}</small> : null}
                {Array.isArray(task.notes) && task.notes.length ? <ul className="omp-native-todo-notes">{task.notes.filter((note: unknown): note is string => typeof note === "string").map((note: string, noteIndex: number) => <li key={`${noteIndex}:${note}`}>{note}</li>)}</ul> : null}
              </div>
              {todoEditable ? <button type="button" disabled={todoEditBusy} onClick={() => setTodoEdit({ phaseIndex, taskIndex, content: String(task.content ?? ""), status: String(task.status ?? "pending"), details: typeof task.details === "string" ? task.details : "", notes: Array.isArray(task.notes) ? task.notes.filter((note: unknown): note is string => typeof note === "string").join("\n") : "" })}>{t("common.edit")}</button> : null}
            </div>;
          })}</div>) : <span>{t("settings.omp.noNativeTodos")}</span>}
          {ompTodos.length && !todoEditable ? <small>{t(todoHistoryLoaded ? "settings.omp.nativeTodosEditUnsafe" : "settings.omp.nativeTodosHistoryUnavailable")}</small> : null}
        </section>
      </section> : null}
    </div>
    <div className="omp-native-command-picker">
      <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("settings.omp.sideQuestions")} ariaLabel={t("settings.omp.sideQuestions")} aria-expanded={btwOpen} onClick={() => void openBtw()}><IconChat size={15} aria-hidden="true" /></TooltipButton>
      {btwOpen ? <section className="omp-native-btw-panel" aria-label={t("settings.omp.sideQuestions")}>
        <header><strong>{t("settings.omp.sideQuestions")}</strong><button type="button" onClick={() => void refreshBtwHistory().catch((cause) => showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }))} aria-label={t("common.refresh")}>{t("common.refresh")}</button></header>
        <div className="omp-native-btw-list" role="list" aria-label={t("settings.omp.sideQuestions")}>
          {btwRecords.length ? btwRecords.map((record) => <div className="omp-native-btw-list-row" role="listitem" key={String(record.id)}>
            <button type="button" className={String(record.id) === String(selectedBtwRecord?.id) ? "is-selected" : ""} onClick={() => selectBtwRecord(record)}>
              <strong>{String(record.question ?? "")}</strong><small data-status={String(record.status ?? "")}>{btwStatusLabel(record.status)}</small>
            </button>
            {record.status === "running" ? <button type="button" className="omp-native-btw-cancel" onClick={() => void cancelBtwRecord(record)}>{t("settings.omp.cancelQuestion")}</button> : null}
          </div>) : <span role="status">{t("settings.omp.noSideQuestions", { defaultValue: t("settings.omp.askSideQuestion") })}</span>}
        </div>
        {selectedBtwRecord ? <article className="omp-native-btw-detail">
          <div className="omp-native-btw-detail-meta"><span>{Number(selectedBtwRecord.updatedAt ?? selectedBtwRecord.createdAt) > 0 ? new Date(Number(selectedBtwRecord.updatedAt ?? selectedBtwRecord.createdAt)).toLocaleString() : ""}</span><span data-status={String(selectedBtwRecord.status ?? "")}>{btwStatusLabel(selectedBtwRecord.status)}</span></div>
          <strong>{String(selectedBtwRecord.question ?? "")}</strong>
          <p>{String(selectedBtwRecord.answer ?? "")}</p>
          {selectedBtwRecord.error ? <p className="omp-native-btw-error">{String(selectedBtwRecord.error)}</p> : null}
          {Array.isArray(selectedBtwRecord.followUps) ? selectedBtwRecord.followUps.map((followup: any, turnIndex: number) => <div className="omp-native-btw-followup" key={`${selectedBtwRecord.id}-${turnIndex}`}><b>{String(followup.question ?? "")}</b><p>{String(followup.answer ?? "")}</p>{followup.error ? <small className="omp-native-btw-error">{String(followup.error)}</small> : null}<small data-status={String(followup.status ?? "")}>{btwStatusLabel(followup.status)}</small></div>) : null}
          <div className="omp-native-btw-actions"><button type="button" disabled={btwHasRunningRecord} onClick={() => followUpBtwRecord(selectedBtwRecord)}>{t("settings.omp.followUpQuestion")}</button>{selectedBtwRecord.status === "running" ? <button type="button" onClick={() => void cancelBtwRecord(selectedBtwRecord)}>{t("settings.omp.cancelQuestion")}</button> : null}</div>
        </article> : null}
        <div className="omp-native-agent-actions"><input value={btwQuestion} onChange={(event) => setBtwQuestion(event.target.value)} placeholder={btwFollowupRecordId ? t("settings.omp.followUpQuestion") : t("settings.omp.askSideQuestion")} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void askBtw(); } }} /><button type="button" disabled={!btwQuestion.trim() || btwSubmitting || btwHasRunningRecord} onClick={() => void askBtw()}>{t("settings.omp.ask")}</button></div>
      </section> : null}
    </div>
    <div className="omp-native-command-picker">
      <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("settings.omp.subagentManager")} ariaLabel={t("settings.omp.subagentManager")} aria-expanded={agentsOpen} onClick={() => void toggleAgentsPanel()}><IconBot size={15} aria-hidden="true" /></TooltipButton>
      {agentsOpen ? <section className="omp-native-agent-panel" aria-label={t("settings.omp.subagentManager")}>
        <header><strong>{t("settings.omp.subagentManager")}</strong><button type="button" onClick={() => void refreshAgents()}>{t("common.refresh")}</button></header>
        <div className="omp-native-agent-list">{agents.length ? agents.map((agent) => <button type="button" key={agent.id} className={selectedAgent?.id === agent.id ? "is-selected" : ""} onClick={() => void selectAgent(agent)}><strong>{agent.description || agent.task || agent.agent || agent.id}</strong><small>{agent.status}{typeof agent.progress?.message === "string" ? ` · ${agent.progress.message}` : ""}</small></button>) : <span>{t("settings.omp.noSubagents")}</span>}</div>
        {selectedAgent ? <><div className="omp-native-agent-transcript">{agentMessages.map((message, index) => <OmpSubagentMessage key={String(message.id ?? index)} message={message} t={t} />)}</div>
          {agentNextByte !== null ? <button type="button" className="omp-native-agent-load-more" onClick={() => void loadMoreAgentMessages()}>{t("common.refresh")}</button> : null}
          {selectedAgent.status === "running" ? <div className="omp-native-agent-actions"><input value={steerText} onChange={(event) => setSteerText(event.target.value)} placeholder={t("settings.omp.steerSubagentPlaceholder")} onKeyDown={(event) => { if (event.key === "Enter" && steerText.trim()) void runAgentCommand("steer_subagent", { subagentId: selectedAgent.id, message: steerText.trim() }).then(() => setSteerText("")); }} /><button type="button" onClick={() => void runAgentCommand("cancel_subagent", { subagentId: selectedAgent.id })}>{t("settings.omp.cancelSubagent")}</button></div> : null}</> : null}
      </section> : null}
    </div>
    {transcript ? <span className="omp-dictation-preview" title={transcript}>{transcript}</span> : null}
  </div>;
}
