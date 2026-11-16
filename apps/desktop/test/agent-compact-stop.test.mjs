import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sessionOperationLock() {
  let held = false;
  const waiters = [];
  return async () => {
    if (held) await new Promise((resolve) => waiters.push(resolve));
    held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) next();
      else held = false;
    };
  };
}

function makeHarness() {
  const handlers = new Map();
  const calls = [];
  const manualBusy = new Set();
  const compactResult = deferred();
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ async call(method) {
      calls.push(["host", method]);
      if (method === "settings.get") return {};
      if (method === "session.get") return { session: { id: "s", messages: [] } };
      assert.fail(`unexpected host call ${method}`);
    } }),
    getSidecar: () => ({
      setProjectInstructionRoot() {},
      clearProjectInstructionRoot() {},
      clearVendorAuthBindings() {},
      async call(method) {
        calls.push(["sidecar", method]);
        if (method === "agent.compact") return compactResult.promise;
        if (method === "agent.abort") return { ok: true, aborted: true };
        assert.fail(`unexpected sidecar call ${method}`);
      },
    }),
    getAgentHostBridge: () => ({
      agentHost: { kick() { calls.push(["queue", "kick"]); } },
      markAborting() {},
    }),
    logger: { app() {} },
    agentExtensions: { cancelPrompts() {} },
    cancelSessionTools() {},
    persistenceOutbox: {},
    dataDir: "",
    activeTurns: new Map(),
    completionNoticeTurns: new Set(),
    recordTurnStart() {},
    isTurnDispatchable: () => true,
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({
      workspaceRoot: "C:/workspace",
      projectPath: "C:/workspace",
      sidecarParams: { sessionId: "s", provider: { modelConfig: {} } },
    }),
    acquireSessionOperation: sessionOperationLock(),
    beginManualCompaction: (id) => manualBusy.add(id),
    endManualCompaction: (id) => manualBusy.delete(id),
    finishTurn: async () => {},
    lockAbortReason() {},
    finishApprovedExecution: async () => {},
    dispatchApprovedPlan: async () => {},
    dispatchExecutionForProposal: async () => {},
    emitAgentEvent() {},
    setNotificationViewingSessionId() {},
    optionalWorkspaceRoot: async () => "C:/workspace",
    composerCommandService: { buildComposerCommands: async () => [] },
    loadComposerTemplatesCached: async () => [],
  });
  return { handlers, calls, manualBusy, compactResult };
}

test("Stop can abort manual compaction; duplicate compaction cannot release its guard", async () => {
  const h = makeHarness();
  const compact = h.handlers.get(IPC.invoke.agentCompact)({ sessionId: "s" });
  for (let i = 0; i < 50 && !h.calls.some(([, method]) => method === "agent.compact"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(h.calls.filter(([, method]) => method === "agent.compact").length, 1);
  assert.equal(h.manualBusy.has("s"), true);

  await assert.rejects(
    h.handlers.get(IPC.invoke.agentCompact)({ sessionId: "s" }),
    { errorCode: "AGENT_BUSY" },
  );
  await assert.rejects(
    h.handlers.get(IPC.invoke.agentPrompt)({ sessionId: "s", content: "race" }),
    { errorCode: "AGENT_BUSY" },
  );
  assert.equal(h.manualBusy.has("s"), true, "the rejected duplicate must not clear the owner's mark");
  assert.equal(h.calls.filter(([, method]) => method === "agent.compact").length, 1);

  const abort = await h.handlers.get(IPC.invoke.agentAbort)({ sessionId: "s" });
  assert.equal(abort.aborted, true);
  assert.equal(h.calls.some(([, method]) => method === "agent.abort"), true);

  h.compactResult.resolve({ accepted: true });
  assert.deepEqual(await compact, { accepted: true });
  assert.equal(h.manualBusy.has("s"), false);
  assert.equal(h.calls.at(-1)?.[0], "queue");
});
