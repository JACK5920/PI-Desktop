import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("Goal defaults in AI Settings show validated future-Goal limits and searchable labels", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost" },
      addEventListener() {},
      removeEventListener() {},
      piDesktop: { on: () => () => undefined, invoke: async () => ({ ok: true, data: {} }) },
    },
  });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  });

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { I18nextProvider } = await import("react-i18next");
  const { createInstance } = await import("i18next");
  const { GoalBudgetDefaultsCard } = await server.ssrLoadModule(
    "/src/features/settings/GoalBudgetDefaultsCard.tsx",
  );
  const { searchSettings } = await server.ssrLoadModule("/src/lib/settings-search.ts");
  const { validateGoalBudgetDraft } = await server.ssrLoadModule(
    "/src/lib/goal-budget-form.ts",
  );
  const translations = {
    goalBudgetDefaultsTitle: "Goal cycle defaults",
    goalBudgetDefaultsDescription: "Applied only to newly approved Goals.",
    goalBudgetRounds: "Maximum rounds per cycle",
    goalBudgetTokens: "Token limit per cycle",
    goalBudgetDuration: "Time limit (minutes)",
    goalBudgetUnlimited: "No token limit",
    goalBudgetUnlimitedHint: "Usage is tracked; round and time limits still apply.",
    goalBudgetInvalid: "Enter valid Goal limits.",
    goalBudgetSave: "Save defaults",
    goalBudgetSaving: "Saving…",
    goalBudgetSaveFailed: "Could not save Goal defaults.",
  };
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    fallbackLng: false,
    resources: { en: { translation: { settings: translations } } },
  });

  let savedPatch;
  const html = renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(GoalBudgetDefaultsCard, {
        settings: { goalBudgetDefaults: undefined },
        saveSettings: async (patch) => {
          savedPatch = patch;
        },
      }),
    ),
  );
  assert.match(html, /Goal cycle defaults/);
  assert.match(html, /Applied only to newly approved Goals\./);
  assert.match(html, /Maximum rounds per cycle/);
  assert.match(html, /value="8"/);
  assert.match(html, /Token limit per cycle/);
  assert.match(html, /value="250000"/);
  assert.match(html, /Time limit \(minutes\)/);
  assert.match(html, /value="60"/);
  assert.match(html, /No token limit/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /Usage is tracked; round and time limits still apply\./);
  assert.match(html, /Save defaults/);
  assert.equal(savedPatch, undefined, "rendering must not persist settings");

  const retainedHtml = renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(GoalBudgetDefaultsCard, {
        settings: {
          goalBudgetDefaults: {
            maxRounds: 12,
            maxTokens: 987_654,
            maxDurationMs: 7_200_000,
            tokenBudgetUnlimited: true,
          },
        },
        saveSettings: async () => undefined,
      }),
    ),
  );
  assert.match(retainedHtml, /value="987654"/);
  assert.doesNotMatch(
    retainedHtml.match(/<input[^>]*data-testid="goal-budget-defaults-tokens"[^>]*>/)?.[0] ?? "",
    /disabled/,
    "the retained finite value stays editable while the token cutoff is unlimited",
  );
  assert.match(retainedHtml, /value="12"/);
  assert.match(retainedHtml, /value="120"/);

  const validation = validateGoalBudgetDraft({
    maxRounds: "32",
    maxTokens: "9007199254740991",
    maxDurationMinutes: "1440",
    tokenBudgetUnlimited: true,
  });
  assert.deepEqual(validation.budget, {
    maxRounds: 32,
    maxTokens: Number.MAX_SAFE_INTEGER,
    maxDurationMs: 86_400_000,
    tokenBudgetUnlimited: true,
  });
  const invalidRounds = validateGoalBudgetDraft({
    maxRounds: "33",
    maxTokens: "1",
    maxDurationMinutes: "1",
    tokenBudgetUnlimited: false,
  });
  assert.equal(invalidRounds.valid, false);
  assert.deepEqual(invalidRounds.fields, {
    maxRounds: false,
    maxTokens: true,
    maxDurationMinutes: true,
  });
  const invalidTokensAndDuration = validateGoalBudgetDraft({
    maxRounds: "1",
    maxTokens: "9007199254740992",
    maxDurationMinutes: "1441",
    tokenBudgetUnlimited: false,
  });
  assert.equal(invalidTokensAndDuration.valid, false);
  assert.deepEqual(invalidTokensAndDuration.fields, {
    maxRounds: true,
    maxTokens: false,
    maxDurationMinutes: false,
  });

  const searchLabels = {
    "settings.goalBudgetDefaultsTitle": translations.goalBudgetDefaultsTitle,
    "settings.goalBudgetDefaultsDescription": translations.goalBudgetDefaultsDescription,
    "settings.goalBudgetRounds": translations.goalBudgetRounds,
    "settings.goalBudgetTokens": translations.goalBudgetTokens,
    "settings.goalBudgetDuration": translations.goalBudgetDuration,
    "settings.goalBudgetUnlimited": translations.goalBudgetUnlimited,
    "settings.goalBudgetUnlimitedHint": translations.goalBudgetUnlimitedHint,
    "settings.nav.ai": "AI",
  };
  for (const [query, rowKey] of [
    ["Goal cycle defaults", "settings.goalBudgetDefaultsTitle"],
    ["newly approved goals", "settings.goalBudgetDefaultsDescription"],
    ["Maximum rounds", "settings.goalBudgetRounds"],
    ["Token limit", "settings.goalBudgetTokens"],
    ["Time limit", "settings.goalBudgetDuration"],
    ["No token limit", "settings.goalBudgetUnlimited"],
    ["Usage is tracked", "settings.goalBudgetUnlimitedHint"],
  ]) {
    const hits = searchSettings(query, (key) => searchLabels[key] ?? key);
    assert.ok(
      hits.some((hit) => hit.tab === "ai" && hit.rowKey === rowKey),
      `${rowKey} should be searchable in AI Settings`,
    );
  }

  const settingsPage = await readFile(
    new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(settingsPage, /<GoalBudgetDefaultsCard\b/);
  assert.match(settingsPage, /saveSettings=\{saveSettings\}/);
});
