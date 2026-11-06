import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { quoteSelectedText } = await import("../src/lib/selected-text-followup.ts");

test("selected excerpts become a trimmed Markdown quote with normalized line endings", () => {
  assert.equal(quoteSelectedText("  first line\r\nsecond line  "), "> first line\n> second line");
});

test("empty selection does not produce a quote", () => {
  assert.equal(quoteSelectedText(" \r\n  "), "");
});
