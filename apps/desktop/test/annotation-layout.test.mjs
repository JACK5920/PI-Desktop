import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const messagesCss = await readFile(new URL("../src/styles/messages.css", import.meta.url), "utf8");
const composerCss = await readFile(new URL("../src/styles/composer.css", import.meta.url), "utf8");
const uiKitCss = await readFile(new URL("../src/styles/ui-kit.css", import.meta.url), "utf8");

test("selection annotation editor keeps text actions readable while supporting narrow viewports", () => {
  assert.match(messagesCss, /\.transcript-selection-annotation-editor\s*\{[^}]*width:\s*min\(350px, calc\(100vw - 48px\)\)/s);
  assert.match(messagesCss, /\.transcript-selection-annotation-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(messagesCss, /\.transcript-selection-annotation-actions > \*\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(messagesCss, /\.transcript-selection-annotation-actions > \*\s*\{[^}]*min-width:\s*64px/s);
  assert.match(messagesCss, /\.transcript-selection-annotation-editor textarea\s*\{[^}]*min-width:\s*0/s);
});

test("composer reference review keeps edit controls compact and prevents action shrinking", () => {
  assert.match(composerCss, /\.composer-annotation-review\s*\{[^}]*box-sizing:\s*border-box/s);
  assert.match(composerCss, /\.composer-annotation-review\s*\{[^}]*padding:\s*16px/s);
  assert.match(composerCss, /\.composer-annotation-item\s*\{[^}]*padding:\s*12px/s);
  assert.match(composerCss, /\.composer-annotation-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(composerCss, /\.composer-annotation-actions > \*\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(uiKitCss, /\.icon-btn\.icon-btn-square\s*\{[^}]*flex:\s*0 0 var\(--ds-control-size\)/s);
});
