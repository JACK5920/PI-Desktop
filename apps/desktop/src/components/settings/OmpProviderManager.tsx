import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { OMP_SETTINGS_RPC_SESSION_ID } from "@pi-desktop/shared";
import { api, ompModelOverrideKey, type OmpModelOverride } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { OmpRpcInteraction } from "../OmpRpcInteraction";
import { Button, Input, SegmentedControl, TooltipButton } from "../ui";
import { IconSliders } from "../icons";
import { SettingsCard } from "../../features/settings/primitives";
import { createOmpManagementSession } from "./omp-management-session.mjs";
import { OmpModelSettingsDialog } from "./OmpModelSettingsDialog";

type OmpModel = { provider: string; id: string; name?: string; contextWindow?: number };
type LoginProvider = { id: string; name: string; available: boolean; authenticated: boolean };
type LogoutAccount = { credentialId: number; provider: string; label: string };

const ompManagementSession = createOmpManagementSession({
  attach: () => api.attachOmpRpc({ sessionId: OMP_SETTINGS_RPC_SESSION_ID }),
  stop: async () => { await api.stopOmpManagement().catch(() => undefined); },
});

const PROVIDER_PREVIEW_LIMIT = 8;

function ompModelVisibilityKey(provider: string, modelId: string): string {
  return `${encodeURIComponent(provider)}::${encodeURIComponent(modelId)}`;
}

/** Two-letter monogram keeps the provider list scannable without brand assets. */
function providerInitials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0]).join("");
  return (initials || name.slice(0, 1) || "?").toUpperCase();
}

