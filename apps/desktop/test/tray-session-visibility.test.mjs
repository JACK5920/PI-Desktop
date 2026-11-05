import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { trayVisibleSessions } = await import("../electron/main/tray-sessions.ts");

/** Only the fields the tray reads; the host owns the real payload. */
const session = (id, scheduledRun) => ({
  id,
  title: id,
  mode: "agent",
  updatedAt: "2026-10-02T00:00:00Z",
  ...(scheduledRun === undefined ? {} : { scheduledRun }),
});

test("the tray never offers owned transcripts or unpromoted side chats", () => {
  const listed = [session("plain"), session("automation", true),
    { ...session("managed"), managedByPlugin: "fixture.owner" },
    { ...session("hidden-side-chat"), sideChat: { parentSessionId: "plain", sourceMessageId: "m1", excerpt: "quote", promoted: false } },
    { ...session("promoted-side-chat"), sideChat: { parentSessionId: "plain", sourceMessageId: "m1", excerpt: "quote", promoted: true } },
    session("legacy")];

  assert.deepEqual(
    trayVisibleSessions(listed).map((item) => item.id),
    ["plain", "promoted-side-chat", "legacy"],
    "owned transcripts and unpromoted side chats leave recents; legacy summaries stay",
  );
  assert.deepEqual(trayVisibleSessions([]), []);
  assert.equal(
    trayVisibleSessions(listed).some((item) => item.scheduledRun === true || (item.sideChat && !item.sideChat.promoted)),
    false,
  );
});
