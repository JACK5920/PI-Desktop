import assert from "node:assert/strict";
import i18n from "i18next";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
await i18n.init({
  lng: "en",
  interpolation: { escapeValue: false },
  resources: {
    en: {
      translation: {
        chat: {
          selectedTextPrompt: "Explain this excerpt from the previous reply:\n\n{{excerpt}}",
        },
      },
    },
  },
});
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const { api } = await import("../src/lib/api.ts");

function harness(t, options = {}) {
  const old = { id: "old", role: "assistant", content: "first reply", status: "complete" };
  const live = { id: "live", role: "assistant", content: "second reply", status: "streaming" };
  const messages = options.messages ?? [old, live];
  let state = {
    activeSessionId: "parent", isRunning: true, runningSessions: { parent: true },
    messages, sessions: [{ id: "parent", title: "Source", mode: "agent" }],
    sessionHistory: { parent: { hasMoreBefore: true, contentLimited: true } },
    sessionMeta: {}, sessionCompactions: {}, planningStates: {},
    retainedSessionIds: ["parent"], retainedTranscripts: options.retainedTranscripts ?? { parent: messages },
    transcriptViews: options.transcriptViews ?? {},
    composerPrefill: null,
    workPanelContexts: {}, workPanelTabs: [], workPanelOpen: false,
    navStack: [{ page: "chat", sessionId: "parent" }], navIndex: 0,
    restorePendingPlan: async () => {},
    restorePendingInteractive: async () => {},
  };
  let intent = 0;
  const cache = new Map([["parent", state.messages]]);
  const runtime = {
    beginNavigationIntent: () => ++intent,
    navigationIntentIsCurrent: (value) => value === intent,
    cacheSessionTranscript: (id, messages) => cache.set(id, messages),
    loadFullSessionMessages: () => assert.fail("fork must not hydrate over a live transcript"),
  };
  const access = {
    get: () => state,
    set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    runtime,
    decorateSessions: (sessions) => sessions,
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
  };
  const coordination = createSessionCoordination(access);
  const slice = createSessionSlice({ ...access, ...coordination });
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const forks = [];
  t.mock.method(api, "forkSession", (id, _title, anchor) => {
    assert.equal(id, "parent");
    assert.equal(anchor, options.expectedAnchor ?? "old");
    forks.push({ id, anchor });
    return pending;
  });
  return {
    slice, runtime, cache, forks, get: access.get, set: access.set,
    complete: () => resolve({ session: { id: "child", title: "Branch", mode: "agent", messages: [{ ...old, id: "child-old" }] } }),
    reject,
  };
}

function historicalPageView(messages, { hasMoreAfter = true } = {}) {
  return {
    parent: {
      messages,
      messageStart: 0,
      hasMoreBefore: false,
      hasMoreAfter,
      focus: null,
      restored: true,
      loading: null,
    },
  };
}

test("reply fork activates an independent child without hydrating or stopping its streaming parent", async (t) => {
  const h = harness(t);
  const parent = h.get().messages;
  const action = h.slice.forkAssistantMessage("old");
  h.complete();
  await action;
  assert.equal(h.get().activeSessionId, "child");
  assert.equal(h.get().isRunning, false);
  assert.equal(h.get().runningSessions.parent, true);
  assert.equal(h.cache.get("parent"), parent);
  assert.equal(h.get().retainedTranscripts.parent[1].status, "streaming");
  assert.deepEqual(h.get().messages.map(m => m.id), ["child-old"]);
  assert.deepEqual(h.get().sessions.map(s => s.id), ["child", "parent"]);
});

test("selected-text follow-up forks through the reply and pre-fills an editable localized prompt", async (t) => {
  const h = harness(t);
  const action = h.slice.forkAssistantMessage("old", "  line one\r\nline two  ");
  h.complete();
  await action;
  assert.equal(h.get().activeSessionId, "child");
  assert.deepEqual(h.get().composerPrefill, {
    sessionId: "child",
    text: "Explain this excerpt from the previous reply:\n\n> line one\n> line two",
    fileReferences: [],
  });
});

