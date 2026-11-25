import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { seedRunningSessionApi } from "./helpers/session-running-fixture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "pi-running-bootstrap-"));
const entry = join(temp, "store.cjs");
await build({
  stdin: {
    contents: `
      export { useAppStore } from "./src/stores/app-store";
      export { api } from "./src/lib/api";
      export { sidebarSessionStatus } from "./src/lib/sidebar-session-status";
      export { PROTOCOL_VERSION } from "@pi-desktop/shared";
    `,
    resolveDir: join(root, "apps/desktop"),
    loader: "ts",
  },
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  define: { "import.meta.env.DEV": "false" },
});
after(() => rm(temp, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
function harness(runningSessionIds = ["running"]) {
  delete require.cache[entry];
  const { useAppStore, api, sidebarSessionStatus, PROTOCOL_VERSION } = require(entry);
  const snapshot = seedRunningSessionApi(api, PROTOCOL_VERSION, runningSessionIds);
  return { useAppStore, api, snapshot, sidebarSessionStatus };
}

// #1912: a new renderer missed agent_start while the host kept the turn alive.
test("reopening restores running badges and the selected session before another agent event", async () => {
  const h = harness();
  await h.useAppStore.getState().bootstrap();
  const state = h.useAppStore.getState();
  assert.equal(state.healthOk, true, state.error);
  assert.equal(state.runningSessions.running, true);
  assert.equal(typeof state.runningSessionStartedAt.running, "number");
  assert.notEqual(state.runningSessions.idle, true);
  assert.equal(h.sidebarSessionStatus({
    running: state.runningSessions.running, selected: false, outcome: state.sessionOutcomes.running,
  }), "running");
  await state.selectSession("running");
  assert.equal(h.useAppStore.getState().isRunning, true);
});

test("a completion arriving during bootstrap wins over the earlier running snapshot", async () => {
  const h = harness();
  let release;
  h.api.listSessions = () => new Promise((resolve) => { release = resolve; });
  const pending = h.useAppStore.getState().bootstrap();
  const first = release;
  h.api.listSessions = async () => h.snapshot;
  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 1, event: { type: "agent_end" },
  });
  first(h.snapshot);
  await pending;
  assert.equal(h.useAppStore.getState().runningSessions.running, false);
  assert.equal(h.useAppStore.getState().runningSessionStartedAt.running, undefined);
});

test("a new live run is retained when the bootstrap snapshot did not contain it", async () => {
  const h = harness([]);
  let release;
  h.api.listSessions = () => new Promise((resolve) => { release = resolve; });
  const pending = h.useAppStore.getState().bootstrap();
  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 1, event: { type: "agent_start" },
  });
  release(h.snapshot);
  await pending;
  assert.equal(h.useAppStore.getState().runningSessions.running, true);
  assert.equal(h.useAppStore.getState().runningSessionStartedAt.running, 1);
});

test("elapsed clock remains session-scoped across turns and conversation switches", async () => {
  const h = harness([]);
  await h.useAppStore.getState().bootstrap();
  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 10_000, event: { type: "agent_start" },
  });
  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 12_000, event: { type: "turn_start" },
  });
  assert.equal(h.useAppStore.getState().runningSessionStartedAt.running, 10_000);

  await h.useAppStore.getState().selectSession("idle");
  await h.useAppStore.getState().selectSession("running");
  assert.equal(h.useAppStore.getState().runningSessionStartedAt.running, 10_000);
});

test("elapsed clock resets for a new run and clears on error, manual compaction, and stop", async () => {
  const h = harness([]);
  await h.useAppStore.getState().bootstrap();
  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 10_000, event: { type: "agent_start" },
  });
  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 20_000, event: { type: "agent_end" },
  });
  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 30_000, event: { type: "agent_start" },
  });
  assert.equal(h.useAppStore.getState().runningSessionStartedAt.running, 30_000);

  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 40_000,
    event: { type: "error", error: { code: "PROVIDER_ERROR", message: "failed" } },
  });
  assert.equal(h.useAppStore.getState().runningSessionStartedAt.running, undefined);

  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 50_000,
    event: { type: "compaction_start", reason: "manual" },
  });
  assert.equal(h.useAppStore.getState().runningSessionStartedAt.running, 50_000);
  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 60_000,
    event: { type: "compaction_end", reason: "manual", ok: true },
  });
  assert.equal(h.useAppStore.getState().runningSessionStartedAt.running, undefined);

  h.api.abort = async () => ({});
  h.useAppStore.getState().handleAgentEvent({
    sessionId: "running", ts: 70_000, event: { type: "agent_start" },
  });
  await h.useAppStore.getState().abortSession("running");
  assert.equal(h.useAppStore.getState().runningSessionStartedAt.running, undefined);
});

test("a session list without a running snapshot remains compatible", async () => {
  const h = harness(null);
  h.useAppStore.setState({ runningSessions: {} });
  await h.useAppStore.getState().bootstrap();
  assert.equal(h.useAppStore.getState().healthOk, true);
  assert.deepEqual(h.useAppStore.getState().runningSessions, {});
});
