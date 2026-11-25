import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { annotationSourceTarget } = await import(
  "../src/lib/annotation-source-navigation.ts"
);

test("an anchored reference navigates to its exact captured source range", () => {
  assert.deepEqual(annotationSourceTarget("session-a", {
    sourceMessageId: "answer-a",
    excerpt: "the exact passage",
    anchorStart: 12,
    anchorEnd: 29,
  }), {
    sessionId: "session-a",
    messageId: "answer-a",
    query: "the exact passage",
    anchorStart: 12,
    anchorEnd: 29,
  });
});

test("legacy and malformed references navigate to their message without guessed text matches", () => {
  for (const annotation of [
    { sourceMessageId: "answer-a", excerpt: "repeated passage" },
    { sourceMessageId: "answer-a", excerpt: "repeated passage", anchorStart: 2 },
    { sourceMessageId: "answer-a", excerpt: "repeated passage", anchorStart: 10, anchorEnd: 4 },
    { sourceMessageId: "answer-a", excerpt: "repeated passage", anchorStart: Number.MAX_SAFE_INTEGER + 1, anchorEnd: Number.MAX_SAFE_INTEGER + 2 },
  ]) {
    assert.deepEqual(annotationSourceTarget("session-a", annotation), {
      sessionId: "session-a",
      messageId: "answer-a",
      query: "",
    });
  }
});
