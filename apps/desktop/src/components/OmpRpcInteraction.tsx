import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { createOmpRiskAcknowledgementCancellationResponse, createOmpRiskAcknowledgementResponse, isAuthorizationCodePrompt, isOmpPreAuthRiskAcknowledgementPrompt } from "../lib/omp-rpc-prompts.mjs";
import { useAppStore } from "../stores/app-store";
import { normalizeOmpEditorText, ompExtensionRequestNeedsResponse, ompSelectOptionKind, updateOmpStatusMap, updateOmpWidgetMap } from "./omp-extension-state.mjs";
import { IconX } from "./icons";
import { Button, Checkbox, Input, Panel, Textarea } from "./ui";

type RpcRequest = Record<string, any> & {
  id?: string;
  method?: string;
  options?: string[];
  selectionMarker?: "radio" | "checkbox";
  markableCount?: number;
};
type OmpAuthLink = { url: string; instructions?: string };

function targetHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return new URL(value).host || null; } catch { return null; }
}

type OmpRpcInteractionContext = "chat" | "provider-management";

type OmpRetryFallback = { from: string; to: string; reason: string };

function boundedOmpText(value: unknown, limit = 240): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function ompModelSelectorLabel(value: unknown): string {
  if (typeof value === "string") return boundedOmpText(value, 120);
  if (!value || typeof value !== "object") return "";
  const model = value as Record<string, unknown>;
  const provider = boundedOmpText(model.provider, 60);
  const id = boundedOmpText(model.modelId ?? model.id ?? model.model, 80);
  if (provider && id) return `${provider}/${id}`;
  return id || boundedOmpText(model.name ?? model.label, 120);
}

function ompFallbackReason(value: unknown): string {
  if (typeof value === "string") return boundedOmpText(value, 240);
  if (!value || typeof value !== "object") return "";
  const reason = value as Record<string, unknown>;
  return boundedOmpText(reason.message ?? reason.reason ?? reason.code, 240);
}

function ompConfigWarningSummary(frame: Record<string, any>, t: (key: string) => string): string {
  const values = Array.isArray(frame.warnings) ? frame.warnings : Array.isArray(frame.configWarnings) ? frame.configWarnings : [];
  const messages = values.map((value: unknown) => {
    if (typeof value === "string") return boundedOmpText(value, 160);
    if (!value || typeof value !== "object") return "";
    const warning = value as Record<string, unknown>;
    return boundedOmpText(warning.message ?? warning.warning ?? warning.description ?? warning.code, 160);
  }).filter(Boolean);
  if (!messages.length) return t("settings.omp.configWarningsChanged");
  return `${t("settings.omp.configWarningsChanged")} · ${boundedOmpText(messages.join(" · "), 360)}`;
}

