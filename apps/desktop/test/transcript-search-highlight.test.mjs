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
  const textNodes = (Array.isArray(renderedText) ? renderedText : [renderedText]).map((data) => ({
    textContent: data,
    parentElement: { closest: () => null },
    data,
    length: data.length,
  }));
  let document;
  const proseRoot = {
    nodes: textNodes,
    ownerDocument: null,
    querySelectorAll: () => [],
  };
  const ranges = [];
  const root = {
    nodes: textNodes,
    ownerDocument: null,
    querySelector: (selector) => selector === ".prose-chat, .message-user-text" ? proseRoot : null,
    querySelectorAll: () => [],
  };
  Object.defineProperty(globalThis, "NodeFilter", {
    configurable: true,
    value: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  });
  document = {
    createTreeWalker: (root) => {
      let index = 0;
      let currentNode = null;
      return {
        get currentNode() { return currentNode; },
        nextNode: () => {
          currentNode = root.nodes[index++] ?? null;
          return currentNode;
        },
      };
    },
    createRange: () => {
        const range = {
          start: undefined,
          end: undefined,
          setStart(node, offset) { this.startContainer = node; this.start = offset; },
          setEnd(node, offset) { this.endContainer = node; this.end = offset; },
        };
        ranges.push(range);
        return range;
    },
  };
  proseRoot.ownerDocument = document;
  root.ownerDocument = document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });
  t.after(() => {
    if (previousNodeFilter) Object.defineProperty(globalThis, "NodeFilter", previousNodeFilter);
    else delete globalThis.NodeFilter;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  });
  return { root, ranges, textNodes };
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

test("anchored reference navigation highlights only the captured occurrence across inline nodes", (t) => {
  const parts = ["prefix same ", "quote suffix and same quote"];
  const source = parts.join("");
  const start = source.lastIndexOf("same quote");
  const { root, textNodes } = withTranscriptDom(t, parts);
  const result = locateTranscriptSearch(root, "same quote", source, {
    anchorStart: start,
    anchorEnd: start + "same quote".length,
  });

  assert.equal(result.ranges.length, 1, "an anchored citation creates exactly one highlight range");
  assert.equal(result.ranges[0].startContainer, textNodes[1]);
  assert.equal(result.ranges[0].endContainer, textNodes[1]);
  assert.equal(result.ranges[0].start, "quote suffix and ".length);
  assert.equal(result.ranges[0].end - result.ranges[0].start, "same quote".length);
});

test("stale anchored references fall back to the message instead of guessing a repeated excerpt", (t) => {
  const text = "same quote, then same quote";
  const { root } = withTranscriptDom(t, text);
  const result = locateTranscriptSearch(root, "same quote", text, {
    anchorStart: 1,
    anchorEnd: 1 + "same quote".length,
  });

  assert.deepEqual(result.ranges, []);
  assert.equal(result.sourceElement, undefined);
});
