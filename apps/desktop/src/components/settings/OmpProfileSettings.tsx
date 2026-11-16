import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";

type ProfileSettings = { defaultThinkingLevel: string | null; configPath: string };
const LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function OmpProfileSettings() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [profile, setProfile] = useState<ProfileSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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

  const saveThinkingLevel = async (value: string) => {
    setSaving(true);
    try {
      const result = await api.setOmpProfileSettings({ defaultThinkingLevel: value === "engine" ? null : value });
      setProfile(result);
      showToast(t("settings.omp.profileSaved"), { variant: "success" });
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    } finally {
      setSaving(false);
    }
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