export function OmpProviderManager() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [providers, setProviders] = useState<LoginProvider[]>([]);
  const [models, setModels] = useState<OmpModel[]>([]);
  const [hiddenModels, setHiddenModels] = useState<string[]>([]);
  const [providerQuery, setProviderQuery] = useState("");
  const [providersExpanded, setProvidersExpanded] = useState(false);
  const [tab, setTab] = useState<"providers" | "models">("providers");
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState("");
  const [accounts, setAccounts] = useState<{ providerId: string; items: LogoutAccount[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  // A pending login prompt must block new logins, otherwise two flows overwrite
  // each other's code prompt and neither can be finished.
  const [authPromptPending, setAuthPromptPending] = useState(false);
  const [authPromptReset, setAuthPromptReset] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, OmpModelOverride>>({});
  const [overrideTarget, setOverrideTarget] = useState<OmpModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hiddenRef = useRef<string[]>([]);
  const visibilityQueue = useRef<Promise<void>>(Promise.resolve());

  const refresh = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const { auth, available, visibility, overrides } = await ompManagementSession.run(async () => {
        const [auth, available, visibility, overrides] = await Promise.all([
          api.ompRpcCommand({ sessionId: OMP_SETTINGS_RPC_SESSION_ID, command: "get_login_providers" }) as Promise<{ data?: { providers?: LoginProvider[] } }>,
          api.ompRpcCommand({ sessionId: OMP_SETTINGS_RPC_SESSION_ID, command: "get_available_models" }) as Promise<{ data?: { models?: OmpModel[] } }>,
          api.getOmpHiddenModels(),
          api.getOmpModelOverrides(),
        ]);
        return { auth, available, visibility, overrides };
      });
      setProviders(Array.isArray(auth.data?.providers) ? auth.data.providers : []);
      setModels(Array.isArray(available.data?.models) ? available.data.models : []);
      hiddenRef.current = visibility.hiddenModels;
      setHiddenModels(visibility.hiddenModels);
      setOverrides(overrides.overrides ?? {});
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const modelKeys = useMemo(() => new Set(models.map((model) => ompModelVisibilityKey(model.provider, model.id))), [models]);
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    return models.filter((model) => `${model.name ?? ""} ${model.provider} ${model.id}`.toLocaleLowerCase().includes(query));
  }, [models, modelQuery]);
  const visibleProviders = providers.filter((provider) => `${provider.name} ${provider.id}`.toLocaleLowerCase().includes(providerQuery.trim().toLocaleLowerCase()));
  // Signed-in providers first, so the collapsed preview always includes them.
  const orderedProviders = useMemo(
    () => [...visibleProviders].sort((left, right) => Number(right.authenticated) - Number(left.authenticated) || left.name.localeCompare(right.name)),
    [visibleProviders],
  );
  const shownProviders = providersExpanded || providerQuery.trim() ? orderedProviders : orderedProviders.slice(0, PROVIDER_PREVIEW_LIMIT);
  const modelGroups = useMemo(() => {
    const labels = new Map(providers.map((provider) => [provider.id, provider.name]));
    const groups = new Map<string, OmpModel[]>();
    for (const model of visibleModels) {
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return [...groups.entries()]
      .map(([provider, items]) => ({
        provider,
        label: labels.get(provider) ?? provider,
        models: [...items].sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id)),
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [providers, visibleModels]);

  const saveHidden = async (next: string[]) => {
    const normalized = [...new Set(next)].sort();
    const previous = hiddenRef.current;
    hiddenRef.current = normalized;
    setHiddenModels(normalized);
    setVisibilitySaving(true);
    const operation = visibilityQueue.current.catch(() => undefined).then(async () => {
      const result = await api.setOmpHiddenModels(normalized);
      if (hiddenRef.current === normalized) {
        hiddenRef.current = result.hiddenModels;
        setHiddenModels(result.hiddenModels);
      }
    }).catch((cause) => {
      if (hiddenRef.current === normalized) {
        hiddenRef.current = previous;
        setHiddenModels(previous);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => setVisibilitySaving(false));
    visibilityQueue.current = operation;
    await operation;
  };

  const toggleModel = (model: OmpModel, show: boolean) => {
    const key = ompModelVisibilityKey(model.provider, model.id);
    const current = hiddenRef.current;
    void saveHidden(show ? current.filter((item) => item !== key) : [...current, key]);
  };

  const setAllVisible = (show: boolean) => {
    const current = hiddenRef.current;
    const next = show ? current.filter((key) => !modelKeys.has(key)) : [...new Set([...current, ...modelKeys])];
    void saveHidden(next);
  };

  const setGroupVisible = (groupModels: OmpModel[], show: boolean) => {
    const current = hiddenRef.current;
    const keys = new Set(groupModels.map((model) => ompModelVisibilityKey(model.provider, model.id)));
    void saveHidden(show ? current.filter((key) => !keys.has(key)) : [...new Set([...current, ...keys])]);
  };

  const login = async (provider: LoginProvider) => {
    if (!provider.available || busy) return;
    setBusyProvider(provider.id); setError(null);
    try {
      await ompManagementSession.run(() => api.ompRpcCommand({ sessionId: OMP_SETTINGS_RPC_SESSION_ID, command: "login", fields: { providerId: provider.id } }));
      await refresh();
      showToast(t("settings.omp.providerLoginSuccess", { provider: provider.name }), { variant: "success" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/unsupported_country_region_territory/i.test(message)) {
        // Upstream geo block: the browser finished OAuth but the engine's token
        // exchange used a different egress. Say what to fix instead of dumping JSON.
        setError(t("settings.omp.loginRegionBlocked"));
        showToast(t("settings.omp.loginRegionBlocked"), { variant: "error" });
      } else if (/cancel/i.test(message)) {
        // Dismissing the prompt is not an error state.
        setError(null);
      } else {
        setError(message);
        showToast(t("settings.omp.providerLoginFailed", { provider: provider.name, error: message }), { variant: "error" });
      }
    } finally {
      setBusyProvider(null);
      // Login can complete through the browser callback while the engine still
      // shows a code prompt; drop it once the command settles.
      setAuthPromptReset((value) => value + 1);
    }
  };

  const openAccounts = async (provider: LoginProvider) => {
    setBusyProvider(provider.id); setError(null);
    try {
      const result = await ompManagementSession.run(() => api.ompRpcCommand({ sessionId: OMP_SETTINGS_RPC_SESSION_ID, command: "get_logout_accounts", fields: { providerId: provider.id } })) as { data?: { accounts?: LogoutAccount[] } };
      setAccounts({ providerId: provider.id, items: Array.isArray(result.data?.accounts) ? result.data.accounts : [] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusyProvider(null); }
  };

  const logout = async (provider: LoginProvider, account: LogoutAccount) => {
    setBusyProvider(provider.id); setError(null);
    try {
      await ompManagementSession.run(() => api.ompRpcCommand({ sessionId: OMP_SETTINGS_RPC_SESSION_ID, command: "logout", fields: { providerId: provider.id, credentialId: account.credentialId } }));
      setAccounts(null); await refresh();
      showToast(t("settings.omp.providerLogoutSuccess", { account: account.label }), { variant: "success" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusyProvider(null); }
  };

  const hidden = new Set(hiddenModels);
  return <>
    <OmpRpcInteraction sessionId={OMP_SETTINGS_RPC_SESSION_ID} onPendingChange={setAuthPromptPending} resetSignal={authPromptReset} />
    <SettingsCard title={t("settings.omp.providersTitle")} description={t("settings.omp.providersDescription")} className="settings-stack">
      <>
        {error && <p role="alert" className="settings-error-text">{error}</p>}
        {busy && providers.length === 0 && models.length === 0 && <p role="status" className="settings-row-detail">{t("settings.omp.providersLoading")}</p>}
        <div className="settings-omp-toolbar">
          <SegmentedControl
            value={tab}
            onChange={setTab}
            label={t("settings.omp.providersTitle")}
            role="tablist"
            options={[
              { value: "providers" as const, label: <span className="settings-omp-tab-label">{t("settings.omp.tabProviders")}<span className="settings-omp-tab-count">{providers.length}</span></span> },
              { value: "models" as const, label: <span className="settings-omp-tab-label">{t("settings.omp.tabModels")}<span className="settings-omp-tab-count">{models.length}</span></span> },
            ]}
          />
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy || visibilitySaving}>{t("settings.omp.refresh")}</Button>
        </div>
        {tab === "providers" && <section className="settings-omp-provider-section" aria-label={t("settings.omp.loginProviders")}>
          <div className="settings-agent-engine-section-heading">
            <div><h4 className="settings-row-title">{t("settings.omp.loginProviders")}</h4><p className="settings-row-detail">{t("settings.omp.providerSummary", { total: providers.length, authed: providers.filter((provider) => provider.authenticated).length })}</p></div>
            <Input type="search" value={providerQuery} onChange={(event) => setProviderQuery(event.currentTarget.value)} placeholder={t("settings.omp.providerSearch")} aria-label={t("settings.omp.providerSearch")} />
          </div>
          {visibleProviders.length ? <>
            <div className="settings-omp-provider-list">
              {shownProviders.map((provider) => <div className="settings-omp-provider-row" key={provider.id}>
                <span className="settings-omp-provider-avatar" aria-hidden="true">{providerInitials(provider.name)}</span>
                <div className="settings-omp-provider-copy">
                  <strong>{provider.name}</strong>
                  <span className={`settings-omp-provider-state${provider.authenticated ? " is-on" : ""}${provider.available ? "" : " is-off"}`}>
                    {provider.authenticated ? t("settings.omp.providerAuthenticated") : provider.available ? t("settings.omp.providerNotAuthenticated") : t("settings.omp.providerUnavailable")}
                  </span>
                </div>
                {provider.authenticated
                  ? <Button variant="secondary" size="sm" disabled={busy || busyProvider !== null || authPromptPending} onClick={() => void openAccounts(provider)}>{t("settings.omp.providerManageAccount")}</Button>
                  : <Button size="sm" disabled={busy || busyProvider !== null || authPromptPending || !provider.available} onClick={() => void login(provider)}>{busyProvider === provider.id ? t("settings.omp.providerSigningIn") : t("settings.omp.providerSignIn")}</Button>}
                {accounts?.providerId === provider.id && <div className="settings-omp-account-list">
                  {accounts.items.length ? accounts.items.map((account) => <div key={`${account.provider}:${account.credentialId}`}><span>{account.label}</span><Button variant="ghost" size="sm" disabled={busyProvider !== null} onClick={() => void logout(provider, account)}>{t("settings.omp.providerSignOut")}</Button></div>) : <span>{t("settings.omp.providerNoAccounts")}</span>}
                </div>}
              </div>)}
            </div>
            {!providerQuery.trim() && orderedProviders.length > PROVIDER_PREVIEW_LIMIT && <Button variant="ghost" size="sm" className="settings-omp-provider-more" onClick={() => setProvidersExpanded((value) => !value)}>
              {providersExpanded ? t("settings.omp.providerCollapse") : t("settings.omp.providerShowAll", { count: orderedProviders.length - PROVIDER_PREVIEW_LIMIT })}
            </Button>}
          </> : <p className="settings-row-detail">{providers.length ? t("settings.omp.providersNoMatch") : t("settings.omp.providersNoLogin")}</p>}
        </section>}
        {tab === "models" && <section className="settings-omp-provider-section" aria-label={t("settings.omp.modelVisibility")}>
          <div className="settings-agent-engine-section-heading">
            <div><h4 className="settings-row-title">{t("settings.omp.modelVisibility")}</h4><p className="settings-row-detail">{t("settings.omp.modelVisibilitySummary", { visible: models.length - hiddenModels.filter((key) => modelKeys.has(key)).length, total: models.length })}</p></div>
            <div className="settings-agent-engine-actions settings-omp-model-toolbar"><Input type="search" value={modelQuery} onChange={(event) => setModelQuery(event.currentTarget.value)} placeholder={t("settings.omp.modelSearchPlaceholder")} aria-label={t("settings.omp.modelSearchPlaceholder")} /><Button variant="secondary" size="sm" disabled={!models.length || busy || visibilitySaving} onClick={() => setAllVisible(true)}>{t("settings.omp.showAllModels")}</Button><Button variant="ghost" size="sm" disabled={!models.length || busy || visibilitySaving} onClick={() => setAllVisible(false)}>{t("settings.omp.hideAllModels")}</Button></div>
          </div>
          {visibleModels.length ? <div className="settings-omp-model-groups">
            {modelGroups.map((group) => {
              const hiddenCount = group.models.filter((model) => hidden.has(ompModelVisibilityKey(model.provider, model.id))).length;
              const allShown = hiddenCount === 0;
              const collapsed = collapsedGroups.includes(group.provider);
              return <section className={`settings-omp-model-group${collapsed ? " is-collapsed" : ""}`} key={group.provider}>
                <header className="settings-omp-model-group-head">
                  <button
                    type="button"
                    className="settings-omp-model-group-toggle"
                    aria-expanded={!collapsed}
                    onClick={() => setCollapsedGroups((current) => collapsed ? current.filter((id) => id !== group.provider) : [...current, group.provider])}
                  >
                    <span className="settings-omp-chevron" aria-hidden="true" />
                    <span className="settings-omp-model-group-name">{group.label}</span>
                  </button>
                  <span className="settings-omp-model-group-count">{t("settings.omp.modelGroupCount", { visible: group.models.length - hiddenCount, total: group.models.length })}</span>
                  <Button variant="ghost" size="sm" disabled={busy || visibilitySaving} onClick={() => setGroupVisible(group.models, !allShown)}>{allShown ? t("settings.omp.hideAllModels") : t("settings.omp.showAllModels")}</Button>
                </header>
                {!collapsed && group.models.map((model) => {
                  const key = ompModelVisibilityKey(model.provider, model.id);
                  const shown = !hidden.has(key);
                  const override = overrides[ompModelOverrideKey(model.provider, model.id)];
                  const contextWindow = override?.contextWindow ?? model.contextWindow;
                  return <div className={`settings-omp-model-row${shown ? " is-shown" : ""}`} key={key}>
                    <label className="settings-omp-model-row-main">
                      <input type="checkbox" checked={shown} disabled={busy || visibilitySaving} onChange={(event) => toggleModel(model, event.currentTarget.checked)} />
                      <span className="settings-omp-model-name">{override?.displayName ?? model.name ?? model.id}</span>
                      <span className="settings-omp-model-meta">{model.id !== (model.name ?? "") ? `${model.id} · ` : ""}{contextWindow ? `${contextWindow.toLocaleString()} tokens` : ""}</span>
                    </label>
                    <TooltipButton
                      type="button"
                      className={`icon-btn settings-omp-model-configure${override ? " is-customized" : ""}`}
                      tooltip={t("settings.omp.modelSettingsTitle")}
                      ariaLabel={`${t("settings.omp.modelSettingsTitle")}: ${model.name ?? model.id}`}
                      onClick={() => setOverrideTarget(model)}
                    >
                      <IconSliders size={13} />
                    </TooltipButton>
                  </div>;
                })}
              </section>;
            })}
          </div> : <p className="settings-row-detail">{models.length ? t("settings.omp.modelsNoMatch") : t("settings.omp.noModels")}</p>}
        </section>}
        {overrideTarget ? <OmpModelSettingsDialog
          model={overrideTarget}
          providerLabel={providers.find((provider) => provider.id === overrideTarget.provider)?.name ?? overrideTarget.provider}
          override={overrides[ompModelOverrideKey(overrideTarget.provider, overrideTarget.id)]}
          onClose={() => setOverrideTarget(null)}
          onSaved={(next) => { setOverrides(next); showToast(t("settings.omp.modelSettingsSaved")); }}
        /> : null}
      </>
    </SettingsCard>
  </>;
}
