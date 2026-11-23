import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("busy composer exposes steer and follow-up choices without changing click default", async () => {
  const toolbar = await read("../src/features/chat/composer/ComposerToolbar.tsx");
  const menu = toolbar.slice(toolbar.indexOf("<AnchoredMenu\n            className=\"composer-send-options\""));
  const trigger = menu.slice(0, menu.indexOf("            >\n              <IconArrowUp"));

  assert.match(toolbar, /sendOptionsAvailable = runActive && hasDraftContent && \(!nativeSession \|\| selectedEngine === "omp"\)/);
  assert.match(trigger, /onClick=\{\(\) => void submit\(\)\}/);
  assert.match(trigger, /event\.key === "ContextMenu"/);
  assert.match(trigger, /event\.shiftKey && event\.key === "F10"/);
  assert.match(trigger, /onContextMenu/);
  assert.match(menu, /void submit\(true\)/);
  assert.match(menu, /void submit\(\)/);
  assert.match(menu, /event\.key === "ArrowDown"/);
  assert.match(menu, /event\.key === "ArrowUp"/);
  assert.match(menu, /event\.key === "Home"/);
  assert.match(menu, /event\.key === "End"/);
  assert.match(menu, /disabled=\{!steeringAllowed \|\| sendBlocked\}/);
  assert.match(menu, /aria-haspopup=\{sendOptionsAvailable \? "menu" : undefined\}/);
  assert.match(menu, /aria-expanded=\{sendOptionsAvailable \? sendOptionsOpen : undefined\}/);
});

test("OMP busy-send choices route through native steer and follow-up RPC instead of the PI queue", async () => {
  const queueSlice = await read("../src/stores/slices/queue-slice.ts");
  const ipc = await read("../electron/main/ipc/agent-ipc.ts");
  assert.match(queueSlice, /resolveAgentEngine\(\{[\s\S]*?\) === "omp"[\s\S]*?streamingBehavior: "followUp"/);
  assert.match(queueSlice, /runtime\.insertOptimisticUserMessage\(sessionId, message\)/);
  assert.match(queueSlice, /runtime\.retractOptimisticUserMessage\(sessionId, message\)/);
  assert.match(ipc, /commandType: req\.streamingBehavior === "followUp" \? "prompt" : "steer"[\s\S]*?streamingBehavior: "followUp"/);
  assert.match(ipc, /commandType: req\.streamingBehavior === "followUp" \? "prompt" : "steer"/);
  assert.match(ipc, /sidecar\.call<[^>]+>\("agent\.steer"/);
  assert.match(ipc, /session\.appendMessage[\s\S]*?turnId: req\.expectedTurnId/);
});

test("all shipped locales label both busy-send choices", async () => {
  const locales = new URL("../../../packages/i18n/src/locales/", import.meta.url);
  const localeDirs = await readdir(locales, { withFileTypes: true });
  const files = localeDirs.filter((entry) => entry.isDirectory()).map((entry) => join(entry.name, "index.ts"));

  for (const file of files) {
    const source = await readFile(new URL(file, locales), "utf8");
    assert.match(source, /sendOptions:/, `${file} is missing sendOptions`);
    assert.match(source, /steerCurrentRun:/, `${file} is missing steerCurrentRun`);
    assert.match(source, /queueAsFollowUp:/, `${file} is missing queueAsFollowUp`);
  }
});
