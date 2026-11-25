import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const messagesCss = await readFile(new URL("../src/styles/messages.css", import.meta.url), "utf8");
const composerCss = await readFile(new URL("../src/styles/composer.css", import.meta.url), "utf8");
const uiKitCss = await readFile(new URL("../src/styles/ui-kit.css", import.meta.url), "utf8");
const composerAttachments = await readFile(
  new URL("../src/features/chat/composer/ComposerAnnotationAttachments.tsx", import.meta.url),
  "utf8",
);

test("selection annotation editor keeps text actions readable while supporting narrow viewports", () => {
  assert.match(messagesCss, /\.transcript-selection-annotation-editor\s*\{[^}]*width:\s*min\(350px, calc\(100vw - 48px\)\)/s);
  assert.match(messagesCss, /\.transcript-selection-annotation-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(messagesCss, /\.transcript-selection-annotation-actions > \*\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(messagesCss, /\.transcript-selection-annotation-actions > \*\s*\{[^}]*min-width:\s*64px/s);
  assert.match(messagesCss, /\.transcript-selection-annotation-editor textarea\s*\{[^}]*min-width:\s*0/s);
});

test("composer references use one hoverable card for navigation and editing", () => {
  assert.match(composerCss, /\.composer-annotation-card\s*\{[^}]*box-sizing:\s*border-box/s);
  assert.match(composerCss, /\.composer-annotation-card\s*\{[^}]*padding:\s*16px/s);
  assert.match(composerCss, /\.composer-annotation-item\s*\{[^}]*padding:\s*12px/s);
  assert.match(composerCss, /\.composer-annotation-source-button\s*\{[^}]*cursor:\s*pointer/s);
  assert.match(composerCss, /\.composer-annotation-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(composerCss, /\.composer-annotation-actions > \*\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(uiKitCss, /\.icon-btn\.icon-btn-square\s*\{[^}]*flex:\s*0 0 var\(--ds-control-size\)/s);
  assert.match(composerAttachments, /className="composer-annotation-card"/);
  assert.match(composerAttachments, /className="composer-annotation-source-button"[\s\S]*?onClick=\{\(\) => jumpToSource\(annotation\)\}/);
  assert.match(composerAttachments, /onNavigateToSource\(target\)/);
  assert.doesNotMatch(composerAttachments, /composer-annotation-hover-preview|composer-annotation-review/);
  assert.doesNotMatch(composerAttachments, /tooltip=\{t\("chat\.reviewAnnotations"\)\}/);
});
