import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

test("manual compaction occupies the session until it finishes", async (t) => {
  const server = await createServer({
    root: dirname(here),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createSessionCoordination } = await server.ssrLoadModule(
    "/electron/main/runtime/session-coordination.ts",
  );
  const coordination = createSessionCoordination({
    activeTurns: new Map(),
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });

  assert.equal(coordination.isSessionBusy("session-a"), false);
  coordination.beginManualCompaction("session-a");
  assert.equal(coordination.isSessionBusy("session-a"), true);
  assert.equal(coordination.isSessionBusy("session-b"), false);
  coordination.endManualCompaction("session-a");
  assert.equal(coordination.isSessionBusy("session-a"), false);
});
