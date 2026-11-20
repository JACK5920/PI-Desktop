import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { subscribeLiveSessionEvents } = await import("../electron/main/live-voice/live-session-events.ts");

const signature = (phase) => JSON.stringify({ v: 1, id: `msg_${phase}`, phase });

function nativeTurn(message) {
  let listener;
  const events = [];
  const stop = subscribeLiveSessionEvents({
    sessionId: "native-pi:s1",
    source: "pi-native",
    sidecar: { onNotification: (next) => { listener = next; return () => {}; } },
    remoteHosts: null,
    isInterrupted: () => false,
    onEvent: (event) => events.push(event),
  });
  assert.ok(stop);
  const send = (event) => listener("native.agent.event", {
    sessionId: "native-pi:s1",
    turnId: "t1",
    event,
  });
  send({ type: "message_end", message });
  send({ type: "agent_end", messages: [] });
  return events;
}

test("a live session work result omits Responses commentary", () => {
  const commentary = "Checking the files.";
  const answer = " Answer is B.";
  const events = nativeTurn({
    id: "assistant-1",
    role: "assistant",
    createdAt: "2026-11-20T00:00:00Z",
    content: commentary + answer,
    providerReplay: { version: 1, blocks: [
      { type: "text", length: commentary.length, signature: signature("commentary") },
      { type: "text", length: answer.length, signature: signature("final_answer") },
    ] },
  });
  assert.equal(events.find((event) => event.kind === "terminal")?.resultText, " Answer is B.");
});

test("a live session work result keeps unmarked text verbatim", () => {
  const events = nativeTurn({
    id: "assistant-1",
    role: "assistant",
    createdAt: "2026-11-20T00:00:00Z",
    content: "Checking the files. Answer is B.",
  });
  assert.equal(events.find((event) => event.kind === "terminal")?.resultText, "Checking the files. Answer is B.");
});
