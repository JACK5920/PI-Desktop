import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createAnnotationSlice } = await import(
  "../src/stores/slices/annotation-slice.ts"
);

function fixture(overrides = {}) {
  let state = {
    activeSessionId: "session-a",
    sessions: [
      { id: "session-a", source: "local", capabilities: { canEditMessages: true } },
      { id: "session-b", source: "local", capabilities: { canEditMessages: true } },
      { id: "remote:session-c", source: "remote", capabilities: { canEditMessages: false } },
    ],
    messages: [
      { id: "assistant-a", role: "assistant", content: "Answer" },
      { id: "user-a", role: "user", content: "Question" },
    ],
    retainedTranscripts: {
      "session-b": [{ id: "assistant-b", role: "assistant", content: "Other answer" }],
    },
    responseAnnotations: {},
    sideChats: {},
    ...overrides,
  };
  const actions = createAnnotationSlice({
    get: () => state,
    set: (update) => {
      const next = typeof update === "function" ? update(state) : update;
      state = { ...state, ...next };
    },
  });
  return { actions, state: () => state };
}

test("annotation attachment is deduplicated by source excerpt and isolated by session", () => {
  const { actions, state } = fixture();
  const first = actions.addResponseAnnotation("session-a", "assistant-a", " selected ");
  const repeated = actions.addResponseAnnotation("session-a", "assistant-a", "selected");
  const other = actions.addResponseAnnotation("session-b", "assistant-b", "selected");
  assert.ok(first);
  assert.equal(repeated, first);
  assert.ok(other);
  assert.notEqual(other, first);
  assert.equal(actions.addResponseAnnotation("session-a", "user-a", "selected"), null);
  assert.equal(actions.addResponseAnnotation("remote:session-c", "assistant-a", "selected"), null);
  assert.deepEqual(state().responseAnnotations["session-a"].map((item) => item.excerpt), ["selected"]);
  assert.deepEqual(state().responseAnnotations["session-b"].map((item) => item.excerpt), ["selected"]);
});

test("annotation attachment retains source anchors and distinguishes repeated passages", () => {
  const { actions, state } = fixture();
  const first = actions.addResponseAnnotation(
    "session-a",
    "assistant-a",
    "selected",
    { anchorStart: 4, anchorEnd: 12 },
  );
  const samePassage = actions.addResponseAnnotation(
    "session-a",
    "assistant-a",
    "selected",
    { anchorStart: 4, anchorEnd: 12 },
  );
  const secondPassage = actions.addResponseAnnotation(
    "session-a",
    "assistant-a",
    "selected",
    { anchorStart: 30, anchorEnd: 38 },
  );

  assert.ok(first);
  assert.equal(samePassage, first);
  assert.ok(secondPassage);
  assert.notEqual(secondPassage, first);
  assert.deepEqual(
    state().responseAnnotations["session-a"].map(({ anchorStart, anchorEnd }) => ({ anchorStart, anchorEnd })),
    [
      { anchorStart: 4, anchorEnd: 12 },
      { anchorStart: 30, anchorEnd: 38 },
    ],
  );
});

test("multi-message annotations validate and retain every same-session assistant source", () => {
  const { actions, state } = fixture({
    messages: [
      { id: "assistant-a", role: "assistant", content: "First answer" },
      { id: "assistant-a2", role: "assistant", content: "Second answer" },
      { id: "assistant-a3", role: "assistant", content: "Third answer" },
      { id: "user-a", role: "user", content: "Question" },
    ],
  });
  const id = actions.addResponseAnnotation(
    "session-a",
    "assistant-a",
    "excerpt across both answers",
    undefined,
    ["assistant-a", "assistant-a2"],
  );
  assert.ok(id);
  assert.deepEqual(state().responseAnnotations["session-a"][0].sourceMessageIds, ["assistant-a", "assistant-a2"]);
  const differentSources = actions.addResponseAnnotation(
    "session-a",
    "assistant-a",
    "excerpt across both answers",
    undefined,
    ["assistant-a", "assistant-a3"],
  );
  assert.ok(differentSources);
  assert.notEqual(differentSources, id, "the same excerpt with different sources is a distinct annotation");
  assert.equal(actions.addResponseAnnotation(
    "session-a",
    "assistant-a",
    "invalid cross-role range",
    undefined,
    ["assistant-a", "user-a"],
  ), null);
});

test("a visible side-chat child can own annotations for its assistant messages", () => {
  const childMessage = { id: "child-answer", role: "assistant", content: "Child answer" };
  const { actions, state } = fixture({
    sessions: [
      { id: "session-a", source: "local", capabilities: { canEditMessages: true } },
      { id: "child-session", source: "local", capabilities: { canEditMessages: true } },
    ],
    sideChats: {
      "side-chat-1": { childSessionId: "child-session", messages: [childMessage] },
    },
  });
  const annotationId = actions.addResponseAnnotation(
    "child-session",
    "child-answer",
    "quoted child passage",
  );
  assert.ok(annotationId);
  assert.equal(state().responseAnnotations["child-session"][0].sourceMessageId, "child-answer");
});

test("accepted sends consume only the exact snapshot and retain edits or later attachments", () => {
  const { actions, state } = fixture();
  const firstId = actions.addResponseAnnotation("session-a", "assistant-a", "first");
  assert.ok(firstId);
  const submitted = state().responseAnnotations["session-a"].map((item) => ({ ...item }));
  actions.editResponseAnnotation("session-a", firstId, "changed while sending");
  const secondId = actions.addResponseAnnotation("session-a", "assistant-a", "second");
  assert.ok(secondId);
  actions.consumeAcceptedAnnotations("session-a", submitted);
  assert.deepEqual(
    state().responseAnnotations["session-a"].map(({ excerpt, comment }) => ({ excerpt, comment })),
    [
      { excerpt: "first", comment: "changed while sending" },
      { excerpt: "second", comment: undefined },
    ],
  );
  actions.consumeAcceptedAnnotations("session-a", state().responseAnnotations["session-a"].map((item) => ({ ...item })));
  assert.equal(state().responseAnnotations["session-a"], undefined);
});

test("comment edit, remove, and clear act only on the addressed session", () => {
  const { actions, state } = fixture();
  const first = actions.addResponseAnnotation("session-a", "assistant-a", "first");
  const other = actions.addResponseAnnotation("session-b", "assistant-b", "other");
  assert.ok(first && other);
  actions.editResponseAnnotation("session-a", first, "\r\n note \r\n");
  assert.equal(state().responseAnnotations["session-a"][0].comment, "note");
  actions.removeResponseAnnotation("session-a", first);
  assert.equal(state().responseAnnotations["session-a"], undefined);
  assert.equal(state().responseAnnotations["session-b"].length, 1);
  actions.clearResponseAnnotations("session-b");
  assert.equal(state().responseAnnotations["session-b"], undefined);
});
