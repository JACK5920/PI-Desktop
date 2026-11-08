import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderPublic } from "@pi-desktop/shared";
import { IconBot, IconChevronDown } from "../../components/icons";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { ComposerModelList, type ComposerModelGroup } from "../chat/composer/ComposerModelList";
import type { ComposerModelSection } from "../chat/composer/hooks/useComposerModelMenu";
import { composerModelBinding, composerModelDisplayName, composerModelMatchesQuery, composerModelsForProvider } from "../../lib/composer-models";
import { providerDisplayName, providerSearchText } from "../../lib/provider-display";
import { sameRecentModel } from "../../lib/recent-models";
import { useAppStore } from "../../stores/app-store";
import { providerModelSection, RECENT_MODEL_SECTION } from "../chat/composer/hooks/useComposerModelMenu";

function bindingId(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

export function ComputerUseModelPicker({
  providers,
  value,
  disabled,
  onChange,
}: {
  providers: ProviderPublic[];
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recentModels = useAppStore((state) => state.recentModels);
  const groups = useMemo<ComposerModelGroup[]>(() => providers
    .filter((provider) => provider.enabled && Boolean(provider.baseUrl))
    .map((provider) => ({
      provider,
      providerDisplayName: providerDisplayName(provider),
      models: composerModelsForProvider(provider, undefined),
    }))
    .filter((group) => group.models.length > 0), [providers]);
  const recentEntries = useMemo(() => {
    const entries = groups.flatMap((group) => group.models.map((model) => ({ provider: group.provider, model })));
    return (recentModels ?? []).flatMap((recent) => {
      const match = entries.find((entry) => sameRecentModel(recent, {
        providerId: entry.provider.id,
        modelId: entry.model.modelId,
      }));
      return match ? [match] : [];
    }).slice(0, 6);
  }, [groups, recentModels]);
  const selectedProvider = value ? providers.find((provider) => value.startsWith(`${provider.id}\u0000`)) : undefined;
  const selectedModelId = value ? value.slice(value.indexOf("\u0000") + 1) : undefined;
  const selectedLabel = selectedProvider && selectedModelId
    ? composerModelDisplayName(selectedProvider, selectedModelId)
    : t("settings.computerUseModelUnset");
  const needle = query.trim().toLocaleLowerCase();
  const searching = needle.length > 0;
  const filteredGroups = useMemo(() => searching
    ? groups.map((group) => ({
      ...group,
      models: group.models.filter((model) => composerModelMatchesQuery(
        model,
        providerSearchText(group.provider),
        needle,
        composerModelBinding(group.provider, model.modelId)?.alias,
      )),
    })).filter((group) => group.models.length > 0)
    : groups, [groups, needle, searching]);
  const sections = useMemo<ComposerModelSection[]>(() => [
    ...(recentEntries.length > 0 ? [{ id: RECENT_MODEL_SECTION, kind: "recent" as const, count: recentEntries.length }] : []),
    ...groups.map((group) => ({
      id: providerModelSection(group.provider.id),
      kind: "provider" as const,
      provider: group.provider,
      label: group.providerDisplayName,
      count: searching ? filteredGroups.find((entry) => entry.provider.id === group.provider.id)?.models.length ?? 0 : group.models.length,
    })),
  ], [filteredGroups, groups, recentEntries.length, searching]);
  const selectedProviderSection = selectedProvider && groups.some((group) => group.provider.id === selectedProvider.id)
    ? providerModelSection(selectedProvider.id)
    : null;
  const defaultSection = recentEntries.length > 0 ? RECENT_MODEL_SECTION : selectedProviderSection ?? sections[0]?.id ?? null;
  const section = activeSection && sections.some((item) => item.id === activeSection)
    ? activeSection
    : defaultSection;
  const visibleRecentEntries = !searching && section === RECENT_MODEL_SECTION ? recentEntries : [];
  const visibleGroups = searching
    ? filteredGroups
    : groups.filter((group) => providerModelSection(group.provider.id) === section);
  const flatModels = [...visibleRecentEntries, ...visibleGroups.flatMap((group) => group.models.map((model) => ({ provider: group.provider, model })))];

  const choose = (provider: ProviderPublic, modelId: string) => {
    onChange(bindingId(provider.id, modelId));
    setOpen(false);
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (query && event.target === searchRef.current) setQuery("");
      else setOpen(false);
      return;
    }
    if (!(event.target instanceof HTMLInputElement)) return;
    if (event.key === "Enter" && flatModels[highlight]) {
      event.preventDefault();
      const entry = flatModels[highlight];
      if (entry) choose(entry.provider, entry.model.modelId);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (flatModels.length === 0) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    setHighlight((current) => ((current < 0 ? (delta > 0 ? -1 : 0) : current) + delta + flatModels.length) % flatModels.length);
  };

  return (
    <AnchoredMenu
      className="computer-use-model-picker"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-model-menu"
      label={t("settings.computerUseModel")}
      role="menu"
      align="end"
      side="bottom"
      initialFocus="input"
      onMenuKeyDown={onMenuKeyDown}
      trigger={(ref) => (
        <button
          ref={ref}
          type="button"
          className={`settings-menu-select-trigger computer-use-model-trigger ${open ? "active" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("settings.computerUseModel")}
          disabled={disabled}
          onClick={() => {
            setQuery("");
            setHighlight(-1);
            setOpen((current) => !current);
          }}
        >
          <span className="composer-model-thinking-icon" aria-hidden="true"><IconBot size={14} /></span>
          <span className="settings-menu-select-trigger-label">{selectedLabel}</span>
          <IconChevronDown size={14} aria-hidden="true" />
        </button>
      )}
    >
      <div className="composer-menu-root">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={!value}
          className="composer-plus-item computer-use-model-unset"
          onClick={() => { onChange(""); setOpen(false); }}
        >
          {t("settings.computerUseModelUnset")}
        </button>
        <ComposerModelList
          t={t}
          query={query}
          setQuery={(next) => { setQuery(next); setHighlight(-1); }}
          modelSearchRef={searchRef}
          modelListRef={listRef}
          modelGroups={visibleGroups}
          modelHighlight={highlight}
          setModelHighlight={setHighlight}
          selectedProviderId={selectedProvider?.id}
          selectedModelId={selectedModelId}
          selectModel={choose}
          recentEntries={visibleRecentEntries}
          sections={sections}
          activeSection={searching ? null : section}
          sectionStep={0}
          selectSection={(id) => { setActiveSection(id); setHighlight(-1); setQuery(""); listRef.current?.scrollTo({ top: 0 }); }}
          showSectionRail={sections.length > 1}
          searching={searching}
          paneRows={Math.max(1, ...groups.map((group) => group.models.length))}
        />
      </div>
    </AnchoredMenu>
  );
}
