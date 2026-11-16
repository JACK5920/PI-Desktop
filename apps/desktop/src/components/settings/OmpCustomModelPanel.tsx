/**
 * The OMP custom-service editor.
 *
 * An OMP custom service is a provider row exactly like a native AI service:
 * one address, one credential, many models. The model picker is therefore the
 * native one — same discovery pane, same chosen list, same per-model advanced
 * settings — instead of a second, poorer implementation that drifts.
 *
 * Only the controls `models.json` can carry are persisted; the picker hides
 * the rest (`hiddenAdvanced`) so a toggle never disappears on save.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelBinding, ModelInfo } from "@pi-desktop/shared";
import {
  api,
  ompModelOverrideKey,
  type OmpCustomModelApiStyle,
  type OmpCustomModelEntry,
  type OmpCustomModelProvider,
  type OmpModelOverride,
} from "../../lib/api";
import { SettingsCard } from "../../features/settings/primitives";
import { Button } from "../ui";
import { ModelSelectionPanes, useModelSelection } from "./ModelSelectionPanes";
import type { ProviderModelsState } from "./useProviderModels";

type Draft = {
  providerName: string;
  baseUrl: string;
  api: OmpCustomModelApiStyle;
  auth: "apiKey" | "none";
  apiKey: string;
};

const PROTOCOL_LABEL: Record<OmpCustomModelApiStyle, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Generative AI",
};

/** The picker speaks the native transport names; map for its gating props. */
const NATIVE_STYLE: Record<OmpCustomModelApiStyle, string> = {
  "openai-completions": "chat_completions",
  "openai-responses": "responses",
  "anthropic-messages": "anthropic_messages",
  "google-generative-ai": "google_generative_ai",
};

const FETCH_DEBOUNCE_MS = 600;
const IDLE: ProviderModelsState = { status: "idle", models: [] };

const emptyDraft = (): Draft => ({
  providerName: "",
  baseUrl: "",
  api: "openai-completions",
  auth: "apiKey",
  apiKey: "",
});

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function toModelInfo(model: { id: string; name?: string; contextWindow?: number }): ModelInfo {
  return {
    modelId: model.id,
    displayName: model.name ?? model.id,
    providerId: "omp-custom",
    capabilities: ["text"],
    source: "discovered",
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    // `discoveryState` stays absent: the row is published by this endpoint.
    discoveryState: "published",
  };
}

/**
 * Normalize an IPC answer into provider rows.
 *
 * The renderer can outlive a main process that was built before services owned
 * several models; that build answers with flat one-model rows. Reading
 * `providers` there yields undefined and the list crashes on `.length`, so the
 * older shape is grouped instead of trusted.
 */
