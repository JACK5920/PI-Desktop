import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ComputerUseSettingsSection } from "../../apps/desktop/src/features/settings/ComputerUseSettings";
import { ComputerUseWidget } from "../../apps/desktop/src/features/computer-use/ComputerUseWidget";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const writes: unknown[] = [];
const stopRequests: unknown[] = [];
const fixtureCalls: string[] = [];
const grantListeners = new Set<(grant: unknown) => void>();
const activityListeners = new Set<(activity: unknown) => void>();
const grant = {
  grantId: "fixture-grant-1",
  sessionId: "fixture-session-1",
  targetLabel: "Fixture App — Main Window",
  remainingBudget: 7,
  capture: "a11y-only",
};

window.piDesktop = {
  platform: "win32",
  on(channel, listener) {
    if (channel === IPC.event.computerGrantChanged) grantListeners.add(listener);
    if (channel === IPC.event.computerActivityChanged) activityListeners.add(listener);
    return () => {
      grantListeners.delete(listener);
      activityListeners.delete(listener);
    };
  },
  async invoke(channel, input) {
    fixtureCalls.push(channel);
    let data: unknown;
    switch (channel) {
      case IPC.invoke.providersList:
        data = { providers: [{ id: "fixture-provider", name: "Fixture Provider", enabled: true, baseUrl: "https://fixture.invalid", models: [{ id: "fixture-model", alias: "Fixture Alias" }] }] };
        break;
      case IPC.invoke.computerCapabilities:
        data = { platform: "windows", backend: "supported", fidelity: "bounded", accessibility: "granted" };
        break;
      case IPC.invoke.computerGrantDescribe:
        data = { grant };
        break;
      case IPC.invoke.computerGrantRevoke:
        stopRequests.push(input);
        data = { revoked: true, requested: true };
        break;
      case IPC.invoke.settingsGet:
        data = { language: "en" };
        break;
      default:
        throw new Error(`Unexpected fixture IPC: ${channel}`);
    }
    return { ok: true, data };
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});

useAppStore.setState({ showToast: (...args: unknown[]) => console.error("COMPUTER_USE_TOAST", ...args) });
(window as any).computerUseFixtureCalls = fixtureCalls;
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture root");
const root = createRoot(container);
let currentSettings: any = {
  language: "en",
  computerUse: { enabled: false },
};
const renderSettings = () => root.render(
  <ComputerUseSettingsSection
    settings={currentSettings}
    saveSettings={async (patch) => {
      writes.push(patch);
      currentSettings = { ...currentSettings, ...patch };
      renderSettings();
    }}
  />,
);

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing fixture element: ${selector}`);
  return element;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}; rendered text: ${document.body.textContent}; IPC calls: ${(window as any).computerUseFixtureCalls?.join(",")}`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

async function runSettingsProbe() {
  flushSync(renderSettings);
  await waitUntil(() => document.body.textContent?.includes("windows · supported · bounded") ?? false, "capability diagnostics");
  const enabled = requireElement<HTMLButtonElement>('[role="switch"][aria-label="Enable Computer Use"]');
  enabled.click();
  await waitUntil(() => writes.length === 1, "enable setting save");
  if ((writes[0] as any)?.computerUse?.enabled !== true) throw new Error("Enable control did not persist the enabled setting");

  await waitUntil(() => !requireElement<HTMLButtonElement>('button[aria-label="Dedicated model"]').disabled, "settings save completion");
  const model = requireElement<HTMLButtonElement>('button[aria-label="Dedicated model"]');
  if (!document.body.textContent?.includes("Choose an enabled provider and model before asking the agent to use your desktop.")) {
    throw new Error("Missing dedicated-model validation hint when no binding is configured");
  }
  model.click();
  await waitUntil(() => Boolean(document.querySelector('input[aria-label="Search models"]')), "searchable model selector");
  const modelMenu = requireElement<HTMLElement>(".computer-use-model-menu");
  if (modelMenu.getBoundingClientRect().width < 420) {
    throw new Error(`Dedicated model menu is too narrow to read model names (${modelMenu.getBoundingClientRect().width}px)`);
  }
  const modelSearch = requireElement<HTMLInputElement>('input[aria-label="Search models"]');
  modelSearch.value = "Fixture Alias";
  modelSearch.dispatchEvent(new Event("input", { bubbles: true }));
  await waitUntil(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Fixture Alias")), "aliased model option");
  const modelOption = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')]
    .find((button) => button.textContent?.includes("Fixture Alias"));
  if (!modelOption) throw new Error("Computer Use model picker did not display the same configured alias as the chat picker");
  modelOption.click();
  await waitUntil(() => writes.length === 2, "dedicated model save");
  const modelPatch = writes[1] as any;
  if (modelPatch?.computerUse?.model?.providerId !== "fixture-provider" || modelPatch?.computerUse?.model?.modelId !== "fixture-model") {
    throw new Error("Dedicated model selection did not persist its provider/model binding");
  }
  if (Object.hasOwn(modelPatch ?? {}, "activeSession") || Object.hasOwn(modelPatch ?? {}, "session")) {
    throw new Error("Dedicated model selection unexpectedly changed the active chat session");
  }

  await waitUntil(() => !requireElement<HTMLButtonElement>('button[aria-label="Dedicated model"]').disabled, "model save completion");
  if (!requireElement<HTMLButtonElement>('button[aria-label="Dedicated model"]').textContent?.includes("Fixture Alias")) {
    throw new Error("Selected Computer Use model name does not match the Composer alias display");
  }
  const actionBudget = requireElement<HTMLInputElement>('input[aria-label="Maximum actions"]');
  const idleMinutes = requireElement<HTMLInputElement>('input[aria-label="Idle expiry (minutes)"]');
  if (actionBudget.value !== "40" || idleMinutes.value !== "15") throw new Error("Computer Use limits do not show their documented defaults");
  if (!document.body.textContent?.includes("windows · supported · bounded")) throw new Error("Platform capability diagnostics are not visible");
  if (stopRequests.length !== 0) throw new Error("Settings interactions unexpectedly created a Stop request");
  return { writes, stopRequests: stopRequests.length };
}

async function runStopWidgetProbe() {
  flushSync(() => root.render(<ComputerUseWidget />));
  await waitUntil(() => document.body.textContent?.includes("Fixture App — Main Window") ?? false, "live grant indicator");
  for (const listener of activityListeners) listener({
    grantId: "fixture-grant-1",
    phase: "acting",
    stepIndex: 1,
    action: "click",
    target: "Continue",
    recentSteps: [{ index: 1, action: "click", target: "Continue", ok: true }],
  });
  await waitUntil(() => document.body.textContent?.includes("Performing action · Click · Continue") ?? false, "live action status");
  if (!document.body.textContent?.includes("Recent: Click · Continue")) {
    throw new Error("Recent Computer Use activity trail is not visible");
  }
  const stop = requireElement<HTMLButtonElement>(".computer-use-widget-stop");
  stop.click();
  await waitUntil(() => stopRequests.length === 1, "Stop IPC request");
  const request = stopRequests[0] as any;
  if (request?.sessionId !== "fixture-session-1" || request?.grantId !== "fixture-grant-1") {
    throw new Error("Stop did not send the live grant owner identity");
  }
  return { stopRequests };
}

(window as any).runComputerUseSettingsProbe = runSettingsProbe;
(window as any).runComputerUseStopWidgetProbe = runStopWidgetProbe;
