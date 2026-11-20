import { OMP_SETTINGS_RPC_SESSION_ID } from "@pi-desktop/shared";
import type { TFunction } from "i18next";
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconBot, IconCheck, IconChevronDown, IconSearch, IconX } from "../../../components/icons";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { api, type OmpModelOverride } from "../../../lib/api";
import { type OmpModelRecoveryInfo, type OmpRecoveryCandidate, readOmpModelRecovery } from "../../../lib/omp-model-recovery";
import { useAppStore } from "../../../stores/app-store";
import {
  filterOmpModelsBySearch,
  groupOmpModelsByProvider,
  mapOmpProviderDisplayNames,
  type OmpModelOption,
  ompProviderDisplayName,
  readOmpThinkingLevels,
  selectOmpModelAndRefreshThinkingLevels,
  toOmpRpcModelIdentity,
} from "./omp-model-selection.mjs";

type OmpModel = OmpModelOption;
type OmpThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function modelVisibilityKey(provider: string, id: string): string {
  return `${encodeURIComponent(provider)}::${encodeURIComponent(id)}`;
}

type PickerCache = {
  model: OmpModel | null;
  models: OmpModel[];
  thinkingLevels: OmpThinkingLevel[];
  thinkingLevel: OmpThinkingLevel | null;
  fastMode: boolean;
  slowMode: boolean;
  slowModeSupported: boolean;
};

/**
 * The model catalog is session-scoped and only changes when providers change
 * or a model is selected. Keeping it across menu opens turns a slow RPC round
 * trip into an instant repaint; opens after the first still refresh in the
 * background so a login made elsewhere shows up.
 */
const pickerCache = new Map<string, PickerCache>();

// The engine's first catalog read costs a cold start plus an online provider
// discovery (seconds), so the last known catalog is persisted and painted
// before the refresh starts.
const CATALOG_STORAGE_KEY = "pi.omp.modelCatalog";
// Cache key for the "new task" composer, which has no conversation yet.
const DRAFT_CACHE_KEY = "draft";
// Mirrors the native picker's "recent" rail entry; kept per machine, not per
// session, because recency is a property of the user rather than a chat.
const RECENT_STORAGE_KEY = "pi.omp.recentModels";
const RECENT_LIMIT = 8;

type RecentModel = { provider: string; id: string };

function readRecentModels(): RecentModel[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentModel => {
      const record = entry as { provider?: unknown; id?: unknown } | null;
      return Boolean(record) && typeof record?.provider === "string" && typeof record.id === "string";
    });
  } catch {
    return [];
  }
}

function writeRecentModels(list: RecentModel[]): void {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Losing recency only costs the shortcut, never the catalog.
  }
}

function modelStorageKey(sessionId: string): string {
  return `pi.omp.model.${sessionId}`;
}

// New-task composers have no session id, so their chip must look at the last
// model the user actually picked, not only at this draft's own cache.
const LAST_MODEL_KEY = "pi.omp.model.last";

function readLastUsedModel(): OmpModel | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_MODEL_KEY) ?? "null") as OmpModel | null;
    return parsed && typeof parsed.provider === "string" && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Installs that picked a model before `LAST_MODEL_KEY` existed only have
 * per-session keys. Walk them instead of showing the placeholder until the user
 * picks again.
 */
function readAnyStoredModel(): OmpModel | null {
  try {
    const prefix = "pi.omp.model.";
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(prefix) || key === LAST_MODEL_KEY) continue;
      const model = readStoredModel(key.slice(prefix.length));
      if (model) return model;
    }
  } catch {
    // A blocked storage only loses the warm label.
  }
  return null;
}

/** Newest OMP conversation is the most trustworthy evidence of the last pick. */
function readRecentSessionModel(): OmpModel | null {
  const sessions = useAppStore.getState().sessions;
  const ordered = [...sessions].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  for (const session of ordered) {
    if (session.agentEngine !== "omp") continue;
    const model = readStoredModel(session.id);
    if (model) return model;
  }
  return null;
}

