import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, ComputerCapabilities, ComputerModelBinding, ProviderPublic } from "@pi-desktop/shared";
import { COMPUTER_USE_DEFAULTS } from "@pi-desktop/shared";
import { Badge, Input, SettingsToggle } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { ComputerUseModelPicker } from "./ComputerUseModelPicker";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "./primitives";

function bindingId(binding: ComputerModelBinding): string {
  return `${binding.providerId}\u0000${binding.modelId}`;
}

function modelBindings(providers: ProviderPublic[]): ComputerModelBinding[] {
  return providers.flatMap((provider) => {
    if (!provider.enabled || !provider.baseUrl) return [];
    const modelIds = provider.models?.map((model) => model.id).filter(Boolean) ?? [];
    const candidates = modelIds.length > 0 ? modelIds : provider.defaultModelId ? [provider.defaultModelId] : [];
    return [...new Set(candidates)].map((modelId) => ({ providerId: provider.id, modelId }));
  });
}

function capabilityLabel(t: (key: string) => string, capabilities: ComputerCapabilities | null): string {
  if (!capabilities) return t("settings.computerUseStatusUnknown");
  if (capabilities.backend === "unsupported" || capabilities.fidelity === "none") {
    return t("settings.computerUseUnsupported");
  }
  if (capabilities.accessibility === "denied") return t("settings.computerUsePermissionDenied");
  if (capabilities.accessibility === "not-requested") return t("settings.computerUsePermissionNeeded");
  return t("settings.computerUseReady");
}

function capabilityTone(capabilities: ComputerCapabilities | null): "neutral" | "success" | "error" | "warning" {
  if (!capabilities || capabilities.backend === "unsupported" || capabilities.fidelity === "none") return "neutral";
  if (capabilities.accessibility === "denied") return "error";
  if (capabilities.accessibility === "not-requested") return "warning";
  return "success";
}

