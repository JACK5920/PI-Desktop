import { isRemoteSession, sessionAllows } from "../lib/remote-session-safety";
import { inheritedSessionModelBinding } from "../lib/session-model";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  Mode,
  NativeMenuAction,
  PermissionMode,
} from "@pi-desktop/shared";
import {
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  imageGenerationBindings,
  isImageGenerationModel,
  normalizeLargePasteThreshold,
} from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import {
  PAUSED_TASK_CONTINUATION_PROMPT,
  cancelTaskPauseRequest,
  requestTaskPause,
  withoutPausedTask,
} from "../lib/paused-task-recovery";
import { latestTurnContextInspector } from "../lib/latest-turn-context";
import { isActivePlanExecution } from "../lib/plan-mode-state";
import { headAsk, queuedAskCount } from "../lib/pending-asks";
import type { QueuedPrompt } from "../lib/queued-prompts";
import { composerModelDisplayName, sameComposerModelId } from "../lib/composer-models";
import { sessionFastModeActive } from "../lib/fast-mode-command";
import { agentEngineForState } from "../lib/session-agent-engine";
import {
  resolveComposerThinkingProvider,
} from "../lib/session-thinking";
import { ComposerAutocomplete } from "./ComposerAutocomplete";
import {
  ContextMenu,
  useContextMenu,
  type ContextMenuItem,
} from "./ContextMenu";
import { AskToolCard } from "./AskToolCard";
import { PlanApprovalBar } from "./PlanApprovalBar";
import { GoalLifecycleBar } from "./GoalLifecycleBar";
import { TaskDock } from "./TaskDock";
import {
  COMPOSER_MAX_VISIBLE_ROWS,
  COMPOSER_MIN_HEIGHT_PX,
  PLACEHOLDER_KEYS,
  cssPixels,
  isPermissionMode,
  isThinkingLevel,
  thinkingLevelForProvider,
  thinkingProviderForModel,
  type ComposerPrefill,
} from "../features/chat/composer/model";
import { editorSelectionRange } from "../features/chat/composer/editor";
import { useComposerAttachments } from "../features/chat/composer/hooks/useComposerAttachments";
import { useComposerCompletions } from "../features/chat/composer/hooks/useComposerCompletions";
import { useComposerDraft } from "../features/chat/composer/hooks/useComposerDraft";
import { useComposerInputHistory } from "../features/chat/composer/hooks/useComposerInputHistory";
import { usePluginComposerBridge } from "../features/chat/composer/hooks/usePluginComposerBridge";
import { useComposerSuggestion } from "../features/chat/composer/hooks/useComposerSuggestion";
import { useComposerSubmit } from "../features/chat/composer/hooks/useComposerSubmit";
import { useComposerTransforms } from "../features/chat/composer/hooks/useComposerTransforms";
import { ComposerInput } from "../features/chat/composer/ComposerInput";
import { useComposerModelMenu } from "../features/chat/composer/hooks/useComposerModelMenu";
import { useVoiceInput } from "../features/voice/useVoiceInput";
import { ComposerToolbar } from "../features/chat/composer/ComposerToolbar";
import { insertGoalTemplate, type GoalTemplate } from "../features/chat/composer/goal-templates.mjs";
import { ComposerStatus } from "../features/chat/composer/ComposerStatus";
import { ComposerAnnotationAttachments } from "../features/chat/composer/ComposerAnnotationAttachments";

const EMPTY_QUEUED_PROMPTS: QueuedPrompt[] = [];

export {
  THINKING_LEVELS,
  thinkingLevelForProvider,
  thinkingProviderForModel,
  type ComposerPrefill,
} from "../features/chat/composer/model";