function readStoredCatalog(): { models: OmpModel[]; thinkingLevels: OmpThinkingLevel[] } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CATALOG_STORAGE_KEY) ?? "null") as
      | { models?: unknown; thinkingLevels?: unknown }
      | null;
    if (!parsed || !Array.isArray(parsed.models)) return null;
    return {
      models: parsed.models as OmpModel[],
      thinkingLevels: Array.isArray(parsed.thinkingLevels) ? (parsed.thinkingLevels as OmpThinkingLevel[]) : [],
    };
  } catch {
    return null;
  }
}

function writeStoredCatalog(models: OmpModel[], thinkingLevels: OmpThinkingLevel[]): void {
  try {
    localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify({ models, thinkingLevels }));
  } catch {
    // A disabled or full storage only costs the next open its warm paint.
  }
}

function readStoredModel(sessionId: string): OmpModel | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(modelStorageKey(sessionId)) ?? "null") as OmpModel | null;
    return parsed && typeof parsed.provider === "string" && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredModel(sessionId: string, model: OmpModel | null): void {
  if (!model) return;
  try {
    localStorage.setItem(modelStorageKey(sessionId), JSON.stringify(model));
    // Every real pick also becomes the starting point of the next new task.
    localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(model));
  } catch {
    // Losing the warm label is harmless; attach still reports the real model.
  }
}

