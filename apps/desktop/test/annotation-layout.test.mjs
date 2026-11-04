import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const messagesCss = await readFile(new URL("../src/styles/messages.css", import.meta.url), "utf8");
const composerCss = await readFile(new URL("../src/styles/composer.css", import.meta.url), "utf8");

test("selection annotation editor stays within a narrow viewport and can wrap actions", () => {
  assert.match(messagesCss, /\.transcript-selection-annotation-editor\s*\{[^}]*width:\s*min\(350px, calc\(100vw - 48px\)\)/s);
  assert.match(messagesCss, /\.transcript-selection-annotation-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(messagesCss, /\.transcript-selection-annotation-editor textarea\s*\{[^}]*min-width:\s*0/s);
});

test("composer reference review keeps action labels from forcing horizontal overflow", () => {
  assert.match(composerCss, /\.composer-annotation-review\s*\{[^}]*box-sizing:\s*border-box/s);
  assert.match(composerCss, /\.composer-annotation-review\s*\{[^}]*padding:\s*16px/s);
  assert.match(composerCss, /\.composer-annotation-item\s*\{[^}]*padding:\s*12px/s);
  assert.match(composerCss, /\.composer-annotation-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(composerCss, /\.composer-annotation-actions > \*\s*\{[^}]*white-space:\s*normal/s);
});