export function Composer({
  variant = "docked",
  prefill,
}: {
  variant?: "home" | "docked";
  prefill?: ComposerPrefill | null;
}) {
  const { t } = useTranslation();
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const steerPrompt = useAppStore((s) => s.steerPrompt);
  const removeQueuedPrompt = useAppStore((s) => s.removeQueuedPrompt);
  const moveQueuedPrompt = useAppStore((s) => s.moveQueuedPrompt);
  const editQueuedPrompt = useAppStore((s) => s.editQueuedPrompt);
  const sendQueuedNow = useAppStore((s) => s.sendQueuedNow);
  const abort = useAppStore((s) => s.abort);
  const [pausePending, setPausePending] = useState(false);
  const isRunning = useAppStore((s) => s.isRunning);
  useEffect(() => {
    if (!isRunning) setPausePending(false);
  }, [isRunning]);
  const planningState = useAppStore((s) =>
    s.activeSessionId ? s.planningStates[s.activeSessionId] : undefined,
  );
  const settings = useAppStore((s) => s.settings);
  const [agentEngineIssueState, setAgentEngineIssueState] = useState(() => {
    const engine = agentEngineForState(useAppStore.getState());
    return { engine, issue: engine === "omp" ? t("settings.omp.engineChecking") : null as string | null };
  });
  // The open conversation owns its engine; only chats without a pin (and the
  // new-task draft) follow the app-wide default.
  const agentEngine = useAppStore(agentEngineForState);
  const agentEngineIssueMessage = agentEngine === "omp"
    ? agentEngineIssueState.engine === "omp"
      ? agentEngineIssueState.issue
      : t("settings.omp.engineChecking")
    : null;
  const handleAgentEngineIssueChange = useCallback((engine: ReturnType<typeof agentEngineForState>, issue: string | null) => {
    setAgentEngineIssueState({ engine, issue });
  }, []);
  const plugins = useAppStore((s) => s.plugins);
  const imageGenerationCandidates = useMemo(
    () => imageGenerationBindings(settings?.imageGenerationModels, settings?.imageGeneration),
    [settings?.imageGenerationModels, settings?.imageGeneration],
  );
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeGoalLifecycle = useAppStore((s) =>
    s.activeSessionId ? s.goalLifecycles[s.activeSessionId] : undefined,
  );
  const activeSessionSummary = sessions.find(
    (session) => session.id === activeSessionId,
  );
  const capabilitySession = activeSessionSummary ?? (activeSessionId?.startsWith("remote:") ? { id: activeSessionId } : undefined);
  const goalManagedTask = activeGoalLifecycle?.status === "active" || activeGoalLifecycle?.status === "paused";
  const pauseSupported = !!activeSessionId && !goalManagedTask && sessionAllows(capabilitySession, "canStop") && !isRemoteSession(capabilitySession) && activeSessionSummary?.source !== "pi-native";
  const taskPaused = !!activeSessionId && !goalManagedTask && (settings?.pausedTaskSessionIds ?? []).includes(activeSessionId);
  const pauseTask = async () => {
    if (!activeSessionId || pausePending || !sessionAllows(capabilitySession, "canStop") || isRemoteSession(capabilitySession) || activeSessionSummary?.source === "pi-native") return;
    requestTaskPause(activeSessionId);
    setPausePending(true);
    try {
      const result = await api.stop(activeSessionId);
      if (!result?.requested) {
        cancelTaskPauseRequest(activeSessionId);
        setPausePending(false);
        showToast(t("chat.pauseGeneratingFailed"), { variant: "warning" });
      }
    } catch {
      cancelTaskPauseRequest(activeSessionId);
      setPausePending(false);
      showToast(t("chat.pauseGeneratingFailed"), { variant: "error" });
    }
  };
  const stopTask = async () => {
    if (activeSessionId) {
      cancelTaskPauseRequest(activeSessionId);
      const currentSettings = useAppStore.getState().settings;
      if (currentSettings?.pausedTaskSessionIds?.includes(activeSessionId)) {
        const next = withoutPausedTask(currentSettings, activeSessionId);
        useAppStore.setState({ settings: next });
        try {
          await api.setSettings(next);
        } catch {
          showToast(t("chat.pauseGeneratingFailed"), { variant: "error" });
        }
      }
    }
    await abort();
  };
  const resumeTask = async () => {
    if (!activeSessionId || !taskPaused) return;
    const currentSettings = useAppStore.getState().settings;
    if (!currentSettings) return;
    const next = withoutPausedTask(currentSettings, activeSessionId);
    await api.setSettings(next);
    useAppStore.setState({ settings: next });
    const accepted = await sendPrompt(PAUSED_TASK_CONTINUATION_PROMPT, undefined, activeSessionId);
    if (!accepted) {
      const latest = useAppStore.getState().settings ?? next;
      const restored = {
        ...latest,
        pausedTaskSessionIds: [...new Set([...(latest.pausedTaskSessionIds ?? []), activeSessionId])],
      };
      await api.setSettings(restored);
      useAppStore.setState({ settings: restored });
    }
  };
  const composerTransforms = useMemo(
    () =>
      (sessionAllows(capabilitySession, "canUseLocalTools") ? plugins : [])
        .filter((plugin) => plugin.enabled && plugin.status === "ready")
        .flatMap((plugin) => plugin.composerTransforms ?? []),
    [plugins, activeSessionSummary, activeSessionId],
  );
  const remoteSession = isRemoteSession(capabilitySession);
  const localToolsAllowed = agentEngine !== "omp" && sessionAllows(capabilitySession, "canUseLocalTools");
  const attachmentsAllowed = agentEngine === "omp"
    ? !remoteSession && activeSessionSummary?.source !== "pi-native"
    : sessionAllows(capabilitySession, "canAttach");
  const promptAllowed = agentEngine === "omp"
    ? !remoteSession && activeSessionSummary?.source !== "pi-native"
    : sessionAllows(capabilitySession, "canPrompt");
  const nativeSession = activeSessionSummary?.source === "pi-native";
  const nativeReadOnly =
    nativeSession && activeSessionSummary.capabilities?.canPrompt !== true;
  const nativeInputBlocked = nativeReadOnly || (agentEngine !== "omp" && !promptAllowed) || ((nativeSession || remoteSession) && isRunning);
  const localWorkspacePath = useAppStore((s) => s.workspace?.path ?? "");
  const workspacePath = remoteSession ? "" : localWorkspacePath;
  const providers = useAppStore((s) => s.providers);
  const providerModels = useAppStore((s) => s.providerModels);
  const liveMessages = useAppStore((s) => s.messages);
  const sessionCompactions = useAppStore((s) =>
    s.activeSessionId ? s.sessionCompactions[s.activeSessionId] : undefined,
  );
  const recentModels = useAppStore((s) => s.recentModels);
  const configureActiveSession = useAppStore((s) => s.configureActiveSession);
  const showToast = useAppStore((s) => s.showToast);
  const composerPrefill = useAppStore((s) => s.composerPrefill);
  const clearComposerPrefill = useAppStore((s) => s.clearComposerPrefill);
  const planCheckpoint = useAppStore((s) =>
    s.activeSessionId ? s.planCheckpoints[s.activeSessionId] : undefined,
  );
  const goalLifecycle = useAppStore((s) =>
    s.activeSessionId ? s.goalLifecycles[s.activeSessionId] : undefined,
  );
  const goalProgress = useAppStore((s) =>
    s.activeSessionId ? s.goalProgress[s.activeSessionId] : undefined,
  );
  const pendingAsk = useAppStore((s) =>
    headAsk(s.pendingAsks, s.activeSessionId),
  );
  const queuedAsks = useAppStore((s) =>
    queuedAskCount(s.pendingAsks, s.activeSessionId),
  );
  const queuedPrompts = useAppStore((s) =>
    s.activeSessionId
      ? s.queuedPrompts[s.activeSessionId] ?? EMPTY_QUEUED_PROMPTS
      : EMPTY_QUEUED_PROMPTS,
  );

  const [modeOpen, setModeOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const composerTransformInvalidateRef = useRef<() => void>(() => {});
  const composerShellRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const publishedDockHeightRef = useRef(-1);

  const invalidateComposerTransforms = () => {
    composerTransformInvalidateRef.current();
  };

  const draft = useComposerDraft({
    variant,
    activeSessionId,
    workspacePath,
    sessions,
    composerPrefill,
    clearComposerPrefill,
    prefill,
    t,
    invalidateComposerTransforms,
    inputBlocked: planCheckpoint?.status === "pending" || nativeInputBlocked,
  });
  const {
    ref,
    draftKey,
    referenceSessionId,
    value,
    setValue,
    valueRef,
    cursor,
    setCursor,
    composing,
    setComposing,
    inputFocused,
    setInputFocused,
    placeholderIndex,
    activeFileReferences,
    fileReferencesRef,
    applyEditorDraft,
    snapshotReferences,
    draftSnapshot,
    draftRevision,
    clearDraftForKey,
    restoreDraftForKey,
    persistDraft,
    commitEditorDom,
    readLiveDraft,
    insertNewlineInEditor,
    handleInput,
  } = draft;
  const inputHistory = useComposerInputHistory({
    draftKey,
    referenceSessionId,
    draft,
  });

  const approvalPending = agentEngine !== "omp" && planCheckpoint?.status === "pending";
  const largePasteThreshold = normalizeLargePasteThreshold(
    settings?.largePasteThreshold,
  );
  const attachments = useComposerAttachments({
    inputBlocked: approvalPending || nativeSession,
    attachmentsAllowed,
    activeSessionId,
    draftKey,
    largePasteThreshold,
    t,
    draft: {
      ref,
      valueRef,
      fileReferencesRef: draft.fileReferencesRef,
      applyEditorDraft,
      snapshotReferences,
      commitEditorDom,
    },
  });
  const {
    pasting,
    dropTargetActive,
    droppedDirectories,
    pickAndAttach,
    pasteClipboardFiles,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    openDroppedFolderAsProject,
    insertDroppedDirectoryPaths,
    dismissDroppedDirectories,
  } = attachments;
  const executionActive = isActivePlanExecution(planCheckpoint);
  const runActive = isRunning || executionActive;
  const inputBlocked = approvalPending || pasting || nativeInputBlocked;
  const controlsBlocked = agentEngine === "omp"
    ? nativeSession || remoteSession || isRunning
    : approvalPending || nativeSession || !sessionAllows(capabilitySession, "canConfigureModel");
  const { contextMenu: composerMenu, openContextMenu: openComposerMenu, closeContextMenu: closeComposerMenu } = useContextMenu();
  // The menu drives Chromium's own edit commands, and focusing a menu item
  // collapses the live Range. Keep the caret the user right-clicked with so
  // the command lands where the pointer was, not at the start of the draft.
  const composerCaretRef = useRef<{ range: Range | null }>({ range: null });

  const caretFromContextMenu = (event: ReactMouseEvent<HTMLDivElement>): Range | null => {
    const editor = event.currentTarget;
    const live = window.getSelection();
    if (live && live.rangeCount > 0) {
      const current = live.getRangeAt(0);
      if (editor.contains(current.commonAncestorContainer)) return current.cloneRange();
    }
    // A right-click away from the selection still needs an anchor for paste.
    const atPoint =
      typeof document.caretRangeFromPoint === "function"
        ? document.caretRangeFromPoint(event.clientX, event.clientY)
        : null;
    return atPoint && editor.contains(atPoint.startContainer) ? atPoint : null;
  };

  const restoreComposerCaret = (): HTMLDivElement | null => {
    const editor = ref.current;
    if (!editor) return null;
    editor.focus();
    const range = composerCaretRef.current.range;
    if (range && range.startContainer.isConnected) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    return editor;
  };

  /** Native commands act on the focused editable, so focus it first. */
  const runComposerEditAction = (action: NativeMenuAction) => {
    // One frame later: ContextMenu closes and refocuses in its own effect, and
    // the command must target the editor rather than the menu it came from.
    requestAnimationFrame(() => {
      if (!restoreComposerCaret()) return;
      void api.nativeMenuAction(action);
    });
  };

  /**
   * `nativeMenuAction("selectAll")` selects the whole document in a
   * contenteditable frame, which would arm a stray keystroke to wipe the app.
   * Select the draft's contents instead.
   */
  const selectComposerContents = () => {
    requestAnimationFrame(() => {
      const editor = restoreComposerCaret();
      if (!editor) return;
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  };

  const openComposerContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const range = caretFromContextMenu(event);
    composerCaretRef.current.range = range;
    const hasSelection = Boolean(range && !range.collapsed);
    const chip =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(".composer-chip")
        : null;
    if (chip) {
      const token = chip.dataset.token ?? "";
      openComposerMenu(event, {
        label: t("chat.composerMenu.label"),
        items: [
          {
            id: "remove-reference",
            label: t("chat.composerMenu.removeReference"),
            danger: true,
            disabled: inputBlocked || !token,
            onSelect: () => draft.removeChipByTokenRef.current(token),
          },
        ],
      });
      return;
    }
    const items: ContextMenuItem[] = [
      { id: "undo", label: t("chat.composerMenu.undo"), disabled: inputBlocked, onSelect: () => runComposerEditAction("undo") },
      { id: "redo", label: t("chat.composerMenu.redo"), disabled: inputBlocked, onSelect: () => runComposerEditAction("redo") },
      { id: "cut", label: t("chat.composerMenu.cut"), separatorBefore: true, disabled: inputBlocked || !hasSelection, onSelect: () => runComposerEditAction("cut") },
      { id: "copy", label: t("chat.composerMenu.copy"), disabled: !hasSelection, onSelect: () => runComposerEditAction("copy") },
      { id: "paste", label: t("chat.composerMenu.paste"), disabled: inputBlocked, onSelect: () => runComposerEditAction("paste") },
      { id: "select-all", label: t("chat.composerMenu.selectAll"), separatorBefore: true, onSelect: selectComposerContents },
    ];
    openComposerMenu(event, { label: t("chat.composerMenu.label"), items });
  };
  // Edit returns one queued row to the composer. The row is removed and its
  // captured draft becomes the input, so the input must be empty first: the
  // live read is the only current source (the draft cache is not per keystroke).
  const handleEditQueuedPrompt = (id: string) => {
    if (readLiveDraft().trim() || activeFileReferences.length) {
      showToast(t("chat.editQueuedPromptBusy"), { variant: "info" });
      return;
    }
    editQueuedPrompt(id);
  };
  const placeholderKeys = PLACEHOLDER_KEYS[variant];
  const placeholderKey =
    placeholderKeys[placeholderIndex % placeholderKeys.length] ?? placeholderKeys[0];
  const placeholderText = t(placeholderKey);

  const textareaMetricsRef = useRef<{ lineHeight: number; verticalChrome: number } | null>(null);
  const appliedHeightRef = useRef<number | null>(null);
  const appliedOverflowRef = useRef<string | null>(null);
  useEffect(() => {
    textareaMetricsRef.current = null;
    appliedHeightRef.current = null;
    appliedOverflowRef.current = null;
  }, [variant]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let metrics = textareaMetricsRef.current;
    if (!metrics) {
      const style = window.getComputedStyle(el);
      metrics = {
        lineHeight: cssPixels(style.lineHeight) || COMPOSER_MIN_HEIGHT_PX,
        verticalChrome:
          cssPixels(style.paddingTop) +
          cssPixels(style.paddingBottom) +
          cssPixels(style.borderTopWidth) +
          cssPixels(style.borderBottomWidth),
      };
      textareaMetricsRef.current = metrics;
    }
    const maxHeight = Math.ceil(
      metrics.lineHeight * COMPOSER_MAX_VISIBLE_ROWS + metrics.verticalChrome,
    );
    const applied =
      appliedHeightRef.current !== null &&
      el.style.height === `${appliedHeightRef.current}px`
        ? appliedHeightRef.current
        : null;
    let content = applied === null ? -1 : el.scrollHeight;
    if (
      applied === null ||
      (content <= el.clientHeight && applied > COMPOSER_MIN_HEIGHT_PX)
    ) {
      el.style.height = "auto";
      content = el.scrollHeight;
    }
    const next = Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(content, maxHeight));
    const overflowY = content > maxHeight ? "auto" : "hidden";
    if (appliedHeightRef.current !== next || el.style.height !== `${next}px`) {
      el.style.height = `${next}px`;
      appliedHeightRef.current = next;
    }
    if (appliedOverflowRef.current !== overflowY) {
      el.style.overflowY = overflowY;
      appliedOverflowRef.current = overflowY;
    }
  }, [value]);


  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const draftConfiguration = useAppStore((s) => s.draftConfiguration);
  const mode: Mode = activeSession
    ? activeSession.mode
    : (draftConfiguration?.mode ?? settings?.defaultMode ?? "agent");
  const planningLive =
    isRunning &&
    planningState === "planning" &&
    (mode === "plan" || mode === "goal");
  // Permission mode (D115/D132): inherited sessions still resolve through the
  // global setting, but the composer presents only the effective mode.
  const globalPermissionMode: PermissionMode =
    settings?.defaultPermissionMode ?? "ask";
  const sessionPermissionMode: PermissionMode = activeSession
    ? isPermissionMode(activeSession.permissionMode)
      ? activeSession.permissionMode
      : "inherit"
    : isPermissionMode(draftConfiguration?.permissionMode)
      ? draftConfiguration.permissionMode
      : "inherit";
  const effectivePermissionMode: Exclude<PermissionMode, "inherit"> =
    sessionPermissionMode === "inherit"
      ? (globalPermissionMode as Exclude<PermissionMode, "inherit">)
      : sessionPermissionMode;
  const composerPermissionMode: Exclude<PermissionMode, "inherit"> =
    mode === "goal" ? "auto" : effectivePermissionMode;
  const selectedModel = remoteSession ? { providerId: activeSession?.providerId, modelId: activeSession?.modelId } : inheritedSessionModelBinding({
    draft: activeSession ?? draftConfiguration,
    settings,
    providers,
    recentModels,
  });
  // One inspector in the composer toolbar, always the newest turn with usage.
  const composerContextUsage = useMemo(
    () => latestTurnContextInspector(
      liveMessages,
      providerModels,
      providers,
      sessionCompactions,
      selectedModel,
    ),
    [liveMessages, providerModels, providers, sessionCompactions, selectedModel.providerId, selectedModel.modelId],
  );
  const provider = providers.find(candidate => candidate.id === selectedModel.providerId);
  const modelId = selectedModel.modelId;
  const selectedModelCatalog = provider ? providerModels[provider.id] : undefined;
  const catalogThinkingProvider = thinkingProviderForModel(
    provider,
    modelId,
    selectedModelCatalog,
  );
  const thinkingProvider = resolveComposerThinkingProvider({
    provider,
    modelId,
    activeSession,
    catalogThinkingProvider,
  });
  const selectedBinding = provider?.models.find((candidate) =>
    sameComposerModelId(candidate.id, modelId ?? ""),
  );
  const selectedModelInfo = selectedModelCatalog?.find((candidate) =>
    sameComposerModelId(candidate.modelId, modelId ?? ""),
  );
  // A draft without a session starts at the selected model's stored default
  // thinking level, clamped onto that binding's enabled ladder.
  const draftThinkingLevel = selectedModelInfo?.catalogSource === "models.dev"
    ? initialThinkingLevelForBinding(
        selectedBinding,
        thinkingProvider?.supportedThinkingLevels,
      )
    : initialThinkingLevelForUnmatchedModel(
        selectedBinding,
        thinkingProvider?.supportedThinkingLevels,
      );
  const sessionThinkingLevel =
    activeSession?.thinkingLevel ??
    (!activeSession ? draftConfiguration?.thinkingLevel : undefined) ??
    draftThinkingLevel;
  const configuredThinkingLevel = isThinkingLevel(sessionThinkingLevel)
    ? sessionThinkingLevel
    : "off";
  const thinkingLevel = thinkingLevelForProvider(
    thinkingProvider,
    configuredThinkingLevel,
  );
  const thinkingLabel = thinkingLevel;
  const modelLabel = modelId
    ? composerModelDisplayName(provider, modelId)
    : t("chat.model");
  const modelMenu = useComposerModelMenu({
    configureActiveSession,
    mode,
    activeSessionId,
    provider,
    modelId,
    thinkingProvider,
    thinkingLevel,
    controlsBlocked,
  });
  const modelReady = agentEngine === "omp"
    ? !remoteSession && !nativeSession
    : remoteSession
    ? promptAllowed
    : activeSessionSummary?.managedByPlugin
    ? true
    : nativeSession
    ? activeSessionSummary.capabilities?.canPrompt === true
    : !!provider &&
      provider.enabled &&
      !!modelId &&
      !isImageGenerationModel(imageGenerationCandidates, provider.id, modelId) &&
      (provider.hasSecret || provider.authKind === "none");
  const sendBlocked = (agentEngine !== "omp" && approvalPending) || pasting || nativeInputBlocked || agentEngineIssueMessage !== null;
  const enterToSend = settings?.enterToSend ?? true;
  const hasDraftContent = Boolean(value.trim() || activeFileReferences.length);

  useEffect(() => {
    if (!controlsBlocked) return;
    setModeOpen(false);
    setPermissionOpen(false);
  }, [controlsBlocked]);

  const composerTransformController = useComposerTransforms({
    transforms: composerTransforms,
    value,
    draftKey,
    activeSessionId,
    providerId: provider?.id,
    modelId,
    sendBlocked,
    activeFileReferences,
    draft: { ref, setValue, setCursor },
    showToast,
  });
  composerTransformInvalidateRef.current = composerTransformController.invalidate;

  const submitController = useComposerSubmit({
    value,
    draftKey,
    activeSessionId,
    modelReady,
    invalidateComposerTransforms,
    sendBlocked,
    localCommandsAllowed: agentEngine !== "omp" && localToolsAllowed,
    steeringAllowed: agentEngine === "omp" || sessionAllows(capabilitySession, "canSteer"),
    pasting,
    activeFileReferences,
    t,
    sendPrompt,
    steerPrompt,
    sendQueuedNow,
    queuedPrompts,
    showToast,
    recordHistory: inputHistory.record,
    draft: {
      ref,
      draftSnapshot,
      draftRevision,
      clearDraftForKey,
      restoreDraftForKey,
    },
  });
  const { submit } = submitController;

  // Both submit entry points (the composer's Enter and the toolbar's Send)
  // leave history browsing before the draft is cleared.
  const submitFromComposer = (steering?: boolean) => {
    inputHistory.exitBrowsing();
    return submit(steering);
  };

  const selectGoalTemplate = async (template: GoalTemplate) => {
    try {
      await configureActiveSession({
        mode: "goal",
        providerId: provider?.id,
        modelId,
        thinkingLevel,
      });
      const inserted = insertGoalTemplate(
        draft.readLiveDraft(),
        draft.cursor,
        t(template.promptKey),
      );
      draft.applyEditorDraft(
        inserted.text,
        draft.activeFileReferences,
        inserted.caret,
      );
      invalidateComposerTransforms();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  // Keep the legacy listener for already-started or IPC-owned Dictation, but
  // the Composer no longer exposes a Dictation control or overlay.
  useVoiceInput({
    enabled: localToolsAllowed && import.meta.env.DEV && !!settings?.voice?.enabled,
    onTranscriptionComplete: (text) => {
      const current = readLiveDraft();
      if (!current.trim()) {
        applyEditorDraft(text, fileReferencesRef.current, text.length);
      } else {
        const next = current + " " + text;
        applyEditorDraft(next, fileReferencesRef.current, next.length);
      }
    },
  });
  const completions = useComposerCompletions({
    value,
    cursor,
    composing,
    enabled: !inputBlocked && localToolsAllowed,
    referenceSessionId,
    fileReferencesRef,
    agentsEnabled: mode === "agent",
    applyEditorDraft,
    handleInput,
    invalidateComposerTransforms,
  });

  // Plugin draft and attachment actions reach this composer while it takes input.
  usePluginComposerBridge({ ...draft, inputBlocked, enabled: localToolsAllowed });
  // A plugin may have offered one line for this empty draft; it shows in the
  // placeholder layer and `Tab` takes it (ADR 0333).
  const suggestion = useComposerSuggestion();

  // Keep the transcript's bottom reserve in sync with the composer's real
  // height (it grows with multi-line input) so the last message sits just
  // above the box instead of far below it.
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    // Setting a custom property on documentElement invalidates style for the
    // whole document, so an unchanged dock height must not be republished.
    const publish = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h === publishedDockHeightRef.current) return;
      publishedDockHeightRef.current = h;
      document.documentElement.style.setProperty(
        "--composer-dock-height",
        `${h}px`,
      );
    };
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [variant]);

  return (
    <div
      ref={dockRef}
      className={`composer-dock composer-dock-${variant}`}
      data-composer-dock={variant}
    >
      <div className="composer-stack">
        {/* One container for todo and background tasks: the tabs live in the
            header, so the gate now covers both the way it already covered the
            todo dock. */}
        {activeSessionId && localToolsAllowed ? <TaskDock sessionId={activeSessionId} /> : null}
        {planCheckpoint?.status === "pending" ? (
          <PlanApprovalBar proposal={planCheckpoint} />
        ) : null}
        {goalLifecycle && goalLifecycle.status !== "cleared" && localToolsAllowed && !nativeSession ? (
          <GoalLifecycleBar goal={goalLifecycle} liveProgress={goalProgress} />
        ) : null}
        {pendingAsk ? (
          <AskToolCard key={pendingAsk.requestId} request={pendingAsk} queued={queuedAsks} />
        ) : null}
        {nativeReadOnly ? (
          <div className="composer-status" role="status">
            Native Pi session is read-only: {activeSessionSummary?.readOnlyReason ?? "continuation unavailable"}.
          </div>
        ) : null}
        <ComposerStatus
          t={t}
          queuedPrompts={queuedPrompts}
          removeQueuedPrompt={removeQueuedPrompt}
          moveQueuedPrompt={moveQueuedPrompt}
          editQueuedPrompt={handleEditQueuedPrompt}
          sendQueuedNow={sendQueuedNow}
          approvalPending={approvalPending}
          droppedDirectories={droppedDirectories}
          openDroppedFolderAsProject={openDroppedFolderAsProject}
          insertDroppedDirectoryPaths={insertDroppedDirectoryPaths}
          dismissDroppedDirectories={dismissDroppedDirectories}
        />
        <div
          ref={composerShellRef}
          className={`composer-shell${inputBlocked ? " is-gated" : ""}${
            dropTargetActive ? " is-drop-target" : ""
          }`}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          {inputFocused ? (
            <ComposerAutocomplete
              anchorRef={composerShellRef}
              ac={completions.ac}
              onAccept={completions.acceptCompletion}
            />
          ) : null}
          <ComposerAnnotationAttachments />
          <ComposerInput
            imagePreview={draft.imagePreview}
            directoryReferences={activeFileReferences.filter((reference) => reference.kind === "directory")}
            onRemoveDirectory={draft.removeDirectoryReference}
            inputRef={ref}
            value={value}
            placeholderText={placeholderText}
            placeholderKey={`${variant}-${placeholderIndex}-${placeholderText}`}
            inputBlocked={inputBlocked}
            pasting={pasting}
            enterToSend={enterToSend}
            runActive={runActive}
            ompPredictionSessionId={agentEngine === "omp" && !remoteSession ? activeSessionId : null}
            composerAc={completions.ac}
            suggestion={suggestion}
            onPaste={pasteClipboardFiles}
            onContextMenu={openComposerContextMenu}
            onAcceptCompletion={completions.acceptCompletion}
            onSubmit={(steering) => void submitFromComposer(steering)}
            onInsertNewline={insertNewlineInEditor}
            onInput={(source, caret, composing) => {
              inputHistory.exitBrowsing();
              completions.handleInput(source, caret, composing);
            }}
            onHistoryNavigate={inputHistory.navigate}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setComposing(false);
              draft.updateCursor(editorSelectionRange(event.currentTarget).start);
            }}
            // A dropped compositionend must not freeze the menu forever (#929).
            onSettledInput={() => draft.setComposing(false)}
            onFocus={() => setInputFocused(true)}
            onBlur={() => {
              setInputFocused(false);
              persistDraft();
            }}
          />
          <ContextMenu state={composerMenu} onClose={closeComposerMenu} />
          <ComposerToolbar
            t={t}
            mode={mode}
            planningLive={planningLive}
            providerId={provider?.id}
            modelId={modelId}
            thinkingLevel={thinkingLevel}
            composerPermissionMode={composerPermissionMode}
            modeOpen={modeOpen}
            setModeOpen={setModeOpen}
            permissionOpen={permissionOpen}
            setPermissionOpen={setPermissionOpen}
            controlsBlocked={controlsBlocked}
            engineSwitchBlocked={controlsBlocked || isRunning}
            localToolsAllowed={localToolsAllowed}
            ompControlsAvailable={agentEngine === "omp" && !remoteSession && !nativeSession}
            attachmentsAllowed={attachmentsAllowed}
            stopAllowed={agentEngine === "omp" ? !remoteSession && !nativeSession : sessionAllows(capabilitySession, "canStop")}
            pasting={pasting}
            pickAndAttach={pickAndAttach}
            configureActiveSession={configureActiveSession}
            showToast={showToast}
            onSelectGoalTemplate={selectGoalTemplate}
            modelMenu={modelMenu}
            modelLabel={modelLabel}
            engineIssueMessage={agentEngineIssueMessage}
            selectedProvider={provider}
            onEngineIssueChange={handleAgentEngineIssueChange}
            thinkingLabel={thinkingLabel}
            modelFastMode={sessionFastModeActive(provider, modelId, activeSession ?? draftConfiguration)}
            contextUsage={composerContextUsage ?? null}
            value={value}
            modelReady={modelReady}
            sendBlocked={sendBlocked}
            composerTransforms={composerTransforms}
            activeTransformKey={composerTransformController.activeTransformKey}
            undoTransform={composerTransformController.undo?.transform ?? null}
            runComposerTransform={composerTransformController.run}
            undoComposerTransform={composerTransformController.undoLast}
            runActive={runActive}
            hasDraftContent={hasDraftContent}
            steeringAllowed={agentEngine === "omp" || sessionAllows(capabilitySession, "canSteer")}
            nativeSession={nativeSession || agentEngine === "omp"}
            abort={stopTask}
            taskPaused={taskPaused}
            pausePending={pausePending}
            pauseTask={pauseSupported ? pauseTask : undefined}
            resumeTask={resumeTask}
            submit={submitFromComposer}
            workSessionId={activeSessionId ?? undefined}
            workSessionLabel={activeSessionSummary?.title}
          />
        </div>
      </div>
    </div>
  );
}
