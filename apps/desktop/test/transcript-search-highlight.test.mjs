import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { locateTranscriptSearch } = await import(
  "../src/lib/transcript-search-highlight.ts"
);

function withTranscriptDom(t, renderedText) {
  const previousNodeFilter = Object.getOwnPropertyDescriptor(globalThis, "NodeFilter");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const textNode = {
    textContent: renderedText,
    parentElement: { closest: () => null },
    data: renderedText,
  };
  const ranges = [];
  const root = { querySelectorAll: () => [] };
  Object.defineProperty(globalThis, "NodeFilter", {
    configurable: true,
    value: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createTreeWalker: () => {
        let visited = false;
        return {
          nextNode: () => {
            if (visited) return null;
            visited = true;
            return textNode;
          },
        };
      },
      createRange: () => {
        const range = {
          start: undefined,
          end: undefined,
          setStart(_node, offset) { this.start = offset; },
          setEnd(_node, offset) { this.end = offset; },
        };
        ranges.push(range);
        return range;
      },
    },
  });
  t.after(() => {
    if (previousNodeFilter) Object.defineProperty(globalThis, "NodeFilter", previousNodeFilter);
    else delete globalThis.NodeFilter;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  });
  return { root, ranges };
}

test("transcript search highlights each exact visible occurrence", (t) => {
  const text = "same quote, then same quote";
  const { root } = withTranscriptDom(t, text);
  const result = locateTranscriptSearch(root, "same quote", text);

  assert.deepEqual(
    result.ranges.map((range) => [range.start, range.end]),
    [[0, 10], [text.lastIndexOf("same quote"), text.length]],
  );
});

test("stale source matches are not highlighted when the rendered transcript changed", (t) => {
  const { root } = withTranscriptDom(t, "replacement content");
  const result = locateTranscriptSearch(root, "old wording", "the source still contains old wording");

  assert.deepEqual(result.ranges, []);
});