export function ComposerOmpModelPicker({
  t,
  controlsBlocked,
  onCloseOtherMenus,
}: {
  t: TFunction;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
}) {
  const sessionId = useAppStore((state) => state.activeSessionId);
  // The "new task" composer has no conversation yet. It still lets the user
  // preselect the model for the next one, so the settings session (always
  // attachable) answers catalog and set_model, and the choice is written to the
  // engine's selected-model file for the conversation that starts next.
  const draft = !sessionId;
  const cacheKey = sessionId ?? DRAFT_CACHE_KEY;
  const rpcSessionId = sessionId ?? OMP_SETTINGS_RPC_SESSION_ID;
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const setPage = useAppStore((state) => state.setPage);
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<OmpModel | null>(null);
  const [models, setModels] = useState<OmpModel[]>([]);
  const [modelQuery, setModelQuery] = useState("");
  const [recent, setRecent] = useState<RecentModel[]>(() => readRecentModels());
  const [activeSection, setActiveSection] = useState("recent");
  const [thinkingLevels, setThinkingLevels] = useState<OmpThinkingLevel[]>([]);
  const [thinkingLevel, setThinkingLevel] = useState<OmpThinkingLevel | null>(null);
  const [fastMode, setFastMode] = useState(false);
  const [slowMode, setSlowMode] = useState(false);
  const [slowModeSupported, setSlowModeSupported] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A dead session model blocks attach itself; candidates come from Main so
  // the menu can offer a way out without ever showing an empty catalog.
  const [recovery, setRecovery] = useState<OmpModelRecoveryInfo | null>(null);
  // Kept beside the catalog so choosing a model does not need another IPC round trip.
  const overridesRef = useRef<Record<string, OmpModelOverride>>({});
  // True when the session-change effect already painted something usable, so a
  // refresh must stay invisible instead of flipping the menu into `loading`.
  const paintedRef = useRef(false);
  // The menu starts its attach when it opens; a click on a warm row must wait
  // for that attach, because `set_model` needs a live engine process.
  const loadPromiseRef = useRef<Promise<boolean> | null>(null);
  // Rapid reopen-close-reopen cycles fire overlapping loads; only the newest
  // answer may paint, otherwise a slow cold start lands last and wins.
  const loadSeqRef = useRef(0);
  // Mirrors the painted ladder for loads that run before React flushed state.
  const thinkingLevelsRef = useRef<OmpThinkingLevel[]>([]);

  const hydrate = useCallback((cached: PickerCache) => {
    setModel(cached.model);
    setModels(cached.models);
    setThinkingLevels(cached.thinkingLevels);
    thinkingLevelsRef.current = cached.thinkingLevels;
    setThinkingLevel(cached.thinkingLevel);
    setFastMode(cached.fastMode);
    setSlowMode(cached.slowMode);
    setSlowModeSupported(cached.slowModeSupported);
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    const seq = ++loadSeqRef.current;
    const cached = pickerCache.get(cacheKey);
    if (cached) hydrate(cached);
    // A warm paint (session cache or persisted catalog) stays on screen while
    // the engine cold-starts and re-discovers providers.
    const needsSpinner = !cached && !paintedRef.current;
    if (needsSpinner) setLoading(true);
    setError(null);
    try {
      const attached = await api.attachOmpRpc({ sessionId: rpcSessionId, skipMessages: true });
      if (loadSeqRef.current !== seq) return false;
      const state = attached.state as { model?: OmpModel; thinkingLevel?: OmpThinkingLevel; fastModeEnabled?: boolean; slowModeEnabled?: boolean; slowModeSupported?: boolean } | null;
      // A cold or restarting engine answers with a null state. Adopting that
      // repainted the menu without thinking levels or the slow-mode toggle, so
      // only a live state may replace what the user already sees.
      const liveState = draft ? null : state;
      if (liveState) {
        setModel(liveState.model ?? null);
        setThinkingLevel(liveState.thinkingLevel ?? null);
        setFastMode(liveState.fastModeEnabled === true);
        setSlowMode(liveState.slowModeEnabled === true);
        setSlowModeSupported(liveState.slowModeSupported === true);
        writeStoredModel(cacheKey, liveState.model ?? null);
      }
      // The catalog read restarts the engine process when a login or a custom
      // model changed provider config after this session booted, so it has to
      // finish before anything else targets the same child process.
      const result = await api.ompRpcCommand({ sessionId: rpcSessionId, command: "get_available_models" }) as { data?: { models?: OmpModel[] } };
      const [levels, visibility, overrideState, customModelState] = await Promise.all([
        api.ompRpcCommand({ sessionId: rpcSessionId, command: "get_available_thinking_levels" }) as Promise<{ data?: { levels?: OmpThinkingLevel[] } }>,
        api.getOmpHiddenModels(),
        api.getOmpModelOverrides(),
        api.getOmpCustomModels().catch(() => ({ providers: [] })),
      ]);
      const hidden = new Set(visibility.hiddenModels);
      const overrides = overrideState.overrides ?? {};
      overridesRef.current = overrides;
      const namedModels = mapOmpProviderDisplayNames(
        Array.isArray(result.data?.models) ? result.data.models : [],
        customModelState.providers,
      );
      const nextModels = namedModels
        .filter((candidate) => !hidden.has(modelVisibilityKey(candidate.provider, candidate.id)))
        // Model aliases and provider names from Settings are the user-facing labels;
        // their OMP IDs remain untouched for selection and RPC identity.
        .map((candidate) => {
          const displayName = overrides[modelVisibilityKey(candidate.provider, candidate.id)]?.displayName;
          return displayName ? { ...candidate, name: displayName } : candidate;
        });
      const reportedLevels = Array.isArray(levels.data?.levels) ? levels.data.levels : [];
      if (loadSeqRef.current !== seq) return false;
      // Preserve a warm ladder on transient empty reconnects, but never carry
      // another model's capabilities across a confirmed model change.
      const cachedModel = cached?.model ?? readStoredModel(cacheKey);
      const modelChanged = Boolean(liveState?.model) && (
        cachedModel?.provider !== liveState?.model?.provider || cachedModel?.id !== liveState?.model?.id
      );
      const nextLevels = (draft || state) && reportedLevels.length
        ? reportedLevels
        : !draft && liveState && modelChanged
          ? reportedLevels
          : thinkingLevelsRef.current;
      thinkingLevelsRef.current = nextLevels;
      setModels(nextModels);
      setThinkingLevels(nextLevels);
      writeStoredCatalog(nextModels, nextLevels);
      let draftModel: OmpModel | null = null;
      if (draft) {
        // A draft has no live turn; the engine's remembered pick is the honest
        // source for what the next conversation will start with.
        const remembered = await api.getOmpSelectedModel().catch(() => null);
        if (remembered) {
          draftModel = nextModels.find((candidate) => candidate.provider === remembered.provider && candidate.id === remembered.modelId)
            ?? { provider: remembered.provider, id: remembered.modelId };
          setModel(draftModel);
        } else {
          // No engine-side record: keep the chip's current pick (the last used
          // model) rather than blanking it back to the placeholder.
          draftModel = readStoredModel(cacheKey)
            ?? readLastUsedModel()
            ?? readRecentSessionModel()
            ?? readAnyStoredModel();
        }
      }
      const previousCache = pickerCache.get(cacheKey);
      pickerCache.set(cacheKey, {
        model: draft ? draftModel : liveState ? liveState.model ?? null : previousCache?.model ?? null,
        models: nextModels,
        thinkingLevels: nextLevels,
        thinkingLevel: draft ? null : liveState ? liveState.thinkingLevel ?? null : previousCache?.thinkingLevel ?? null,
        fastMode: draft ? false : liveState ? liveState.fastModeEnabled === true : previousCache?.fastMode ?? false,
        slowMode: draft ? false : liveState ? liveState.slowModeEnabled === true : previousCache?.slowMode ?? false,
        slowModeSupported: draft ? false : liveState ? liveState.slowModeSupported === true : previousCache?.slowModeSupported ?? false,
      });
      paintedRef.current = true;
      setRecovery(null);
      return true;
    } catch (cause) {
      setRecovery(readOmpModelRecovery(
        (cause as { code?: string } | null)?.code,
        (cause as { details?: unknown } | null)?.details,
      ));
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (needsSpinner) setLoading(false);
    }
  }, [cacheKey, draft, hydrate, rpcSessionId]);

  const patchCache = useCallback((patch: Partial<PickerCache>) => {
    const cached = pickerCache.get(cacheKey);
    if (cached) pickerCache.set(cacheKey, { ...cached, ...patch });
  }, [cacheKey]);

  // The chat error card asks this picker to open when the saved model died, so
  // the user can reach models outside the current session's candidate list.
  useEffect(() => {
    const openPicker = () => setOpen(true);
    window.addEventListener("pi:open-omp-model-picker", openPicker);
    return () => window.removeEventListener("pi:open-omp-model-picker", openPicker);
  }, []);

  useEffect(() => {
    setModelQuery("");
    setError(null);
    const cached = pickerCache.get(cacheKey);
    // A draft cache entry written while nothing was selected must not short
    // circuit the storage fallback below; otherwise the chip stays blank across
    // restarts even though a remembered model exists.
    if (cached && (!draft || cached.model)) {
      hydrate(cached);
      paintedRef.current = true;
      return;
    }
    // Paint the last catalog and this session's remembered model before the
    // engine cold-starts, so the chip and the menu are never blank for seconds.
    const storedCatalog = readStoredCatalog();
    // A fresh draft cache is empty, so the always-available last pick fills the
    // chip; without it the button reads "select a model" until it is opened.
    const storedModel = readStoredModel(cacheKey)
      ?? (draft ? readLastUsedModel() ?? readRecentSessionModel() ?? readAnyStoredModel() : null);
    setModel(storedModel);
    setModels(storedCatalog?.models ?? []);
    setThinkingLevels(storedCatalog?.thinkingLevels ?? []);
    thinkingLevelsRef.current = storedCatalog?.thinkingLevels ?? [];
    setThinkingLevel(null);
    setFastMode(false);
    setSlowMode(false);
    setSlowModeSupported(false);
    paintedRef.current = Boolean(storedModel) || (storedCatalog?.models.length ?? 0) > 0;
    if (!draft || storedModel) return;
    // The engine also keeps its own selected-model file; read it once on mount
    // so the label is right even before the menu has ever been opened.
    let cancelled = false;
    void api.getOmpSelectedModel()
      .then((remembered) => {
        if (cancelled || !remembered) return;
        const catalog = readStoredCatalog();
        const match = catalog?.models.find(
          (candidate) => candidate.provider === remembered.provider && candidate.id === remembered.modelId,
        );
        setModel(match ?? { provider: remembered.provider, id: remembered.modelId });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cacheKey, hydrate, draft]);

  const normalizedModelQuery = modelQuery.trim().toLocaleLowerCase();
  const filteredModels = filterOmpModelsBySearch(models, normalizedModelQuery);
  const searching = normalizedModelQuery.length > 0;

  // The native picker groups by source: one "recent" rail entry plus one per
  // provider, so a long catalog never turns into an endless single list.
  const sections = useMemo(() => {
    const providerGroups = groupOmpModelsByProvider(models);
    const recentModels = recent
      .map((entry) => models.find((candidate) => candidate.provider === entry.provider && candidate.id === entry.id))
      .filter((candidate): candidate is OmpModel => Boolean(candidate));
    return [
      { id: "recent", kind: "recent" as const, provider: "", label: t("chat.recentModels"), models: recentModels },
      ...providerGroups.map(({ provider, displayName, models: providerModels }) => ({
        id: `provider:${provider}`,
        kind: "provider" as const,
        provider,
        label: displayName,
        models: providerModels,
      })),
    ];
  }, [models, recent, t]);

  const currentSection = sections.find((section) => section.id === activeSection)
    ?? sections.find((section) => section.models.length > 0)
    ?? sections[0];

  // Search spans every source like the native picker: matching rows are shown
  // grouped by provider instead of hiding what the rail is not pointing at.
  const paneGroups = useMemo(() => {
    if (!searching) {
      return currentSection ? [{
        provider: currentSection.provider,
        displayName: currentSection.kind === "provider" ? currentSection.label : "",
        models: currentSection.models,
      }] : [];
    }
    return groupOmpModelsByProvider(filteredModels);
  }, [currentSection, filteredModels, searching]);

  const paneEmpty = paneGroups.every((group) => group.models.length === 0);
  const railIndex = Math.max(sections.findIndex((section) => section.id === currentSection?.id), 0);
  // Matching counts keep the rail honest while a search narrows the catalog.
  const filteredSet = searching ? new Set(filteredModels) : null;
  const sectionMatchCount = (section: { models: OmpModel[] }) =>
    filteredSet ? section.models.filter((candidate) => filteredSet.has(candidate)).length : section.models.length;

  useEffect(() => {
    if (open) loadPromiseRef.current = load();
  }, [open, load]);

  // Native slash commands and OMP-side automations can change model settings
  // without going through this picker. Treat get_state as the authority and
  // refresh only after the corresponding OMP notification arrives.
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: number | undefined;
    let refreshing = false;
    let refreshAgain = false;
    const refreshState = async () => {
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        const result = await api.ompRpcCommand({ sessionId, command: "get_state" }) as { data?: { model?: OmpModel | null; thinkingLevel?: OmpThinkingLevel | null; fastModeEnabled?: boolean; slowModeEnabled?: boolean; slowModeSupported?: boolean } };
        if (disposed || useAppStore.getState().activeSessionId !== sessionId) return;
        // A reconnect can answer without data; blanking modes on that would
        // drop the slow-mode toggle for no real reason.
        if (!result.data) return;
        const state = result.data;
        const nextModel = state.model ?? null;
        const cachedModel = pickerCache.get(cacheKey)?.model ?? null;
        const modelChanged = Boolean(nextModel) && (
          cachedModel?.provider !== nextModel?.provider || cachedModel?.id !== nextModel?.id
        );
        setModel(nextModel);
        setThinkingLevel(state.thinkingLevel ?? null);
        setFastMode(state.fastModeEnabled === true);
        setSlowMode(state.slowModeEnabled === true);
        setSlowModeSupported(state.slowModeSupported === true);
        if (nextModel) writeStoredModel(cacheKey, nextModel);
        patchCache({
          model: nextModel,
          thinkingLevel: state.thinkingLevel ?? null,
          fastMode: state.fastModeEnabled === true,
          slowMode: state.slowModeEnabled === true,
          slowModeSupported: state.slowModeSupported === true,
        });
        if (modelChanged) {
          const catalogModels = pickerCache.get(cacheKey)?.models ?? readStoredCatalog()?.models ?? [];
          thinkingLevelsRef.current = [];
          setThinkingLevels([]);
          patchCache({ thinkingLevels: [] });
          writeStoredCatalog(catalogModels, []);
          const levels = await readOmpThinkingLevels({ rpcCommand: api.ompRpcCommand, sessionId });
          if (disposed || useAppStore.getState().activeSessionId !== sessionId) return;
          thinkingLevelsRef.current = levels;
          setThinkingLevels(levels);
          patchCache({ thinkingLevels: levels });
          writeStoredCatalog(catalogModels, levels);
        }
      } catch {
        // A state refresh must not interrupt typing or surface transient RPC
        // reconnect errors as a failed model-selection operation.
      } finally {
        refreshing = false;
        if (refreshAgain && !disposed) { refreshAgain = false; void refreshState(); }
      }
    };
    const unsubscribe = api.onOmpRpcEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.frame.type !== "model_changed" && event.frame.type !== "thinking_level_changed" && event.frame.type !== "config_update") return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = undefined; void refreshState(); }, 40);
    });
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [cacheKey, patchCache, sessionId]);

  /**
   * Reopen the conversation on a replacement model. This path exists because a
   * dead saved model makes `attach` itself fail, so `set_model` is unreachable
   * until the native session has been reopened with an explicit pair.
   */
  const reopenWithCandidate = async (candidate: OmpRecoveryCandidate) => {
    setLoading(true);
    try {
      const identity = toOmpRpcModelIdentity(candidate);
      await api.reopenOmpRpcWithModel({ sessionId: rpcSessionId, ...identity });
      setRecovery(null);
      setError(null);
      setModel(candidate);
      writeStoredModel(cacheKey, candidate);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const choose = async (candidate: OmpModel) => {
    // Moving a live conversation to another vendor sends its context there;
    // that is a decision the user must confirm explicitly.
    if (!draft && model && candidate.provider !== model.provider) {
      if (!window.confirm(t("errors.crossProviderConfirm", { provider: ompProviderDisplayName(candidate) }))) return;
    }
    setLoading(true);
    try {
      await loadPromiseRef.current?.catch(() => false);
      let nextThinkingLevels = thinkingLevels;
      let nextThinkingLevel = thinkingLevel;
      await selectOmpModelAndRefreshThinkingLevels({
        rpcCommand: api.ompRpcCommand,
        sessionId: rpcSessionId,
        ...toOmpRpcModelIdentity(candidate),
        onModelApplied: () => {
          setModel(candidate);
          writeStoredModel(cacheKey, candidate);
          nextThinkingLevels = [];
          nextThinkingLevel = null;
          thinkingLevelsRef.current = [];
          setThinkingLevels([]);
          setThinkingLevel(null);
          patchCache({ model: candidate, thinkingLevel: null, thinkingLevels: [] });
          writeStoredCatalog(models, []);
        },
        onThinkingLevels: (levels) => {
          nextThinkingLevels = levels;
          thinkingLevelsRef.current = levels;
          setThinkingLevels(levels);
          patchCache({ thinkingLevels: levels });
          writeStoredCatalog(models, levels);
        },
      });
      const nextRecent = [
        { provider: candidate.provider, id: candidate.id },
        ...recent.filter((entry) => !(entry.provider === candidate.provider && entry.id === candidate.id)),
      ].slice(0, RECENT_LIMIT);
      setRecent(nextRecent);
      writeRecentModels(nextRecent);
      if (!draft) {
        const refreshed = await api.ompRpcCommand({ sessionId: rpcSessionId, command: "get_state" }) as {
          data?: {
            thinkingLevel?: OmpThinkingLevel | null;
            slowModeEnabled?: boolean;
            slowModeSupported?: boolean;
          };
        };
        const nativeState = refreshed.data;
        if (nativeState) {
          nextThinkingLevel = nativeState.thinkingLevel ?? null;
          setThinkingLevel(nextThinkingLevel);
          setSlowMode(nativeState.slowModeEnabled === true);
          setSlowModeSupported(nativeState.slowModeSupported === true);
          patchCache({
            thinkingLevel: nextThinkingLevel,
            slowMode: nativeState.slowModeEnabled === true,
            slowModeSupported: nativeState.slowModeSupported === true,
          });
        }
      }
      // A model-level default thinking level is applied right after switching,
      // so the next turn uses what the settings page promised. A draft has no
      // live turn yet, so the engine picks its default when the chat starts.
      const preferred = overridesRef.current[modelVisibilityKey(candidate.provider, candidate.id)]?.defaultThinkingLevel;
      if (!draft && preferred && nextThinkingLevels.includes(preferred) && preferred !== nextThinkingLevel) {
        await api.ompRpcCommand({ sessionId: rpcSessionId, command: "set_thinking_level", fields: { level: preferred } });
        setThinkingLevel(preferred);
        patchCache({ thinkingLevel: preferred });
      }
      // Keep the menu open after a pick: the user often wants to set the
      // reasoning level right after, and reopening the picker was making that
      // a two-step dance. The menu closes when the click lands outside it.
    } catch (cause) {
      if ((cause as { code?: string } | null)?.code === "MODEL_UNAVAILABLE") {
        // The engine refused to restore the old model before `set_model` could
        // run. Reopening with the picked pair applies it in one step.
        await reopenWithCandidate(candidate);
        return;
      }
      setRecovery(readOmpModelRecovery(
        (cause as { code?: string } | null)?.code,
        (cause as { details?: unknown } | null)?.details,
      ));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    if (event.target instanceof HTMLInputElement) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  };

  const chooseThinking = async (level: OmpThinkingLevel) => {
    if (!sessionId) return;
    setLoading(true);
    try {
      await api.ompRpcCommand({ sessionId, command: "set_thinking_level", fields: { level } });
      setThinkingLevel(level);
      patchCache({ thinkingLevel: level });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  };

  const toggleFastMode = async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const next = !fastMode;
      await api.ompRpcCommand({ sessionId, command: "set_fast_mode", fields: { enabled: next } });
      setFastMode(next);
      patchCache({ fastMode: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  };

  const toggleSlowMode = async () => {
    if (!sessionId || !slowModeSupported) return;
    setLoading(true);
    try {
      const next = !slowMode;
      await api.ompRpcCommand({ sessionId, command: "set_slow_mode", fields: { enabled: next } });
      setSlowMode(next);
      patchCache({ slowMode: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  };

  // Last-resort label: storage is the only source a stale null cache entry, a
  // mis-detected draft or a skipped mount effect cannot shadow.
  const displayedModel = model ?? readLastUsedModel() ?? readRecentSessionModel() ?? readAnyStoredModel();
  const label = displayedModel ? displayedModel.name || displayedModel.id : t("settings.omp.modelNotSelected");
  return (
    <AnchoredMenu
      className="composer-omp-model"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName={`composer-mode-menu composer-omp-model-menu ${sections.length > 1 ? "has-rail" : ""}`}
      label={t("settings.omp.model")}
      role="menu"
      align="end"
      side="top"
      onMenuKeyDown={onKeyDown}
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`icon-btn composer-model-chip${open ? " active" : ""}`}
          tooltip={`${t("settings.omp.model")}: ${label}`}
          ariaLabel={`${t("settings.omp.model")}: ${label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={controlsBlocked}
          onClick={() => { onCloseOtherMenus(); setOpen((value) => !value); }}
        >
          <IconBot size={13} aria-hidden="true" />
          <span>{label}</span>
          <IconChevronDown size={11} aria-hidden="true" />
        </TooltipButton>
      )}
    >
      <label className="composer-model-search">
        <IconSearch size={14} aria-hidden="true" />
        <span className="sr-only">{t("settings.omp.modelSearchPlaceholder")}</span>
        <input
          type="search"
          value={modelQuery}
          placeholder={t("settings.omp.modelSearchPlaceholder")}
          aria-label={t("settings.omp.modelSearchPlaceholder")}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoFocus={open}
          onChange={(event) => setModelQuery(event.currentTarget.value)}
        />
        {modelQuery ? (
          <button
            type="button"
            className="composer-model-search-clear"
            aria-label={t("settings.clearSearch")}
            // Keep focus in the field so typing continues after the clear.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setModelQuery("")}
          >
            <IconX size={11} aria-hidden="true" />
          </button>
        ) : null}
      </label>
      {!loading && models.length === 0 && !error ? <div className="composer-menu-hint" role="status">{t("settings.omp.noModels")}</div> : null}
      {error ? <div className="composer-menu-hint" role="alert">{error}</div> : null}
      {recovery?.candidates.length ? (
        <div className="composer-menu-hint" role="group" aria-label={t("errors.MODEL_UNAVAILABLE")}>
          <span>{t("errors.MODEL_UNAVAILABLE")}</span>
          <div className="composer-model-recovery-actions">
            {recovery.candidates.slice(0, 5).map((candidate) => (
              <button
                key={`${candidate.provider}:${candidate.id}`}
                type="button"
                onClick={() => void reopenWithCandidate(candidate)}
              >
                {t("errors.action.useCandidate", { model: candidate.name || candidate.id })}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div
        className="composer-model-body"
        data-rail={sections.length > 1 ? "true" : undefined}
      >
        {sections.length > 1 ? (
          <div className="composer-model-rail" role="group" aria-label={t("chat.modelSources")}>
            <span
              className="composer-model-rail-indicator"
              aria-hidden="true"
              style={{ "--rail-index": railIndex } as CSSProperties}
            />
            {sections.map((section) => {
              const current = section.id === currentSection?.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  title={section.label}
                  data-empty={searching && sectionMatchCount(section) === 0 ? "true" : undefined}
                  className={`composer-model-rail-item ${current ? "active" : ""}`}
                  onClick={() => setActiveSection(section.id)}
                >
                  <span className="composer-model-rail-label">{section.label}</span>
                  {section.kind === "provider" ? (
                    <span className="composer-model-rail-count">{sectionMatchCount(section)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="composer-model-list">
          <div key={searching ? "search" : currentSection?.id ?? "empty"} className="composer-model-pane">
            {loading && models.length === 0 ? (
              <div className="composer-model-empty" role="status">{t("settings.omp.modelsLoading")}</div>
            ) : null}
            {paneGroups.map((group) => (
              <div key={group.provider || "recent"} className="composer-model-group" role="group" aria-label={group.displayName || undefined}>
                {searching && group.displayName ? <div className="composer-model-group-label">{group.displayName}</div> : null}
                {group.models.map((candidate) => {
                  const selected = model?.provider === candidate.provider && model?.id === candidate.id;
                  // One dense line per model: the rail already names the source,
                  // so repeating it under every row only wasted vertical space.
                  return (
                    <button
                      key={`${candidate.provider}/${candidate.id}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      title={`${ompProviderDisplayName(candidate)} · ${candidate.id}`}
                      className={`composer-plus-item ${selected ? "active" : ""}`}
                      disabled={loading}
                      onClick={() => void choose(candidate)}
                    >
                      <span className="composer-agent-engine-option-title">{candidate.name || candidate.id}</span>
                      {selected ? <IconCheck size={13} /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
            {!loading && paneEmpty ? (
              <div className="composer-model-empty" role="status">
                {searching ? t("settings.omp.noModelsMatch", { query: modelQuery.trim() }) : t("settings.omp.noModels")}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {!draft && thinkingLevels.length ? <>
        <div className="composer-plus-sep" role="separator" />
        <div className="composer-omp-quick-row">
          <span className="composer-omp-quick-label">{t("settings.omp.thinkingEffort")}</span>
          <div className="composer-omp-thinking-options" role="group" aria-label={t("settings.omp.thinkingEffort")}>
            {thinkingLevels.map((level) => <button key={level} type="button" aria-pressed={thinkingLevel === level} disabled={loading} onClick={() => void chooseThinking(level)}>{level}</button>)}
          </div>
        </div>
        <div className="composer-omp-quick-row">
          <span className="composer-omp-quick-label">{t("settings.omp.modes")}</span>
          <div className="composer-omp-thinking-options" role="group" aria-label={t("settings.omp.modes")}>
            <button type="button" aria-pressed={fastMode} disabled={loading} onClick={() => void toggleFastMode()}>{t("settings.omp.fastMode")}</button>
            {slowModeSupported ? <button type="button" aria-pressed={slowMode} disabled={loading} onClick={() => void toggleSlowMode()}>{t("settings.omp.slowMode")}</button> : null}
          </div>
        </div>
      </> : null}
      <button type="button" className="composer-omp-manage" role="menuitem" onClick={() => { setOpen(false); setSettingsTab("agentEngines"); setPage("settings"); }}>
        {t("settings.omp.manageProviders")}
      </button>
    </AnchoredMenu>
  );
}
