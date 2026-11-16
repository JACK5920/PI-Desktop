import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const composer = await read("../src/components/Composer.tsx");
const input = await read("../src/features/chat/composer/ComposerInput.tsx");
const menu = await read("../src/components/ContextMenu.tsx");
const styles = await loadStyles();

test("a right-click on the editable opens the shared pointer-anchored menu", () => {
  assert.match(
    input,
    /onContextMenu\?: \(event: ReactMouseEvent<HTMLDivElement>\) => void;/,
  );
  assert.match(input, /onContextMenu=\{onContextMenu\}/);
  assert.match(
    composer,
    /<ContextMenu state=\{composerMenu\} onClose=\{closeComposerMenu\} \/>/,
  );
  assert.match(composer, /onContextMenu=\{openComposerContextMenu\}/);
});

test("menu width follows its labels instead of a fixed floor", () => {
  const rule = styles.match(/\.context-menu\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(rule, /width:\s*max-content/);
  assert.doesNotMatch(rule, /min-width/);
  assert.doesNotMatch(styles, /\.context-menu-compact/);
  assert.doesNotMatch(composer, /compact: true/);
  assert.doesNotMatch(menu, /compact/);
});

test("the menu restores the caret before a native edit command runs", () => {
  assert.match(composer, /composerCaretRef\.current\.range = range;/);
  assert.match(composer, /selection\?\.addRange\(range\)/);
  assert.match(composer, /void api\.nativeMenuAction\(action\)/);
  assert.match(composer, /requestAnimationFrame\(\(\) => \{/);
  for (const action of ["undo", "redo", "cut", "copy", "paste"]) {
    assert.match(composer, new RegExp(`runComposerEditAction\\("${action}"\\)`));
  }
});

test("select-all covers the draft, not the whole document", () => {
  assert.match(composer, /range\.selectNodeContents\(editor\)/);
  assert.doesNotMatch(composer, /runComposerEditAction\("selectAll"\)/);
});

test("a chip's right-click removes the reference it carries", () => {
  assert.match(composer, /closest<HTMLElement>\("\.composer-chip"\)/);
  assert.match(composer, /chip\.dataset\.token/);
  assert.match(composer, /draft\.removeChipByTokenRef\.current\(token\)/);
});

test("editing items are gated while the composer is blocked", () => {
  assert.match(
    composer,
    /id: "undo", label: t\("chat\.composerMenu\.undo"\), disabled: inputBlocked/,
  );
  assert.match(
    composer,
    /id: "paste", label: t\("chat\.composerMenu\.paste"\), disabled: inputBlocked/,
  );
  assert.match(
    composer,
    /id: "copy", label: t\("chat\.composerMenu\.copy"\), disabled: !hasSelection/,
  );
  assert.match(composer, /disabled: inputBlocked \|\| !token/);
});

test("every locale names the composer menu keys", async () => {
  const locales = [
    "en",
    "zh-CN",
    "zh-TW",
    "de",
    "es",
    "fr",
    "pt-BR",
    "tr",
    "ko",
  ];
  for (const locale of locales) {
    const source = await read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    const start = source.indexOf("composerMenu");
    assert.ok(start > 0, `${locale} is missing chat.composerMenu`);
    const block = source.slice(start, start + 360);
    for (const key of [
      "label",
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "selectAll",
      "removeReference",
    ]) {
      assert.match(block, new RegExp(`"?${key}"?\\s*:`), `${locale}.${key}`);
    }
  }
});
