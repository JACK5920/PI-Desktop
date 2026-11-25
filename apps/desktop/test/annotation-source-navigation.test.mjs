import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { annotationSourceTarget, navigateToAnnotationSource } = await import(
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

test("a cross-session reference returns to the source session and preserves its exact highlight", () => {
  assert.deepEqual(annotationSourceTarget("side-chat-child", {
    sourceSessionId: "parent-session",
    sourceMessageId: "parent-answer",
    excerpt: "the parent passage",
    anchorStart: 7,
    anchorEnd: 26,
  }), {
    sessionId: "parent-session",
    messageId: "parent-answer",
    query: "the parent passage",
    anchorStart: 7,
    anchorEnd: 26,
  });
});

test("cross-session navigation activates the source conversation before jumping", async () => {
  let activeSessionId = "side-chat-child";
  const calls = [];
  const target = {
    sessionId: "parent-session",
    messageId: "parent-answer",
    query: "the parent passage",
    anchorStart: 7,
    anchorEnd: 26,
  };

  const navigated = await navigateToAnnotationSource(target, () => ({
    activeSessionId,
    selectSession: async (sessionId) => {
      calls.push(["select", sessionId]);
      activeSessionId = sessionId;
    },
    navigateTranscript: async (source) => calls.push(["navigate", source]),
  }));

  assert.equal(navigated, true);
  assert.deepEqual(calls, [["select", "parent-session"], ["navigate", target]]);
});

test("cross-session navigation does not override a newer conversation selection", async () => {
  let activeSessionId = "side-chat-child";
  const calls = [];
  const navigated = await navigateToAnnotationSource({
    sessionId: "parent-session",
    messageId: "parent-answer",
    query: "the parent passage",
  }, () => ({
    activeSessionId,
    selectSession: async (sessionId) => {
      calls.push(["select", sessionId]);
      activeSessionId = "newer-session";
    },
    navigateTranscript: async (target) => calls.push(["navigate", target]),
  }));

  assert.equal(navigated, false);
  assert.deepEqual(calls, [["select", "parent-session"]]);
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