export function OmpRpcInteraction({ sessionId, onPendingChange, resetSignal = 0, context = "chat" }: { sessionId: string | null; onPendingChange?: (pending: boolean) => void; resetSignal?: number; context?: OmpRpcInteractionContext }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  // Requests are queued instead of overwritten: two providers signing in at the
  // same time must not swallow each other's prompt (which looked unclosable).
  const [queue, setQueue] = useState<RpcRequest[]>([]);
  const request = queue[0] ?? null;
  const [authLink, setAuthLink] = useState<OmpAuthLink | null>(null);
  const [value, setValue] = useState("");
  const [answers, setAnswers] = useState<Record<string, { selectedOptions: string[]; customInput: string }>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [nativeTitle, setNativeTitle] = useState("");
  const [widgets, setWidgets] = useState<Record<string, { key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>>({});
  const [editorText, setEditorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const authorizationUrlSeen = useRef(false);
  const retryFallback = useRef<OmpRetryFallback | null>(null);
  const clearRequests = () => setQueue([]);
  const dropRequest = (id?: string) => setQueue((current) => (id ? current.filter((item) => item.id !== id) : current.slice(1)));

  useEffect(() => {
    onPendingChange?.(queue.length > 0);
  }, [onPendingChange, queue.length]);

  // The login command can finish on its own (browser callback) while the engine
  // still has an unanswered code prompt. Its session is stopped right after the
  // command returns, so the prompt must be discarded instead of lingering.
  useEffect(() => {
    if (resetSignal <= 0) return;
    authorizationUrlSeen.current = false;
    clearRequests();
    setAuthLink(null);
    setValue("");
    setAnswers({});
  }, [resetSignal]);

  // Reset the input state whenever the visible prompt changes, and give the
  // dialog focus so Escape is handled even if the click came from the page.
  useEffect(() => {
    setValue(typeof request?.prefill === "string" ? request.prefill : "");
    setAnswers({});
    if (!request) return;
    const focusTimer = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".omp-rpc-dialog input, .omp-rpc-dialog select, .omp-rpc-dialog textarea, .omp-rpc-dialog button")?.focus();
    });
    return () => cancelAnimationFrame(focusTimer);
  }, [request?.id]);

  useEffect(() => {
    authorizationUrlSeen.current = false;
    clearRequests();
    setAuthLink(null);
    setValue("");
    setAnswers({});
    setStatuses({});
    setNativeTitle("");
    setWidgets({});
    setEditorText(null);
    setBusy(false);
    retryFallback.current = null;
    if (!sessionId) return;
    return api.onOmpRpcEvent((event) => {
      if (event.sessionId !== sessionId) return;
      const frame = event.frame;
      if (frame.type === "config_warnings_changed") {
        setStatuses((current) => updateOmpStatusMap(current, "config-warnings", ompConfigWarningSummary(frame, t)));
      }
      if (frame.type === "advisor_cost_changed") {
        setStatuses((current) => updateOmpStatusMap(current, "advisor-cost", t("settings.omp.advisorCostChanged")));
      }
      if (frame.type === "advisor_yielded") {
        setStatuses((current) => updateOmpStatusMap(current, "advisor", t("settings.omp.advisorYielded")));
      }
      if (frame.type === "extension_ui_request") {
        const method = frame.method;
        if (method === "notify") {
          showToast(String(frame.message ?? ""), { variant: frame.notifyType === "error" ? "error" : frame.notifyType === "warning" ? "warning" : "info" });
          return;
        }
        if (method === "setStatus") {
          setStatuses((current) => updateOmpStatusMap(current, frame.statusKey, frame.statusText));
          return;
        }
        if (method === "cancel") {
          dropRequest(typeof frame.targetId === "string" ? frame.targetId : undefined);
          return;
        }
        if (method === "set_editor_text") {
          const safeText = normalizeOmpEditorText(frame.text);
          if (safeText) setEditorText(safeText);
          else showToast(t("settings.omp.extensionEditorTextUnavailable"), { variant: "warning" });
          return;
        }
        if (method === "setWidget") {
          setWidgets((current) => updateOmpWidgetMap(current, frame.widgetKey, frame.widgetLines, frame.widgetPlacement));
          return;
        }
        if (method === "setTitle") {
          setNativeTitle(typeof frame.title === "string" ? frame.title.slice(0, 240) : "");
          return;
        }
        if (method === "open_url") {
          authorizationUrlSeen.current = true;
          const url = typeof frame.launchUrl === "string" ? frame.launchUrl : frame.url;
          if (typeof url === "string") setAuthLink({ url, instructions: typeof frame.instructions === "string" ? frame.instructions : undefined });
        }
        if (["select", "confirm", "input", "editor", "ask", "open_url"].includes(String(method))) {
          setQueue((current) => (frame.id && current.some((item) => item.id === frame.id) ? current : [...current, frame as RpcRequest]));
        }
      }
      if (frame.type === "auth_url" && typeof (frame.url ?? frame.launchUrl) === "string") {
        authorizationUrlSeen.current = true;
        setAuthLink({
          url: String(frame.url ?? frame.launchUrl),
          instructions: typeof frame.instructions === "string" ? frame.instructions : undefined,
        });
        setStatuses((current) => updateOmpStatusMap(current, "auth", t("settings.omp.waitingForBrowserAuth")));
      }
      if (frame.type === "auth_progress" && typeof frame.message === "string") setStatuses((current) => updateOmpStatusMap(current, "auth", String(frame.message)));
      if (frame.type === "subagent_progress" || frame.type === "subagent_lifecycle") {
        const detail = (frame.payload as any)?.progress ?? frame.payload as any;
        const title = typeof detail?.description === "string" ? detail.description : typeof detail?.task === "string" ? detail.task : "";
        const state = typeof detail?.status === "string" ? detail.status : "working";
        if (title) setStatuses((current) => updateOmpStatusMap(current, "subagents", `OMP · ${state} · ${title}`));
      }
      if (frame.type === "live_phase") setStatuses((current) => updateOmpStatusMap(current, "live", t("settings.omp.livePhase", { phase: String(frame.phase ?? "") })));
      if (frame.type === "live_transcript") setStatuses((current) => updateOmpStatusMap(current, "live-transcript", `${frame.role === "user" ? "You" : "OMP"}: ${String(frame.text ?? "")}`));
      if (frame.type === "live_end") setStatuses((current) => updateOmpStatusMap(current, "live", frame.error ? String(frame.error) : undefined));
      if (frame.type === "auto_compaction_start" || frame.type === "manual_compaction_start") setStatuses((current) => updateOmpStatusMap(current, "compaction", t("chat.compactingContext")));
      if (frame.type === "auto_compaction_end" || frame.type === "manual_compaction_end") {
        const errorMessage = typeof frame.errorMessage === "string" ? frame.errorMessage : "";
        setStatuses((current) => updateOmpStatusMap(current, "compaction", undefined));
        if (errorMessage) showToast(errorMessage, { variant: "warning" });
      }
      if (frame.type === "auto_retry_start") {
        setStatuses((current) => updateOmpStatusMap(current, "retry", t("chat.retryingModel", {
          delaySeconds: Math.max(0, Math.ceil(Number(frame.delayMs ?? 0) / 1000)),
          attempt: Number(frame.attempt ?? 0),
          maxAttempts: Number(frame.maxAttempts ?? 0),
        })));
      }
      if (frame.type === "auto_retry_end") {
        setStatuses((current) => updateOmpStatusMap(current, "retry", undefined));
        if (frame.success === false && typeof frame.finalError === "string") showToast(frame.finalError, { variant: "error" });
      }
      if (frame.type === "retry_fallback_applied") {
        const fallback = {
          from: ompModelSelectorLabel(frame.from) || t("settings.omp.retryFallbackUnknownModel"),
          to: ompModelSelectorLabel(frame.to) || t("settings.omp.retryFallbackUnknownModel"),
          reason: ompFallbackReason(frame.reason) || t("settings.omp.retryFallbackReasonUnavailable"),
        };
        retryFallback.current = fallback;
        setStatuses((current) => updateOmpStatusMap(current, "retry-fallback", t("settings.omp.retryFallbackApplied", fallback)));
      }
      if (frame.type === "retry_fallback_succeeded") {
        const fallback = retryFallback.current;
        const model = ompModelSelectorLabel(frame.model) || fallback?.to || t("settings.omp.retryFallbackUnknownModel");
        setStatuses((current) => updateOmpStatusMap(current, "retry-fallback", t("settings.omp.retryFallbackSucceeded", {
          from: fallback?.from || model,
          to: fallback?.to || model,
          model,
          reason: fallback?.reason || t("settings.omp.retryFallbackReasonUnavailable"),
        })));
      }
      if (frame.type === "dictation_state") setStatuses((current) => updateOmpStatusMap(current, "dictation", t("settings.omp.dictationState", { state: String(frame.state ?? "") })));
      if (frame.type === "dictation_transcript") setStatuses((current) => updateOmpStatusMap(current, "dictation-transcript", String(frame.text ?? "")));
      if (frame.type === "process_exit" || frame.type === "runtime_error") {
        // A dead OMP process can no longer answer extension UI requests. Clear
        // the modal immediately instead of leaving an unclosable overlay.
        clearRequests();
        authorizationUrlSeen.current = false;
        setAuthLink(null);
        setValue("");
        setAnswers({});
        setStatuses({});
        setNativeTitle("");
        setWidgets({});
        setEditorText(null);
        setBusy(false);
        retryFallback.current = null;
      }
      if (frame.type === "login_failed") {
        // A failed provider exchange (for example an upstream 403) cannot use
        // the pending code prompt anymore. Clear it; the model picker reports
        // the detailed failure toast from the command response.
        clearRequests();
        authorizationUrlSeen.current = false;
        setAuthLink(null);
        setValue("");
        setAnswers({});
        setBusy(false);
      }
      if (frame.type === "runtime_error") showToast(String(frame.message ?? "OMP runtime error"), { variant: "error" });
      if (frame.type === "unsupported_interaction") showToast(t("settings.omp.unsupportedHostIntegration"), { variant: "warning" });
      if (frame.type === "rpc_frame_error") showToast(t("settings.omp.rpcFrameError", { message: String(frame.message ?? frame.error ?? "") }), { variant: "error" });
      if (frame.type === "extension_error") showToast(t("settings.omp.extensionError", { error: String(frame.error ?? "") }), { variant: "error" });
      if (frame.type === "notice" && (frame.level === "error" || frame.level === "warning")) {
        showToast(String(frame.message ?? t("settings.omp.nativeNotice")), { variant: frame.level === "error" ? "error" : "warning" });
      }
    });
  }, [sessionId, showToast, t]);

  const dismiss = (cancelled = true) => {
    const requestId = request?.id;
    const shouldRespond = ompExtensionRequestNeedsResponse(request?.method);
    const wasRiskAcknowledgement = context === "provider-management" && isOmpPreAuthRiskAcknowledgementPrompt(request, {
      providerManagementSession: true,
      authorizationUrlSeen: authorizationUrlSeen.current,
    });
    const wasLoginPrompt = request?.method === "input" && (isAuthorizationCodePrompt(request) || wasRiskAcknowledgement);
    // Close locally first. The backend may already have exited or a submit may
    // still be pending; neither condition should trap the user in this modal.
    dropRequest(requestId);
    setAuthLink(null);
    setValue("");
    setAnswers({});
    setBusy(false);
    if (cancelled && wasLoginPrompt) showToast(t("settings.omp.loginCancelled"), { variant: "info" });
    if (!sessionId) return;
    const requestIds = shouldRespond && typeof requestId === "string" ? [requestId] : [];
    if (requestIds.length === 0) return;
    const response = (id: string) => cancelled && wasRiskAcknowledgement
      ? createOmpRiskAcknowledgementCancellationResponse(id)
      : { type: "extension_ui_response", id, ...(cancelled ? { cancelled: true } : {}) };
    void Promise.all(requestIds.map((id) => api.respondOmpRpcUi({ sessionId, response: response(id) })))
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        // The settings session is short-lived and may already be stopped when
        // the user closes a prompt; that is expected, not a warning.
        if (/尚未连接|not connected|no (active|running) session/i.test(message)) return;
        showToast(message, { variant: "warning" });
      });
  };

  // Escape must work even when focus never entered the dialog (the login prompt
  // is usually opened from a page button behind the overlay).
  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request?.id]);

  const openAuthLink = async (link: OmpAuthLink) => {
    try {
      await api.browserOpenExternal(link.url);
      // open_url is a fire-and-forget RPC notification, not a pending dialog.
      // The browser action completes locally; never send a fake UI response.
      if (request?.method === "open_url" && request.id) dropRequest(request.id);
      setAuthLink(null);
      setStatuses((current) => updateOmpStatusMap(current, "auth", t("settings.omp.waitingForBrowserAuth")));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    }
  };

  const answer = async (confirmation?: boolean, selectedValue?: string) => {
    if (!sessionId || !request?.id || busy) return;
    const isRiskAcknowledgement = context === "provider-management" && isOmpPreAuthRiskAcknowledgementPrompt(request, {
      providerManagementSession: true,
      authorizationUrlSeen: authorizationUrlSeen.current,
    });
    const wasLoginPrompt = request.method === "input" && (isAuthorizationCodePrompt(request) || isRiskAcknowledgement);
    setBusy(true);
    try {
      const method = request.method;
      let response: Record<string, unknown>;
      if (method === "confirm") response = { type: "extension_ui_response", id: request.id, confirmed: confirmation ?? value === "yes" };
      else if (method === "select") response = { type: "extension_ui_response", id: request.id, value: selectedValue ?? value };
      else if (method === "ask") {
        response = {
          type: "extension_ui_response",
          id: request.id,
          answers: (request.questions ?? []).map((question: any) => {
            const answer = answers[question.id] ?? { selectedOptions: [], customInput: "" };
            return { id: question.id, selectedOptions: answer.selectedOptions, ...(answer.customInput.trim() ? { customInput: answer.customInput.trim() } : {}) };
          }),
        };
      } else response = isRiskAcknowledgement
        ? createOmpRiskAcknowledgementResponse(request.id)
        : { type: "extension_ui_response", id: request.id, value: selectedValue ?? value };
      await api.respondOmpRpcUi({ sessionId, response });
      dropRequest(request.id);
      if (wasLoginPrompt) setAuthLink(null);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    } finally { setBusy(false); }
  };

  const insertEditorText = () => {
    if (!sessionId || !editorText) return;
    if (useAppStore.getState().activeSessionId !== sessionId) {
      showToast(t("settings.omp.extensionEditorTextWrongSession"), { variant: "warning" });
      return;
    }
    useAppStore.setState({ composerPrefill: { sessionId, text: editorText, fileReferences: [], append: true } });
    setEditorText(null);
  };

  if (!request || !sessionId) {
    const statusRows = Object.entries(statuses);
    const widgetRows = Object.values(widgets).sort((left, right) => left.placement.localeCompare(right.placement) || left.key.localeCompare(right.key));
    if (!statusRows.length && !nativeTitle && widgetRows.length === 0 && !editorText) return null;
    return <section className="omp-rpc-status-card" role="status" aria-label={t("settings.omp.nativeExtensionStatus")}>
      {nativeTitle ? <strong className="omp-rpc-status-title">{nativeTitle}</strong> : null}
      {statusRows.map(([key, text]) => <p className="omp-rpc-status-text" key={key} data-status-key={key}>{text}</p>)}
      {widgetRows.map((widget) => <ul className="omp-rpc-widget-lines" key={widget.key} data-widget-key={widget.key} data-placement={widget.placement}>{widget.lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul>)}
      {editorText ? <div className="omp-rpc-editor-suggestion"><pre>{editorText}</pre><Button type="button" variant="secondary" size="sm" disabled={useAppStore.getState().activeSessionId !== sessionId} onClick={insertEditorText}>{t("settings.omp.extensionEditorInsertDraft")}</Button></div> : null}
    </section>;
  }
  if (request.method === "open_url") {
    const url = typeof request.launchUrl === "string" ? request.launchUrl : request.url;
    const host = targetHost(url);
    return (
      <div className="omp-rpc-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); dismiss(); } }}>
        <div role="dialog" aria-modal="true" aria-label={t("settings.omp.openLink")}>
          <Panel className="omp-rpc-dialog">
            <div className="omp-rpc-dialog-header"><div><span className="omp-rpc-source-label">{t("settings.omp.requestSource")}</span><strong>{t("settings.omp.openLink")}</strong></div><button type="button" className="icon-btn icon-btn-square" aria-label={t("common.cancel")} title={t("common.cancel")} onClick={() => dismiss(false)}><IconX size={14} aria-hidden="true" /></button></div>
            <p>{t("settings.omp.openLinkHint")}</p>
            {host ? <p className="omp-rpc-link-host">{t("settings.omp.openUrlHost", { host })}</p> : null}
            {request.instructions ? <p>{request.instructions}</p> : null}
            <div className="omp-rpc-actions">
              <Button type="button" variant="secondary" onClick={() => dismiss()}>{t("common.cancel")}</Button>
              <Button type="button" onClick={() => { if (typeof url === "string") void openAuthLink({ url, instructions: request.instructions }); }}>{t("settings.omp.openLinkInBrowser")}</Button>
            </div>
          </Panel>
        </div>
      </div>
    );
  }

  const method = request.method;
  const isLoginPrompt = method === "input" && isAuthorizationCodePrompt(request);
  const isRiskAcknowledgement = context === "provider-management" && isOmpPreAuthRiskAcknowledgementPrompt(request, {
    providerManagementSession: true,
    authorizationUrlSeen: authorizationUrlSeen.current,
  });
  const title = isLoginPrompt
    ? t("settings.omp.loginCodeTitle")
    : isRiskAcknowledgement
      ? t("settings.omp.loginRiskTitle")
      : request.title || t("settings.omp.requestInput");
  const checkboxSelect = method === "select" && request.selectionMarker === "checkbox";
  return (
    <div className="omp-rpc-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); } }}>
      <div role="dialog" aria-modal="true" aria-label={title}>
        <Panel className="omp-rpc-dialog">
          <div className="omp-rpc-dialog-header"><div><span className="omp-rpc-source-label">{t("settings.omp.requestSource")}</span><strong>{title}</strong></div><button type="button" className="icon-btn icon-btn-square" aria-label={t("common.cancel")} title={t("common.cancel")} onClick={() => void dismiss()}><IconX size={14} aria-hidden="true" /></button></div>
          <p className="omp-rpc-request-hint">{isLoginPrompt ? t("settings.omp.loginCodeHint") : isRiskAcknowledgement ? t("settings.omp.loginRiskHint") : t("settings.omp.interactiveRequestHint")}</p>
        {isLoginPrompt && authLink ? (
          <div className="omp-rpc-login-link">
            <span>{t("settings.omp.loginDestination", { host: targetHost(authLink.url) ?? authLink.url })}</span>
            <Button type="button" variant="secondary" onClick={() => void openAuthLink(authLink)}>{t("settings.omp.openLoginPage")}</Button>
            {authLink.instructions ? <p>{authLink.instructions}</p> : null}
          </div>
        ) : null}
        {isRiskAcknowledgement ? (
          <div className="omp-rpc-risk-warning" role="note">
            <p>{String(request.title ?? request.message ?? request.instructions ?? t("settings.omp.loginRiskWarningFallback"))}</p>
          </div>
        ) : method === "select" ? (
          <div className="omp-rpc-options" role={checkboxSelect ? "group" : "radiogroup"} aria-label={title}>
            {(request.options ?? []).map((option: string, index: number) => {
              const label = String(option);
              const description = request.optionDetails?.[index]?.description;
              const checkedByHost = Array.isArray(request.checkedIndices) && request.checkedIndices.includes(index);
              const recommended = request.initialIndex === index;
              const optionKind = ompSelectOptionKind(request, index);
              if (optionKind === "action") return <button type="button" key={`${index}:${label}`} className="omp-rpc-option-action" disabled={busy} autoFocus={recommended} onClick={() => checkboxSelect ? void answer(undefined, label) : setValue(label)}>
                <span>{label}</span>{description ? <small>{String(description)}</small> : null}
              </button>;
              return <label key={`${index}:${label}`} className={`omp-rpc-option${checkedByHost ? " is-checked-by-extension" : ""}${recommended ? " is-recommended" : ""}`}>
                <input
                  type={optionKind === "checkbox" ? "checkbox" : "radio"}
                  name={`omp-${request.id}`}
                  checked={optionKind === "checkbox" ? checkedByHost : value === label}
                  disabled={busy}
                  autoFocus={recommended}
                  onChange={() => checkboxSelect ? void answer(undefined, label) : setValue(label)}
                />
                <span>{label}{recommended ? <small>{t("settings.omp.recommendedChoice")}</small> : null}</span>
                {description ? <small>{String(description)}</small> : null}
              </label>;
            })}
          </div>
        ) : method === "ask" ? (
          <div className="omp-rpc-questions">
            {(request.questions ?? []).map((question: any) => {
              const current = answers[question.id] ?? { selectedOptions: [], customInput: "" };
              const setAnswer = (next: typeof current) => setAnswers((state) => ({ ...state, [question.id]: next }));
              return (
                <fieldset key={question.id}>
                  <legend>{question.header || question.question}</legend>
                  <p>{question.question}</p>
                  {question.multi ? question.options?.map((option: any) => (
                    <div className="omp-rpc-ask-option" key={option.label}>
                    <Checkbox
                      label={option.label}
                      checked={current.selectedOptions.includes(option.label)}
                      onChange={(event) => setAnswer({ ...current, selectedOptions: event.target.checked ? [...current.selectedOptions, option.label] : current.selectedOptions.filter((item) => item !== option.label), customInput: "" })}
                    />
                    {option.description || option.preview ? <small>{option.description ?? option.preview}</small> : null}
                    </div>
                  )) : question.options?.length ? (
                    <select value={current.selectedOptions[0] ?? ""} onChange={(event) => setAnswer({ ...current, selectedOptions: event.target.value ? [event.target.value] : [] })}>
                      <option value="">{t("settings.omp.chooseOption")}</option>
                      {question.options.map((option: any, index: number) => <option key={option.label} value={option.label}>{option.label}{index === question.recommended ? ` · ${t("settings.omp.recommendedChoice")}` : ""}</option>)}
                    </select>
                  ) : null}
                  <Input value={current.customInput} onChange={(event) => setAnswer({ ...current, customInput: event.target.value, selectedOptions: [] })} placeholder={t("settings.omp.customAnswer")} />
                </fieldset>
              );
            })}
          </div>
        ) : method === "confirm" ? (
          <p>{request.message}</p>
        ) : method === "editor" ? (
          <Textarea value={value} onChange={(event) => setValue(event.target.value)} rows={7} />
        ) : (
          <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder || (isLoginPrompt ? t("settings.omp.loginCodePlaceholder") : undefined)} type={request.secret ? "password" : "text"} autoFocus />
        )}
          <div className="omp-rpc-actions">
          <Button type="button" variant="secondary" onClick={() => dismiss()}>{isRiskAcknowledgement ? t("settings.omp.loginRiskDecline") : isLoginPrompt ? t("settings.omp.cancelLogin") : t("common.cancel")}</Button>
          {checkboxSelect ? null : <Button type="button" disabled={busy || (method === "select" && !value)} onClick={() => void answer(method === "confirm" ? true : undefined, isRiskAcknowledgement ? "yes" : undefined)}>{isRiskAcknowledgement ? t("settings.omp.loginRiskAccept") : isLoginPrompt ? t("settings.omp.submitLoginCode") : method === "confirm" ? t("settings.omp.confirm") : t("settings.omp.submit")}</Button>}
        </div>
        </Panel>
      </div>
    </div>
  );
}
