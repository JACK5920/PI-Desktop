import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  beginSideChatSend,
  appendSideChatDraftText,
  closeSideChatLifecycle,
  editSideChatDraft,
  formatSideChatResultQuote,
  resolveSideChatFork,
  resolveSideChatSend,
} = await import("../src/lib/side-chat-lifecycle.ts");

function draft() {
  return {
    operationId: 0,
    status: "draft",
    childSessionId: undefined,
    draftText: "quoted excerpt",
    error: undefined,
  };
}

test("selected user text appends to the existing compact side-chat draft", () => {
  assert.equal(
    appendSideChatDraftText("Existing question", "selected passage", "From your message"),
    "Existing question\n\n> selected passage\n\n— From your message",
  );
});

test("side-chat results are quoted as their own answer and source without selection truncation", () => {
  const longAnswer = "line one\r\n" + "x".repeat(2_500);
  const quoted = formatSideChatResultQuote(longAnswer, "From message child-answer");
  assert.equal(quoted, `> line one\n> ${"x".repeat(2_500)}\n\n— From message child-answer`);
  assert.equal(formatSideChatResultQuote(" \n ", "From message child-answer"), "");
});

test("opening a side chat is draft-only until a non-empty explicit send", () => {
  const opened = draft();
  assert.equal(opened.childSessionId, undefined);
  assert.equal(beginSideChatSend(opened, " \n "), null);
  const send = beginSideChatSend(opened, "ask about this");
  assert.equal(send?.state.status, "forking");
  assert.equal(send?.shouldFork, true);
});

test("a concurrent first send is rejected while the fork operation is reserved", () => {
  const first = beginSideChatSend(draft(), "first question");
  assert.ok(first);
  assert.equal(beginSideChatSend(first.state, "second question"), null);
});

test("a failed send retains the forked child and draft for retry", () => {
  const started = beginSideChatSend(draft(), "question");
  assert.ok(started);
  const forked = resolveSideChatFork(started.state, started.operationId, "child-1");
  assert.ok(forked);
  const rejected = resolveSideChatSend(forked, started.operationId, false, "unavailable");
  assert.equal(rejected?.childSessionId, "child-1");
  assert.equal(rejected?.draftText, "question");
  assert.equal(rejected?.status, "ready");
  const retry = beginSideChatSend(rejected, rejected.draftText);
  assert.equal(retry?.shouldFork, false);
});

test("closing while a fork is pending makes its stale completion inert", () => {
  const started = beginSideChatSend(draft(), "question");
  assert.ok(started);
  const closed = closeSideChatLifecycle(started.state);
  assert.equal(resolveSideChatFork(closed, started.operationId, "child-1"), null);
});

test("accepted send clears only the submitted draft", () => {
  const started = beginSideChatSend(draft(), "question");
  assert.ok(started);
  const forked = resolveSideChatFork(started.state, started.operationId, "child-1");
  assert.ok(forked);
  const accepted = resolveSideChatSend(forked, started.operationId, true);
  assert.equal(accepted?.draftText, "");
  assert.equal(accepted?.status, "ready");
});

test("an accepted old draft does not erase a newer edit made while sending", () => {
  const started = beginSideChatSend(draft(), "question");
  assert.ok(started);
  const forked = resolveSideChatFork(started.state, started.operationId, "child-1");
  assert.ok(forked);
  const edited = editSideChatDraft(forked, "newer draft");
  const accepted = resolveSideChatSend(edited, started.operationId, true);
  assert.equal(accepted?.draftText, "newer draft");
});
