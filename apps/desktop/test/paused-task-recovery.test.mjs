import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  PAUSED_TASK_CONTINUATION_PROMPT,
  cancelTaskPauseRequest,
  consumeTaskPauseRequest,
  requestTaskPause,
  withPausedTask,
  withoutPausedTask,
} from "../src/lib/paused-task-recovery.ts";

test("pause intent is consumed once at the settled turn boundary", () => {
  requestTaskPause("session-a");
  assert.equal(consumeTaskPauseRequest("session-a"), true);
  assert.equal(consumeTaskPauseRequest("session-a"), false);

  requestTaskPause("session-b");
  cancelTaskPauseRequest("session-b");
  assert.equal(consumeTaskPauseRequest("session-b"), false);
});

test("safe paused checkpoints are deduplicated and can be explicitly cleared", () => {
  const original = { defaultMode: "agent", theme: "system", pausedTaskSessionIds: ["session-a"] };
  const paused = withPausedTask(original, "session-a");
  assert.deepEqual(paused.pausedTaskSessionIds, ["session-a"]);
  assert.deepEqual(withPausedTask(paused, "session-b").pausedTaskSessionIds, ["session-a", "session-b"]);
  assert.deepEqual(withoutPausedTask(paused, "session-a").pausedTaskSessionIds, []);
  assert.deepEqual(original.pausedTaskSessionIds, ["session-a"]);
});

test("resume instruction avoids replaying completed or uncertain side effects", () => {
  assert.match(PAUSED_TASK_CONTINUATION_PROMPT, /Do not repeat actions/);
  assert.match(PAUSED_TASK_CONTINUATION_PROMPT, /ask the user before retrying/);
});

test("one task control toggles pause and resume while preserving stop, recovery is opt-in", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const [toolbar, bootstrap, bubble, settings] = await Promise.all([
    readFile(resolve(root, "src/features/chat/composer/ComposerToolbar.tsx"), "utf8"),
    readFile(resolve(root, "src/stores/app-store.ts"), "utf8"),
    readFile(resolve(root, "src/styles/chat-shell.css"), "utf8"),
    readFile(resolve(root, "src/features/settings/SettingsPage.tsx"), "utf8"),
  ]);
  assert.match(toolbar, /chat\.pauseGenerating/);
  assert.match(toolbar, /chat\.resumePausedTask/);
  assert.match(toolbar, /onContextMenu=\{\(event\) =>/);
  assert.doesNotMatch(toolbar, /runActive && pauseTask \?/);
  assert.doesNotMatch(toolbar, /className="resume-btn"[\s\S]{0,500}className="stop-btn"/);
  assert.match(bootstrap, /settings\?\.autoResumePausedTasks === true/);
  assert.match(bootstrap, /session\.source !== "pi-native"/);
  assert.match(bubble, /background: var\(--ds-user-bubble-bg\)/);
  const tokens = await readFile(resolve(root, "src/styles/tokens.css"), "utf8");
  assert.match(tokens, /--ds-user-bubble-bg:\s*#173e76/i);
  assert.match(tokens, /--ds-composer-primary-bg:\s*#2c67c5/i);
  const composerCss = await readFile(resolve(root, "src/styles/composer.css"), "utf8");
  assert.match(composerCss, /\.send-btn[\s\S]{0,350}background: var\(--ds-composer-primary-bg\)/);
  assert.match(composerCss, /\.pause-btn,[\s\S]{0,350}background: var\(--ds-composer-primary-bg\)/);
  assert.match(settings, /checked=\{settings\.autoResumePausedTasks === true\}/);
});