function normalizeProviders(raw: unknown): OmpCustomModelProvider[] {
  const record = raw && typeof raw === "object" ? raw as { providers?: unknown; models?: unknown } : {};
  const rows = Array.isArray(record.providers)
    ? record.providers
    : Array.isArray(record.models) ? record.models : [];
  // Both a correct `providers` answer and an older `models` answer can carry
  // provider rows; recognize them by their nested model list first.
  const providerRows = rows
    .filter((value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && Array.isArray((value as { models?: unknown }).models))
    .map((value) => {
      const provider = value as unknown as OmpCustomModelProvider;
      if (typeof provider.id !== "string" || typeof provider.providerId !== "string") return null;
      return { ...provider, models: Array.isArray(provider.models) ? provider.models : [] };
    })
    .filter((provider): provider is OmpCustomModelProvider => provider !== null);
  if (providerRows.length > 0) return providerRows;
  // Fall back to the pre-multi-model flat rows (one row per model).
  const byProvider = new Map<string, OmpCustomModelProvider>();
  for (const value of rows) {
    if (!value || typeof value !== "object") continue;
    const row = value as {
      providerId?: unknown; modelId?: unknown; providerName?: unknown; baseUrl?: unknown;
      api?: unknown; auth?: unknown; contextWindow?: unknown; maxTokens?: unknown;
      supportsImages?: unknown; configured?: unknown;
    };
    if (typeof row.providerId !== "string" || typeof row.modelId !== "string") continue;
    const known = byProvider.get(row.providerId);
    const entry: OmpCustomModelEntry = {
      id: row.modelId,
      contextWindow: Number(row.contextWindow) || 128_000,
      maxTokens: Number(row.maxTokens) || 8_192,
      supportsImages: row.supportsImages === true,
      thinkingLevels: [],
    };
    if (known) {
      known.models = [...known.models, entry];
      continue;
    }
    byProvider.set(row.providerId, {
      id: row.providerId.replace(/^pi_custom_/, ""),
      providerId: row.providerId,
      providerName: typeof row.providerName === "string" ? row.providerName : row.modelId,
      baseUrl: typeof row.baseUrl === "string" ? row.baseUrl : "",
      api: (row.api ?? "openai-completions") as OmpCustomModelApiStyle,
      auth: row.auth === "none" ? "none" : "apiKey",
      configured: row.configured === true,
      models: [entry],
    });
  }
  return [...byProvider.values()];
}

/** Rehydrate one saved model, letting the per-model dialog's edits win. */
function bindingFromEntry(
  entry: OmpCustomModelEntry,
  override: OmpModelOverride | undefined,
): ModelBinding {
  const alias = override?.displayName ?? entry.displayName;
  return {
    id: entry.id,
    ...(alias?.trim() ? { alias: alias.trim() } : {}),
    contextWindow: override?.contextWindow ?? entry.contextWindow,
    contextWindowSource: "user",
    maxTokens: override?.maxTokens ?? entry.maxTokens,
    maxTokensSource: "user",
    thinkingLevels: [...(entry.thinkingLevels ?? [])],
    defaultThinkingLevel: override?.defaultThinkingLevel ?? entry.defaultThinkingLevel ?? null,
    supportsImages: override?.supportsImages ?? entry.supportsImages,
    supportsDocuments: null,
    ...(typeof entry.supportsReasoningEffort === "boolean"
      ? { supportsReasoningEffort: entry.supportsReasoningEffort }
      : {}),
  };
}

export function OmpCustomModelPanel() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<OmpCustomModelProvider[]>([]);
  const [overrides, setOverrides] = useState<Record<string, OmpModelOverride>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [models, setModels] = useState<ModelBinding[]>([]);
  const [discovery, setDiscovery] = useState<ProviderModelsState>(IDLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  // Only the newest probe may paint: a slow answer for an older address must
  // never replace the list belonging to the URL now on screen.
  const probeSeq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [list, overrideState] = await Promise.all([
        api.getOmpCustomModels(),
        api.getOmpModelOverrides(),
      ]);
      setProviders(normalizeProviders(list));
      setOverrides(overrideState.overrides ?? {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const discoverable =
    formOpen &&
    isHttpUrl(draft.baseUrl) &&
    (draft.auth === "none" || Boolean(draft.apiKey.trim()) || Boolean(editingId));

  const probeNow = useCallback(async () => {
    const url = draft.baseUrl.trim();
    if (!isHttpUrl(url)) {
      setDiscovery(IDLE);
      return;
    }
    if (draft.auth === "apiKey" && !draft.apiKey.trim() && !editingId) {
      // Nothing to authenticate with yet; the pane explains it is empty.
      setDiscovery(IDLE);
      return;
    }
    const requestId = ++probeSeq.current;
    setDiscovery((previous) => ({ status: "loading", models: previous.models }));
    try {
      const result = await api.probeOmpCustomModels({
        baseUrl: url,
        api: draft.api,
        auth: draft.auth,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(editingId ? { id: editingId } : {}),
      });
      if (probeSeq.current !== requestId) return;
      const rows = result.models.map(toModelInfo);
      setDiscovery(rows.length > 0
        ? { status: "ready", models: rows, source: "remote" }
        : {
            status: "error",
            models: [],
            source: "remote",
            error: t("settings.omp.customModelFetchedEmpty"),
          });
    } catch (cause) {
      if (probeSeq.current !== requestId) return;
      setDiscovery({
        status: "error",
        models: [],
        source: "remote",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [draft, editingId, t]);

  // Typing an address or a key re-probes after a pause, exactly like the
  // native service form, so the list follows the connection being edited.
  useEffect(() => {
    if (!formOpen) {
      probeSeq.current += 1;
      setDiscovery(IDLE);
      return;
    }
    if (!isHttpUrl(draft.baseUrl)) {
      probeSeq.current += 1;
      setDiscovery(IDLE);
      return;
    }
    const timer = setTimeout(() => void probeNow(), FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [formOpen, draft.baseUrl, draft.api, draft.auth, draft.apiKey, probeNow]);

  const selection = useModelSelection(discovery, models, setModels);

  const startCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setModels([]);
    setDiscovery(IDLE);
    setFormOpen(true);
    setError(null);
    setNotice("");
  };

  const startEdit = (provider: OmpCustomModelProvider) => {
    setEditingId(provider.id);
    setDraft({
      providerName: provider.providerName,
      baseUrl: provider.baseUrl,
      api: provider.api,
      auth: provider.auth,
      apiKey: "",
    });
    setModels(provider.models.map((entry) =>
      bindingFromEntry(entry, overrides[ompModelOverrideKey(provider.providerId, entry.id)]),
    ));
    setDiscovery(IDLE);
    setFormOpen(true);
    setError(null);
    setNotice("");
  };

  const cancel = () => {
    setFormOpen(false);
    setEditingId(null);
    setDraft(emptyDraft());
    setModels([]);
    setDiscovery(IDLE);
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      // `bindingsToPersist` carries the explicit thinking selections, including
      // levels the catalog does not publish; saving `models` here would drop them.
      const persisted = selection.bindingsToPersist.map((binding) => ({
        id: binding.id,
        ...(binding.alias?.trim() ? { displayName: binding.alias.trim() } : {}),
        contextWindow: binding.contextWindow,
        // A discovered model's default output can exceed a small probed window;
        // models.json rejects that pair, so the saved pair is always coherent.
        maxTokens: Math.min(binding.maxTokens, binding.contextWindow),
        supportsImages: binding.supportsImages === true,
        ...(binding.thinkingLevels.length ? { thinkingLevels: [...binding.thinkingLevels] } : {}),
        ...(binding.defaultThinkingLevel && binding.defaultThinkingLevel !== "omit"
          ? { defaultThinkingLevel: binding.defaultThinkingLevel }
          : {}),
        ...(typeof binding.supportsReasoningEffort === "boolean"
          ? { supportsReasoningEffort: binding.supportsReasoningEffort }
          : {}),
      }));
      await api.saveOmpCustomModel({
        ...(editingId ? { id: editingId } : {}),
        providerName: draft.providerName.trim(),
        baseUrl: draft.baseUrl.trim(),
        api: draft.api,
        auth: draft.auth,
        models: persisted,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      });
      setDraft((old) => ({ ...old, apiKey: "" }));
      setFormOpen(false);
      setEditingId(null);
      setModels([]);
      setDiscovery(IDLE);
      setNotice(t("settings.omp.customModelSaved"));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: OmpCustomModelProvider) => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await api.deleteOmpCustomModel(provider.id);
      if (editingId === provider.id) cancel();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const canSave =
    !busy &&
    formOpen &&
    draft.providerName.trim().length > 0 &&
    isHttpUrl(draft.baseUrl) &&
    models.length > 0 &&
    (draft.auth === "none" || Boolean(draft.apiKey.trim()) || Boolean(editingId));

  return (
    <SettingsCard
      title={t("settings.omp.customModelTitle")}
      description={t("settings.omp.customModelDescription")}
      className="settings-stack"
    >
      <section className="settings-agent-engine-manager omp-custom-model" aria-labelledby="omp-custom-model-title">
        <div className="settings-agent-engine-section-heading">
          <div>
            <h4 id="omp-custom-model-title" className="settings-row-title">{t("settings.omp.customModelTitle")}</h4>
            <p className="settings-row-detail">{t("settings.omp.customModelDescription")}</p>
          </div>
          <Button size="sm" onClick={startCreate} disabled={busy || formOpen}>{t("settings.omp.customModelAdd")}</Button>
        </div>
        {error && <p role="alert" className="settings-error-text">{error}</p>}
        {notice && <p role="status" className="settings-row-detail">{notice}</p>}
        {providers.length === 0 && !formOpen
          ? <p className="settings-row-detail">{t("settings.omp.customModelEmpty")}</p>
          : providers.length > 0 && <ul className="omp-custom-model-list">
            {providers.map((provider) => (
              <li key={provider.id} className={`omp-custom-model-item${editingId === provider.id ? " is-editing" : ""}`}>
                <div className="omp-custom-model-copy">
                  <strong>{provider.providerName}</strong>
                  <span>
                    {t("settings.omp.customModelCount", { count: provider.models.length })} · {PROTOCOL_LABEL[provider.api]}
                  </span>
                  <small>{provider.baseUrl}</small>
                </div>
                <span className={`settings-agent-engine-state${provider.configured ? "" : " is-warning"}`}>
                  {provider.auth === "none"
                    ? t("settings.omp.customModelNoAuth")
                    : provider.configured ? t("settings.omp.customModelConfigured") : t("settings.omp.customModelKeyMissing")}
                </span>
                <div className="omp-custom-model-actions">
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => startEdit(provider)}>
                    {t("settings.omp.customModelEdit")}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(provider)}>
                    {t("settings.omp.customModelDelete")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>}

        {formOpen && <>
          <div className="settings-omp-custom-form">
            <div className="settings-omp-custom-grid">
              <label>
                <span>{t("settings.omp.customModelProvider")}</span>
                <input
                  value={draft.providerName}
                  maxLength={80}
                  placeholder="My Gateway"
                  onChange={(event) => setDraft({ ...draft, providerName: event.target.value })}
                />
              </label>
              <div className="settings-omp-custom-pair">
                <label>
                  <span>{t("settings.omp.customModelProtocol")}</span>
                  <select
                    value={draft.api}
                    onChange={(event) => setDraft({ ...draft, api: event.target.value as OmpCustomModelApiStyle })}
                  >
                    {Object.entries(PROTOCOL_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("settings.omp.customModelAuth")}</span>
                  <select
                    value={draft.auth}
                    onChange={(event) => setDraft({ ...draft, auth: event.target.value as Draft["auth"] })}
                  >
                    <option value="apiKey">{t("settings.omp.customModelAuthKey")}</option>
                    <option value="none">{t("settings.omp.customModelAuthNone")}</option>
                  </select>
                </label>
              </div>
              <label className="settings-omp-custom-wide">
                <span>{t("settings.omp.customModelBaseUrl")}</span>
                <input
                  type="url"
                  autoComplete="url"
                  placeholder="https://api.example.com/v1"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                />
              </label>
              {draft.auth === "apiKey" && (
                <label className="settings-omp-custom-wide">
                  <span>{t("settings.omp.customModelApiKey")}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={draft.apiKey}
                    placeholder={editingId ? t("settings.omp.customModelKeySaved") : "sk-…"}
                    onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  />
                </label>
              )}
            </div>
          </div>

          <ModelSelectionPanes
            discovery={{
              ...discovery,
              canReload: discoverable && discovery.status !== "loading",
            }}
            selection={selection}
            listTitle={t("settings.serviceModels")}
            busy={busy}
            onReload={() => void probeNow()}
            apiStyle={NATIVE_STYLE[draft.api]}
            hiddenAdvanced={["thinkingProtocol", "documents", "subagents", "nativeWebSearch", "fastMode"]}
          />
          {discovery.status === "error" && discovery.error && (
            <p role="alert" className="settings-error-text">{discovery.error}</p>
          )}

          <div className="settings-agent-engine-actions">
            <Button onClick={() => void save()} disabled={!canSave}>
              {busy ? t("settings.omp.customModelSaving") : t("settings.omp.customModelSave")}
            </Button>
            <Button variant="secondary" onClick={cancel} disabled={busy}>
              {t("settings.omp.customModelCancel")}
            </Button>
          </div>
        </>}
      </section>
    </SettingsCard>
  );
}
