import assert from "node:assert/strict";
import i18n from "i18next";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
await i18n.init({
  lng: "en",
  interpolation: { escapeValue: false },
  resources: { en: { translation: { chat: {
    sideChatForkFailed: "Could not create the side chat",
    sideChatSendFailed: "Could not send the side-chat prompt",
  } } } },
});
const { createSideChatSlice } = await import("../src/stores/slices/side-chat-slice.ts");
const { deleteComposerDraft, draftKeyForSession, readComposerDraft, writeComposerDraft } =
  await import("../src/lib/composer-draft-cache.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const assistant = { id: "answer-1", role: "assistant", status: "complete", content: "answer" };
  const fork = deferred();
  let state = {
    activeSessionId: "parent",
    sessions: [{ id: "parent", source: "local", title: "Parent" }],
    messages: [assistant],
    retainedTranscripts: {},
    composerPrefill: null,
    sideChats: {},
    openWorkPanelTabForSession: (sessionId, tab) => { opened.push({ sessionId, tab }); },
    closeWorkPanelTab: (tabId, sessionId) => { closed.push({ tabId, sessionId }); },
    forkAssistantMessageInSession: async (sessionId, messageId) => {
      forkCalls.push({ sessionId, messageId });
      return fork.promise;
    },
    sendPrompt: async (...args) => {
      sendCalls.push(args);
      return sendResults.shift() ?? true;
    },
    selectSession: async (id) => { selected.push(id); },
  };
  const opened = [];
  const closed = [];
  const forkCalls = [];
  const sendCalls = [];
  const selected = [];
  const sendResults = [];
  const access = {
    get: () => state,
    set: (update) => {
      const next = typeof update === "function" ? update(state) : update;
      state = { ...state, ...next };
    },
  };
  const slice = createSideChatSlice({ ...access, getCachedTranscript: () => [assistant] });
  return { slice, get: access.get, opened, closed, forkCalls, sendCalls, selected, sendResults, set: access.set, fork };
}

test("opening a side chat creates only a transient work-panel draft", () => {
  const h = fixture();
  const sideChatId = h.slice.openSideChat("parent", "answer-1", "quote");
  assert.ok(sideChatId);
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].sessionId, "parent");
  assert.equal(h.opened[0].tab.kind, "side-chat");
  assert.equal(h.get().activeSessionId, "parent");
  assert.equal(h.get().sideChats[sideChatId].childSessionId, undefined);
  assert.equal(h.forkCalls.length, 0);
  assert.equal(h.sendCalls.length, 0);
  assert.match(h.get().sideChats[sideChatId].draftText, /> quote/);
});

test("concurrent first sends fork once and use the child while keeping the parent selected", async () => {
  const h = fixture();
  const sideChatId = h.slice.openSideChat("parent", "answer-1", "quote");
  assert.ok(sideChatId);
  const first = h.slice.sendSideChatPrompt(sideChatId, "question");
  const duplicate = h.slice.sendSideChatPrompt(sideChatId, "ignored duplicate");
  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.equal(h.forkCalls.length, 1);
  h.fork.resolve("child-1");
  assert.equal(await first, true);
  assert.equal(h.sendCalls.length, 1);
  assert.equal(h.sendCalls[0][0], "question");
  assert.equal(h.sendCalls[0][2], "child-1");
  assert.equal(h.get().activeSessionId, "parent");
  assert.equal(h.get().sideChats[sideChatId].childSessionId, "child-1");
});

test("send rejection retains the child and draft so retry does not fork again", async () => {
  const h = fixture();
  const sideChatId = h.slice.openSideChat("parent", "answer-1", "quote");
  assert.ok(sideChatId);
  h.sendResults.push(false, true);
  const first = h.slice.sendSideChatPrompt(sideChatId, "question");
  await Promise.resolve();
  h.fork.resolve("child-1");
  assert.equal(await first, false);
  assert.equal(h.get().sideChats[sideChatId].draftText, "question");
  const retry = h.slice.sendSideChatPrompt(sideChatId, "question");
  assert.equal(await retry, true);
  assert.equal(h.forkCalls.length, 1);
  assert.equal(h.sendCalls.length, 2);
  assert.equal(h.get().sideChats[sideChatId].draftText, "");
});

test("closing during a fork cannot recreate the tab when the explicit send completes", async () => {
  const h = fixture();
  const sideChatId = h.slice.openSideChat("parent", "answer-1", "quote");
  assert.ok(sideChatId);
  const pending = h.slice.sendSideChatPrompt(sideChatId, "question");
  await Promise.resolve();
  h.slice.closeSideChat(sideChatId);
  h.fork.resolve("child-1");
  assert.equal(await pending, true);
  assert.equal(h.get().sideChats[sideChatId], undefined);
  assert.equal(h.opened.length, 1);
  assert.deepEqual(h.closed, [{ tabId: sideChatId, sessionId: "parent" }]);
  assert.equal(h.sendCalls[0][2], "child-1");
});

test("promoting a side chat closes its transient tab and selects the durable child", async () => {
  const h = fixture();
  const sideChatId = h.slice.openSideChat("parent", "answer-1", "quote");
  assert.ok(sideChatId);
  h.set((state) => ({ sideChats: { ...state.sideChats, [sideChatId]: {
    ...state.sideChats[sideChatId], childSessionId: "child-1",
  } } }));
  await h.slice.promoteSideChatToConversation(sideChatId);
  assert.equal(h.get().sideChats[sideChatId], undefined);
  assert.deepEqual(h.selected, ["child-1"]);
});

test("promoting during a rejected first send preserves the draft in the child composer", async (t) => {
  const h = fixture();
  const sideChatId = h.slice.openSideChat("parent", "answer-1", "quote");
  assert.ok(sideChatId);
  const childSessionId = "child-promotion-draft";
  const draftKey = draftKeyForSession(childSessionId);
  const existingFile = { path: "/tmp/child-note.txt", name: "child-note.txt", kind: "file" };
  writeComposerDraft(draftKey, { text: "existing child draft", fileReferences: [existingFile] });
  t.after(() => deleteComposerDraft(draftKey));

  const sendResult = deferred();
  const sendStarted = deferred();
  h.set({
    sendPrompt: async (...args) => {
      h.sendCalls.push(args);
      sendStarted.resolve();
      return sendResult.promise;
    },
  });

  const sending = h.slice.sendSideChatPrompt(sideChatId, "question");
  h.fork.resolve(childSessionId);
  await sendStarted.promise;

  const promoting = h.slice.promoteSideChatToConversation(sideChatId);
  await Promise.resolve();
  assert.ok(h.get().sideChats[sideChatId], "promotion must keep the side-chat draft until send outcome is known");
  assert.deepEqual(h.selected, [], "promotion must not navigate away while the first send is unresolved");

  sendResult.resolve(false);
  assert.equal(await sending, false);
  await promoting;

  assert.equal(h.get().sideChats[sideChatId], undefined);
  assert.deepEqual(h.selected, [childSessionId]);
  assert.deepEqual(readComposerDraft(draftKey), {
    text: "existing child draft\n\nquestion",
    fileReferences: [existingFile],
  });
});
