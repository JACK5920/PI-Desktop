import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { api } = await import("../src/lib/api.ts");

test("late full-history read cannot replace a newer streaming cache", async t => {
  const old = { id: "old", role: "user", content: "original" };
  const live = { id: "live", role: "assistant", content: "new reply", status: "streaming" };
  const state = { activeSessionId: "session", messages: [old], retainedTranscripts: {}, runningSessions: {} };
  const runtime = createSessionRuntime({ get: () => state, set() {} });
  runtime.cacheSessionTranscript("session", [old]);
  let finish;
  t.mock.method(api, "getSession", () => new Promise(resolve => { finish = resolve; }));
  const reading = runtime.loadFullSessionMessages("session");
  const newer = [old, live];
  runtime.cacheSessionTranscript("session", newer);
  finish({ session: { messages: [old] } });
  assert.deepEqual(await reading, [old]);
  assert.equal(runtime.sessionTranscriptCache.get("session"), newer);
});

test("late session-detail read merges an edit that landed while the read was pending", async t => {
  const before = { id: "user-1", role: "user", content: "before edit" };
  const after = { id: "user-1", role: "user", content: "after edit" };
  const next = { id: "assistant-1", role: "assistant", content: "new answer", status: "streaming" };
  const state = { activeSessionId: "other", messages: [], retainedTranscripts: {}, runningSessions: {} };
  const runtime = createSessionRuntime({ get: () => state, set() {} });
  runtime.cacheSessionTranscript("session", [before]);
  let finish;
  t.mock.method(api, "getSession", () => new Promise(resolve => { finish = resolve; }));

  const reading = runtime.loadSessionDetail("session", { messageLimit: 100, contentLimit: 64 * 1024 });
  runtime.cacheSessionTranscript("session", [after, next]);
  finish({ session: { messages: [before], messageStart: 0, hasMoreBefore: false } });

  const detail = await reading;
  assert.deepEqual(detail.session.messages, [after, next]);
  assert.deepEqual(runtime.sessionTranscriptCache.get("session"), [after, next]);
});

test("unchanged full-history reads populate the cache, while uncached reads leave it alone", async t => {
  const state = { activeSessionId: "session", messages: [], retainedTranscripts: {}, runningSessions: {} };
  const runtime = createSessionRuntime({ get: () => state, set() {} });
  const history = [{ id: "history", role: "user", content: "earlier input" }];
  t.mock.method(api, "getSession", async () => ({ session: { messages: history } }));
  assert.equal(await runtime.loadFullSessionMessages("session", false), history);
  assert.equal(runtime.sessionTranscriptCache.has("session"), false);
  assert.equal(await runtime.loadFullSessionMessages("session"), history);
  assert.equal(runtime.sessionTranscriptCache.get("session"), history);
  assert.deepEqual(runtime.sessionHistoryCache.get("session"), { messageStart: 0, hasMoreBefore: false });
});