test("a fork that finishes after navigation lists the child without stealing the view", async (t) => {
  const h = harness(t);
  const action = h.slice.forkAssistantMessage("old");
  h.runtime.beginNavigationIntent();
  h.set({ activeSessionId: "other", messages: [], isRunning: false });
  h.complete();
  await action;
  assert.equal(h.get().activeSessionId, "other");
  assert.equal(h.get().composerPrefill, null, "a stale fork must not prefill another session's composer");
  assert.deepEqual(h.get().messages, []);
  assert.equal(h.get().runningSessions.parent, true);
  assert.deepEqual(h.get().sessions.map(s => s.id), ["child", "parent"]);
});

test("a rejected fork reports the error and keeps the original turn and transcript", async (t) => {
  const h = harness(t);
  const parent = h.get().messages;
  const action = h.slice.forkAssistantMessage("old");
  h.reject(Object.assign(new Error("Cannot fork this active turn"), { code: "AGENT_BUSY" }));
  await action;
  assert.equal(h.get().errorCode, "AGENT_BUSY");
  assert.equal(h.get().activeSessionId, "parent");
  assert.equal(h.get().messages, parent);
  assert.equal(h.get().isRunning, true);
});

test("a paginated historical assistant reply forks without hydrating the live window", async (t) => {
  const historical = { id: "hist", role: "assistant", content: "page 1 reply", status: "complete" };
  const latest = Array.from({ length: 100 }, (_, index) => ({
    id: `live-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: "latest window",
    status: "complete",
  }));
  const streaming = { id: "tail", role: "assistant", content: "still streaming", status: "streaming" };
  const liveWindow = [...latest, streaming];
  const h = harness(t, {
    expectedAnchor: "hist",
    messages: liveWindow,
    transcriptViews: historicalPageView([historical]),
  });
  const liveBefore = h.get().messages;
  const action = h.slice.forkAssistantMessage("hist");
  assert.equal(h.forks.length, 1);
  assert.equal(h.forks[0].anchor, "hist");
  assert.equal(h.get().messages, liveBefore);
  assert.deepEqual(h.get().messages.map((message) => message.id), liveWindow.map((message) => message.id));
  assert.equal(h.get().messages.at(-1).status, "streaming");
  assert.equal(h.get().error, undefined);
  h.complete();
  await action;
  assert.equal(h.get().activeSessionId, "child");
  assert.equal(h.get().runningSessions.parent, true);
  assert.equal(h.get().retainedTranscripts.parent.at(-1).status, "streaming");
  assert.deepEqual(h.get().retainedTranscripts.parent.map((message) => message.id), liveWindow.map((message) => message.id));
});

test("a paginated historical reply remains a fork anchor after merging with the live tail", async (t) => {
  const historical = { id: "hist", role: "assistant", content: "scrolled reply", status: "complete" };
  const liveWindow = [
    { id: "live-user", role: "user", content: "latest", status: "complete" },
    { id: "tail", role: "assistant", content: "still streaming", status: "streaming" },
  ];
  const h = harness(t, {
    expectedAnchor: "hist",
    messages: liveWindow,
    transcriptViews: historicalPageView([historical], { hasMoreAfter: false }),
  });
  const liveBefore = h.get().messages;
  const action = h.slice.forkAssistantMessage("hist");
  assert.equal(h.forks.length, 1);
  assert.equal(h.get().messages, liveBefore);
  assert.equal(h.get().messages.at(-1).status, "streaming");
  h.complete();
  await action;
  assert.equal(h.get().activeSessionId, "child");
});

test("a live reply remains forkable while a historical page is mounted", async (t) => {
  const historical = { id: "hist", role: "assistant", content: "page 1 reply", status: "complete" };
  const h = harness(t, { transcriptViews: historicalPageView([historical]) });
  const action = h.slice.forkAssistantMessage("old");
  assert.equal(h.forks.length, 1);
  h.complete();
  await action;
  assert.equal(h.get().activeSessionId, "child");
});

test("a historical user message is not accepted as an assistant reply fork anchor", async (t) => {
  const historical = { id: "hist-user", role: "user", content: "old prompt", status: "complete" };
  const h = harness(t, {
    expectedAnchor: "hist-user",
    messages: [{ id: "tail", role: "assistant", content: "still streaming", status: "streaming" }],
    transcriptViews: historicalPageView([historical]),
  });
  await h.slice.forkAssistantMessage("hist-user");
  assert.equal(h.forks.length, 0);
  assert.equal(h.get().activeSessionId, "parent");
  assert.equal(h.get().messages[0].status, "streaming");
  assert.equal(h.get().error, undefined);
});
