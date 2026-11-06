import { readTranscriptModuleSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const messageRowSource = readTranscriptModuleSync("MessageRow.tsx");
const rendererHtml = await readFile(
  new URL("../index.html", import.meta.url),
  "utf8",
);

test("streaming content does not add a renderer-side state update loop", () => {
  assert.match(
    messageRowSource,
    /const displayContent = requestTextWithoutAnnotations\(message\.content \|\| ""\);/,
  );
  assert.match(messageRowSource, /const displayed = displayContent;/);
  assert.doesNotMatch(messageRowSource, /useTypewriter|setVisibleLen|requestAnimationFrame\(tick\)/);
});

test("renderer CSP permits only local and bundled data fonts", () => {
  // `plugin-asset:` is host-owned and package-scoped — it serves only files a
  // loaded plugin declared — so a contributed theme font is still a local load.
  assert.match(rendererHtml, /font-src 'self' data: plugin-asset:;/);
  assert.doesNotMatch(rendererHtml, /font-src[^;]*https?:/);
});
