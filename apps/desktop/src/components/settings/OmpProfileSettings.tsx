import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";

type WorktreeExitPolicy = "keep" | "ask" | "remove" | "force";
type ProfileSettings = {
  defaultThinkingLevel: string | null;
  worktreeOnExit: WorktreeExitPolicy | null;
  configPath: string;
};

const LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const WORKTREE_EXIT_POLICIES: readonly WorktreeExitPolicy[] = ["keep", "ask", "remove", "force"];

function isWorktreeExitPolicy(value: string): value is WorktreeExitPolicy {
  return WORKTREE_EXIT_POLICIES.includes(value as WorktreeExitPolicy);
}

export function OmpProfileSettings() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [profile, setProfile] = useState<ProfileSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [forceConfirmationPending, setForceConfirmationPending] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProfile(await api.getOmpProfileSettings());
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveSettings = async (patch: { defaultThinkingLevel?: string | null; worktreeOnExit?: WorktreeExitPolicy | null }) => {
    setSaving(true);
    try {
      const result = await api.setOmpProfileSettings(patch);
      setProfile(result);
      showToast(t("settings.omp.profileSaved"), { variant: "success" });
      return true;
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveThinkingLevel = async (value: string) => {
    await saveSettings({ defaultThinkingLevel: value === "engine" ? null : value });
  };

  const requestWorktreeExitPolicy = (value: string) => {
    if (value === "engine") {
      setForceConfirmationPending(false);
      void saveSettings({ worktreeOnExit: null });
      return;
    }
    if (!isWorktreeExitPolicy(value)) return;
    if (value === "force") {
      setForceConfirmationPending(true);
      return;
    }
    setForceConfirmationPending(false);
    void saveSettings({ worktreeOnExit: value });
  };

  const confirmForceWorktreeExit = async () => {
    if (await saveSettings({ worktreeOnExit: "force" })) setForceConfirmationPending(false);
  };

  const openProfileConfig = async () => {
    if (!profile?.configPath) return;
    try { await api.fsReveal(profile.configPath); }
    catch (cause) { showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" }); }
  };

  const thinkingOptions = [
    { id: "engine", label: t("settings.omp.profileEngineDefault") },
    ...LEVELS.map((level) => ({ id: level, label: t(`settings.omp.thinking.${level}`) })),
  ];
  const worktreeExitOptions = [
    { id: "engine", label: t("settings.omp.profileWorktreeEngine") },
    { id: "keep", label: t("settings.omp.profileWorktreeKeep") },
    { id: "ask", label: t("settings.omp.profileWorktreeAsk") },
    { id: "remove", label: t("settings.omp.profileWorktreeRemove") },
    { id: "force", label: t("settings.omp.profileWorktreeForce") },
  ];

  return <SettingsCard
    title={t("settings.omp.profileTitle")}
    description={t("settings.omp.profileDescription")}
    className="settings-stack"
  >
    <SettingsRow
      title={t("settings.omp.profileThinkingTitle")}
      description={t("settings.omp.profileThinkingDescription")}
      detail={profile ? t("settings.omp.profileAppliesToNewSessions") : undefined}
    >
      <SettingsMenuSelect
        value={profile?.defaultThinkingLevel ?? "engine"}
        options={thinkingOptions}
        label={t("settings.omp.profileThinkingTitle")}
        disabled={loading || saving}
        busy={saving}
        onChange={(value) => void saveThinkingLevel(value)}
      />
    </SettingsRow>
    <SettingsRow
      title={t("settings.omp.profileWorktreeTitle")}
      description={t("settings.omp.profileWorktreeDescription")}
      detail={profile ? t("settings.omp.profileAppliesToNewSessions") : undefined}
    >
      <SettingsMenuSelect
        value={profile?.worktreeOnExit ?? "engine"}
        options={worktreeExitOptions}
        label={t("settings.omp.profileWorktreeTitle")}
        disabled={loading || saving}
        busy={saving}
        onChange={requestWorktreeExitPolicy}
      />
    </SettingsRow>
    {forceConfirmationPending ? (
      <div className="omp-worktree-force-confirmation" role="alert">
        <p className="settings-error-text">{t("settings.omp.profileWorktreeForceWarning")}</p>
        <div className="settings-agent-engine-actions">
          <Button type="button" variant="primary" disabled={saving} onClick={() => void confirmForceWorktreeExit()}>
            {t("settings.omp.profileWorktreeForceConfirm")}
          </Button>
          <Button type="button" variant="secondary" disabled={saving} onClick={() => setForceConfirmationPending(false)}>
            {t("settings.omp.profileWorktreeForceCancel")}
          </Button>
        </div>
      </div>
    ) : null}
    <SettingsRow
      title={t("settings.omp.profileConfigTitle")}
      description={t("settings.omp.profileConfigDescription")}
      detail={profile?.configPath}
    >
      <Button type="button" variant="secondary" size="sm" disabled={loading || !profile?.configPath} onClick={() => void openProfileConfig()}>
        {t("settings.omp.profileOpenConfig")}
      </Button>
    </SettingsRow>
  </SettingsCard>;
}