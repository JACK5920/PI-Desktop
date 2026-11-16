import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, OMP_THINKING_LEVELS, ompModelOverrideKey, type OmpModelOverride } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";
import { Button, Input, OverlayBackdrop, Select, TooltipButton } from "../ui";
import { IconClose, IconSliders } from "../icons";

type DialogModel = { provider: string; id: string; name?: string; contextWindow?: number };

export function OmpModelSettingsDialog({
  model,
  providerLabel,
  override,
  onClose,
  onSaved,
}: {
  model: DialogModel;
  providerLabel: string;
  override?: OmpModelOverride;
  onClose: () => void;
  onSaved: (overrides: Record<string, OmpModelOverride>) => void;
}) {
  const { t } = useTranslation();
  useBlockingOverlay();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const [displayName, setDisplayName] = useState(override?.displayName ?? "");
  const [thinking, setThinking] = useState<string>(override?.defaultThinkingLevel ?? "");
  const [contextWindow, setContextWindow] = useState(String(override?.contextWindow ?? model.contextWindow ?? ""));
  const [maxTokens, setMaxTokens] = useState(override?.maxTokens ? String(override.maxTokens) : "");
  const [supportsImages, setSupportsImages] = useState(override?.supportsImages === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  // App-owned providers are the only rows whose metadata the engine accepts;
  // catalog-owned ones would silently ignore an override.
  const engineEditable = model.provider.startsWith("pi_custom_");
  const hasStoredOverride = Boolean(override && Object.keys(override).length > 0);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => firstFieldRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("input:not([disabled]), select:not([disabled]), button:not([disabled])");
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  const reset = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api.setOmpModelOverride({ key: ompModelOverrideKey(model.provider, model.id) });
      onSaved(result.overrides);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current) return;
    const key = ompModelOverrideKey(model.provider, model.id);
    const nextContext = contextWindow.trim() ? Number(contextWindow) : undefined;
    const nextMax = maxTokens.trim() ? Number(maxTokens) : undefined;
    if (nextContext !== undefined && (!Number.isSafeInteger(nextContext) || nextContext < 1024)) {
      setError(t("settings.omp.modelContextInvalid"));
      return;
    }
    if (nextMax !== undefined && (!Number.isSafeInteger(nextMax) || nextMax < 1)) {
      setError(t("settings.omp.modelMaxInvalid"));
      return;
    }
    if (nextContext !== undefined && nextMax !== undefined && nextMax > nextContext) {
      setError(t("settings.omp.modelMaxExceedsContext"));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api.setOmpModelOverride({
        key,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(thinking ? { defaultThinkingLevel: thinking as OmpModelOverride["defaultThinkingLevel"] } : {}),
        ...(engineEditable && nextContext !== undefined ? { contextWindow: nextContext } : {}),
        ...(engineEditable && nextMax !== undefined ? { maxTokens: nextMax } : {}),
        ...(engineEditable ? { supportsImages } : {}),
      });
      onSaved(result.overrides);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const dialog = (
    <OverlayBackdrop className="overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !savingRef.current) onClose(); }}>
      <div ref={dialogRef} className="dialog session-rename-dialog omp-model-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="omp-model-settings-title" onClick={(event) => event.stopPropagation()}>
        <div className="session-rename-dialog-head">
          <div className="session-rename-dialog-heading">
            <h2 id="omp-model-settings-title" className="session-rename-dialog-title">
              <IconSliders size={16} aria-hidden />
              {t("settings.omp.modelSettingsTitle")}
            </h2>
            <p className="session-rename-dialog-description">{providerLabel} · {model.name ?? model.id}</p>
          </div>
          <TooltipButton type="button" className="session-rename-dialog-close" tooltip={t("settings.omp.modelSettingsCancel")} ariaLabel={t("settings.omp.modelSettingsCancel")} disabled={saving} onClick={onClose}>
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <div className="omp-model-settings-body">
            <label className="omp-model-settings-field">
              <span>{t("settings.omp.modelDisplayName")}</span>
              <Input ref={firstFieldRef} value={displayName} maxLength={120} placeholder={model.name ?? model.id} disabled={saving} onChange={(event) => setDisplayName(event.currentTarget.value)} />
              <small>{t("settings.omp.modelDisplayNameHint")}</small>
            </label>
            <label className="omp-model-settings-field">
              <span>{t("settings.omp.modelDefaultThinking")}</span>
              <Select value={thinking} disabled={saving} onChange={(event) => setThinking(event.currentTarget.value)}>
                <option value="">{t("settings.omp.modelThinkingInherit")}</option>
                {OMP_THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
              </Select>
            </label>
            {engineEditable ? <>
              <div className="omp-model-settings-row">
                <label className="omp-model-settings-field">
                  <span>{t("settings.omp.modelContextWindow")}</span>
                  <Input inputMode="numeric" value={contextWindow} disabled={saving} onChange={(event) => setContextWindow(event.currentTarget.value.replace(/[^\d]/g, ""))} />
                </label>
                <label className="omp-model-settings-field">
                  <span>{t("settings.omp.modelMaxTokens")}</span>
                  <Input inputMode="numeric" value={maxTokens} placeholder="8192" disabled={saving} onChange={(event) => setMaxTokens(event.currentTarget.value.replace(/[^\d]/g, ""))} />
                </label>
              </div>
              <label className="omp-model-settings-check">
                <input type="checkbox" checked={supportsImages} disabled={saving} onChange={(event) => setSupportsImages(event.currentTarget.checked)} />
                <span>{t("settings.omp.modelSupportsImages")}</span>
              </label>
              <p className="omp-model-settings-note">{t("settings.omp.modelOwnedHint")}</p>
            </> : <p className="omp-model-settings-note">{t("settings.omp.modelContextManaged")}</p>}
            {error ? <p className="settings-error-text" role="alert">{error}</p> : null}
          </div>
          <div className="session-rename-dialog-actions">
            {hasStoredOverride ? <Button type="button" variant="ghost" disabled={saving} onClick={() => void reset()}>{t("settings.omp.modelSettingsReset")}</Button> : null}
            <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{t("settings.omp.modelSettingsCancel")}</Button>
            <Button type="submit" variant="primary" disabled={saving}>{saving ? t("settings.omp.modelSettingsSaving") : t("settings.omp.modelSettingsSave")}</Button>
          </div>
        </form>
      </div>
    </OverlayBackdrop>
  );

  return typeof document === "undefined" ? dialog : portalToBody(dialog);
}
