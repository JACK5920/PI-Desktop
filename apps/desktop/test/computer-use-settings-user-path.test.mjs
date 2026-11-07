import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesActiveComputerUseRun } from "../electron/main/computer-use/stop-policy.ts";
import { searchSettings, visibleSettingsNav } from "../src/lib/settings-search.ts";

const root = join(fileURLToPath(new URL("..", import.meta.url)), "src");
const read = (path) => readFileSync(join(root, path), "utf8");

test("Computer Use has a direct settings destination and search result", () => {
  const localized = new Map([
    ["settings.computerUseTitle", "电脑操作"],
    ["settings.computerUseEnabled", "启用电脑操作"],
  ]);
  const translate = (key) => localized.get(key) ?? key;
  const visible = visibleSettingsNav(false).find((entry) => entry.id === "computerUse");
  const searchHit = searchSettings("电脑操作", translate).find((hit) => hit.tab === "computerUse");
  const page = read("features/settings/SettingsPage.tsx");

  assert.ok(visible, "Computer Use appears as a visible settings navigation item");
  assert.ok(searchHit, "the settings search can find Computer Use by its Chinese label");
  assert.match(page, /tab === "computerUse"[\s\S]*?<ComputerUseSettingsSection/);
});

test("Computer Use settings expose explicit enablement, a dedicated model, bounded settings, and capability diagnostics", () => {
  const page = read("features/settings/SettingsPage.tsx");
  const section = read("features/settings/ComputerUseSettings.tsx");
  assert.match(page, /<ComputerUseSettingsSection/);
  assert.match(section, /settings\.computerUse \?\? \{ enabled: false \}/);
  assert.match(section, /computerUse\.enabled/);
  assert.match(section, /computerUse\.model/);
  assert.match(section, /api\.listProviders\(/);
  assert.match(section, /computerCapabilities\(/);
  assert.match(section, /computerUseCapture/);
  assert.match(section, /a11y-and-pixels/);
  assert.match(section, /defaultCapture/);
  assert.match(section, /computerUseAccessibilityAndPixels/);
  assert.match(section, /saveComputerUse\(\{ defaultCapture: value \}\)/);
  assert.match(section, /actionBudget/);
  assert.match(section, /idleExpiryMs/);
  assert.match(section, /saveSettings\(\{\s*computerUse:/);
  assert.doesNotMatch(section, /computer\.grantCreate|computerGrantRevoke/);
});

test("Computer Use status control listens to host grant state and stops only its owner", () => {
  const indicator = read("features/computer-use/ComputerUseWidget.tsx");
  const widgetWindow = read("../electron/main/computer-use/widget-window.ts");
  const api = read("lib/api.ts");
  assert.match(indicator, /onComputerGrantChanged/);
  assert.match(indicator, /computerGrantRevoke/);
  assert.match(indicator, /sessionId/);
  assert.match(indicator, /grantId/);
  assert.match(api, /computerGrantRevoke/);
  assert.match(widgetWindow, /if \(latest && !closingForShutdown\)/);
  assert.match(widgetWindow, /event\.preventDefault\(\)/);
});

test("disabling Computer Use revokes its active grant and routes cancellation through the normal Agent abort path", () => {
  const settingsIpc = read("../electron/main/ipc/settings-ipc.ts");
  const registerIpc = read("../electron/main/ipc/register.ts");
  const computerIpc = read("../electron/main/ipc/computer-use-ipc.ts");
  assert.match(settingsIpc, /currentSettings\.computerUse\?\.enabled && !prospectiveSettings\.computerUse\?\.enabled/);
  assert.match(settingsIpc, /await stopComputerUse\?\./);
  assert.match(registerIpc, /const abortAgentRun = async/);
  assert.match(computerIpc, /matchesActiveComputerUseRun\(/);
  assert.match(computerIpc, /await abortAgentRun\(active\.sessionId\)/);
  assert.doesNotMatch(computerIpc, /sidecar\.call\("agent\.(?:stop|abort)"/);
});

test("Computer Use Stop owner policy refuses stale or cross-session requests", () => {
  const active = { sessionId: "session-a", grantId: "grant-a" };
  assert.equal(matchesActiveComputerUseRun(active, active), true);
  assert.equal(matchesActiveComputerUseRun(active, { sessionId: "session-b", grantId: "grant-a" }), false);
  assert.equal(matchesActiveComputerUseRun(active, { sessionId: "session-a", grantId: "grant-b" }), false);
  assert.equal(matchesActiveComputerUseRun(null, active), false);
});
