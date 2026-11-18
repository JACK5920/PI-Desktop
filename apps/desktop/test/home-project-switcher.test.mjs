import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [chatSurface, switcher, styles] = await Promise.all([
  read("../src/components/ChatSurface.tsx"),
  read("../src/components/HomeProjectSwitcher.tsx"),
  loadStyles(),
]);

test("every empty-home scope exposes the shared selector instead of a folder picker", () => {
  const emptyStart = chatSurface.indexOf('data-testid="home-empty"');
  const emptyEnd = chatSurface.indexOf("<SessionPane", emptyStart);
  const emptyBlock = chatSurface.slice(emptyStart, emptyEnd);
  assert.match(emptyBlock, /<h1>[\s\S]*<HomeProjectSwitcher/);
  assert.match(emptyBlock, /name=\{heroProject\}[\s\S]*emptyTitleParts\.after/);
  assert.match(emptyBlock, /name=\{t\("project\.noProject"\)\}/);
  assert.doesNotMatch(emptyBlock, /data-testid="home-session-scope"/);
  assert.doesNotMatch(emptyBlock, /onClick=\{\(\) => void openProject\(\)\}/);
  assert.match(emptyBlock, /<HomeProjectSwitcher[\s\S]*\/>/);
});

test("one empty-home scope picker is available for project and no-project chats", () => {
  const emptyStart = chatSurface.indexOf('data-testid="home-empty"');
  const emptyEnd = chatSurface.indexOf("<SessionPane", emptyStart);
  const emptyBlock = chatSurface.slice(emptyStart, emptyEnd);

  assert.match(emptyBlock, /<HomeProjectSwitcher/);
  assert.match(switcher, /project\.noProject/);
  assert.match(switcher, /project\.chooseConversationLocation/);
  assert.match(switcher, /newSession\(\{ projectPath: null \}\)/);
  assert.match(switcher, /key: NO_PROJECT_KEY, name: t\("project\.noProject"\)/);
  assert.match(switcher, /data-testid=\{project\.key === NO_PROJECT_KEY\s*\?\s*"home-project-switcher-no-project"/);
  assert.match(switcher, /project\.key === NO_PROJECT_KEY\) return selectNoProject\(\)/);
  assert.match(switcher, /activeSession \? activeSession\.projectPath : path\) \?\? NO_PROJECT_KEY/);
  assert.match(switcher, /role="menuitemradio"[\s\S]*aria-checked=\{current\}/);
});

test("home project switcher lists sidebar projects and can clone a git repo", () => {
  assert.match(switcher, /<AnchoredMenu/);
  assert.match(switcher, /listSwitcherProjects/);
  assert.match(switcher, /project\.searchPlaceholder/);
  assert.match(switcher, /newSession\(\{ projectPath: nextPath \}\)/);
  assert.match(switcher, /cloneProject/);
  assert.match(switcher, /parseGitCloneUrl/);
  assert.match(switcher, /project\.clone/);
  assert.match(switcher, /project\.open/);
  assert.match(switcher, /await openProject\(\)/);
  assert.doesNotMatch(switcher, /nav\.newProject/);
  assert.match(switcher, /data-testid="home-project-switcher"/);
  assert.match(switcher, /aria-haspopup="menu"/);
  assert.match(switcher, /initialFocus="input"/);
});

test("home project switcher guards project operations before React rerenders", () => {
  assert.match(switcher, /const busyRef = useRef\(false\)/);
  assert.match(switcher, /if \(busy \|\| busyRef\.current\) return;/);
  assert.match(switcher, /busyRef\.current = true;\s*setBusy\(true\)/);
  assert.match(switcher, /busyRef\.current = false;\s*setBusy\(false\)/);
});

test("home project switcher is a fixed portaled menu that stays inline in the hero", () => {
  assert.match(
    styles,
    /\.empty-hero \.home-project-switcher \{[\s\S]*?display:\s*inline-block;/,
  );
  assert.match(
    styles,
    /\.home-project-switcher-menu \{[\s\S]*?position:\s*fixed;/,
  );
  assert.match(
    styles,
    /\.home-project-switcher-menu\.is-open \{[\s\S]*?visibility:\s*visible;/,
  );
});