export function ComputerUseSettingsSection({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const computerUse = settings.computerUse ?? { enabled: false };
  const restrictions = computerUse.restrictions ?? {};
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [capabilities, setCapabilities] = useState<ComputerCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionBudgetDraft, setActionBudgetDraft] = useState(String(computerUse.actionBudget ?? COMPUTER_USE_DEFAULTS.actionBudget));
  const [idleMinutesDraft, setIdleMinutesDraft] = useState(String(Math.round((computerUse.idleExpiryMs ?? COMPUTER_USE_DEFAULTS.idleExpiryMs) / 60_000)));
  const availableBindings = useMemo(() => modelBindings(providers), [providers]);
  const currentBinding = computerUse.model ?? null;
  const selectedBinding = currentBinding && availableBindings.some((item) => bindingId(item) === bindingId(currentBinding))
    ? bindingId(currentBinding)
    : "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([api.listProviders(), api.computerCapabilities()])
      .then(([providerResult, nextCapabilities]) => {
        if (cancelled) return;
        setProviders(providerResult.providers);
        setCapabilities(nextCapabilities);
      })
      .catch(() => {
        if (!cancelled) showToast(t("settings.computerUseLoadFailed"), { variant: "error" });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [showToast, t]);

  useEffect(() => {
    setActionBudgetDraft(String(computerUse.actionBudget ?? COMPUTER_USE_DEFAULTS.actionBudget));
    setIdleMinutesDraft(String(Math.round((computerUse.idleExpiryMs ?? COMPUTER_USE_DEFAULTS.idleExpiryMs) / 60_000)));
  }, [computerUse.actionBudget, computerUse.idleExpiryMs]);

  const saveComputerUse = async (patch: Partial<typeof computerUse>) => {
    setBusy(true);
    try {
      await saveSettings({ computerUse: { ...computerUse, ...patch } });
    } catch {
      showToast(t("settings.computerUseSaveFailed"), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const saveRestrictions = (patch: NonNullable<typeof computerUse.restrictions>) => {
    void saveComputerUse({ restrictions: { ...restrictions, ...patch } });
  };

  const saveLimits = async () => {
    const actionBudget = Number(actionBudgetDraft);
    const idleMinutes = Number(idleMinutesDraft);
    const idleExpiryMs = idleMinutes * 60_000;
    if (!Number.isSafeInteger(actionBudget) || actionBudget < 1) return;
    if (!Number.isSafeInteger(idleMinutes) || idleMinutes < 1 || !Number.isSafeInteger(idleExpiryMs)) return;
    await saveComputerUse({ actionBudget, idleExpiryMs });
  };

  return (
    <SettingsCard title={t("settings.computerUseTitle")}>
      <SettingsRow title={t("settings.computerUseEnabled")}>
        <SettingsToggle
          checked={computerUse.enabled}
          label={t("settings.computerUseEnabled")}
          disabled={busy || loading}
          onChange={() => void saveComputerUse({ enabled: !computerUse.enabled })}
        />
      </SettingsRow>
      <SettingsRow title={t("settings.computerUseModel")}>
        <ComputerUseModelPicker
          providers={providers}
          value={selectedBinding}
          disabled={busy || loading}
          onChange={(value) => {
            const next = availableBindings.find((item) => bindingId(item) === value);
            void saveComputerUse({ model: next ?? null });
          }}
        />
        <p className="computer-use-settings-notice">{t("settings.computerUseCaptureDescription")}</p>
      </SettingsRow>
      {!selectedBinding && computerUse.enabled ? (
        <p className="computer-use-settings-notice" role="status">{t("settings.computerUseModelRequired")}</p>
      ) : null}
      <SettingsRow title={t("settings.computerUseCapture")}>
        <SettingsMenuSelect
          label={t("settings.computerUseCapture")}
          value={computerUse.defaultCapture ?? "a11y-only"}
          busy={busy || loading}
          options={[
            { id: "a11y-only", label: t("settings.computerUseAccessibilityOnly") },
            { id: "a11y-and-pixels", label: t("settings.computerUseAccessibilityAndPixels") },
          ]}
          onChange={(value) => {
            if (value === "a11y-only" || value === "a11y-and-pixels") {
              void saveComputerUse({ defaultCapture: value });
            }
          }}
        />
      </SettingsRow>
      <SettingsRow title={t("settings.computerUseRestrictions")}>
        <div className="computer-use-settings-restrictions">
          <div className="computer-use-settings-restriction-row">
            <SettingsToggle
              checked={restrictions.disableAll ?? false}
              label={t("settings.computerUseDisableAllRestrictions")}
              disabled={busy || loading}
              onChange={() => saveRestrictions({ disableAll: !(restrictions.disableAll ?? false) })}
            />
            <span>{t("settings.computerUseDisableAllRestrictions")}</span>
          </div>
          <p className="computer-use-settings-notice">{t("settings.computerUseDisableAllRestrictionsDescription")}</p>
          {([
            ["blockSelfTarget", "computerUseBlockSelfTarget"],
            ["blockSecureInput", "computerUseBlockSecureInput"],
            ["enforceDenylist", "computerUseEnforceDenylist"],
            ["blockElevatedTargets", "computerUseBlockElevatedTargets"],
          ] as const).map(([key, labelKey]) => (
            <div className="computer-use-settings-restriction-row" key={key}>
              <SettingsToggle
                checked={restrictions[key] ?? true}
                label={t(`settings.${labelKey}`)}
                disabled={busy || loading || (restrictions.disableAll ?? false)}
                onChange={() => saveRestrictions({ [key]: !(restrictions[key] ?? true) })}
              />
              <span>{t(`settings.${labelKey}`)}</span>
            </div>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow title={t("settings.computerUseLimits")}>
        <div className="computer-use-settings-limits">
          <label>
            <span>{t("settings.computerUseActionBudget")}</span>
            <Input aria-label={t("settings.computerUseActionBudget")} type="number" min={1} step={1} value={actionBudgetDraft} disabled={busy} onChange={(event) => setActionBudgetDraft(event.target.value)} onBlur={() => void saveLimits()} />
          </label>
          <label>
            <span>{t("settings.computerUseIdleMinutes")}</span>
            <Input aria-label={t("settings.computerUseIdleMinutes")} type="number" min={1} step={1} value={idleMinutesDraft} disabled={busy} onChange={(event) => setIdleMinutesDraft(event.target.value)} onBlur={() => void saveLimits()} />
          </label>
        </div>
      </SettingsRow>
      <SettingsRow title={t("settings.computerUsePlatformStatus")}>
        <div className="computer-use-settings-status" role="status" aria-live="polite">
          <Badge tone={capabilityTone(capabilities)}>
            {loading ? t("settings.computerUseChecking") : capabilityLabel(t, capabilities)}
          </Badge>
          {capabilities ? <span>{capabilities.platform} · {capabilities.backend} · {capabilities.fidelity}</span> : null}
        </div>
      </SettingsRow>
    </SettingsCard>
  );
}
