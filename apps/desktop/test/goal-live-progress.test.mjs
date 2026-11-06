import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/goal-progress-package-resolver.mjs")));
const { addUsage } = await import("@pi-desktop/shared");
const { createEventPersistence } = await import(
  "../electron/main/runtime/event-persistence.ts"
);
const { createPlanRuntime } = await import(
  "../electron/main/runtime/plans.ts"
);
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);
const { createEventsSlice } = await import(
  "../src/stores/slices/events-slice.ts"
);
const { api } = await import("../src/lib/api.ts");
const {
  formatGoalElapsed,
  goalElapsedMs,
  goalTokensUsed,
  mergeGoalProgress,
  retainMatchingGoalProgress,
} = await import("../src/lib/goal-lifecycle-state.ts");

const SESSION = "goal-session";
const PROPOSAL = "goal-proposal";
const EXECUTION = "goal-execution";
const TURN = "goal-turn";

function lifecycle(overrides = {}) {
  return {
    proposalId: PROPOSAL,
    sessionId: SESSION,
    title: "Keep this Goal running",
    status: "active",
    currentExecutionId: EXECUTION,
    cycle: 2,
    roundInCycle: 1,
    runCount: 3,
    maxRounds: 8,
    maxTokens: 250_000,
    maxDurationMs: 3_600_000,
    tokensUsed: 100,
    elapsedMs: 12_000,
    cycleStartedAt: 10_000,
    updatedAt: "2026-11-04T00:00:00.000Z",
    version: 4,
    ...overrides,
  };
}

function progress(overrides = {}) {
  return {
    sessionId: SESSION,
    proposalId: PROPOSAL,
    executionId: EXECUTION,
    turnId: TURN,
    tokensUsed: 130,
    ...overrides,
  };
}

function createPersistenceFixture({ kind = "goal", tokenBaseline = 100 } = {}) {
  const activeTurnUsages = new Map();
  const emitted = [];
  const persistence = createEventPersistence({
    runtimeState: { host: null },
    steeringReplies: new Set(),
    completionNoticeTurns: new Set(),
    activeTurns: new Map([[SESSION, TURN]]),
    activeToolCalls: new Map(),
    activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
    approvedExecutionIdsBySession: new Map([[SESSION, EXECUTION]]),
    approvedExecutionTurns: new Map([[EXECUTION, {
      sessionId: SESSION,
      turnId: TURN,
      kind,
      proposalId: PROPOSAL,
      tokensUsedBaseline: tokenBaseline,
    }]]),
    pendingExecutionFinishes: new Map(),
    planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: (sessionId, turnId) => `${sessionId}:${turnId}`,
    inflightCheckpointer: {
      observe() {}, flush: async () => {}, settle() {}, settleIf() {},
    },
    persistenceOutbox: {
      enqueue: async () => {}, flush: async () => {}, size: () => 0,
    },
    addActiveTurnUsage(sessionId, usage) {
      const next = addUsage(activeTurnUsages.get(sessionId), usage);
      if (next) activeTurnUsages.set(sessionId, next);
    },
    getActiveTurnUsage: (sessionId) => activeTurnUsages.get(sessionId),
    emitGoalProgress: (event) => emitted.push(event),
    logger: { app() {} },
    finishTurn: async () => {},
    isStaleTerminalEvent: () => false,
    transcriptRewrite: {
      deferTranscriptEvent: () => false,
      isStaleTranscriptEvent: () => false,
      beginTranscriptRewrite: () => ({ commit() {}, rollback() {} }),
    },
    finishApprovedExecution: async () => {},
    emitAgentEvent() {},
  });
  return { activeTurnUsages, emitted, persistence };
}

function usage(totalTokens) {
  return {
    operationId: "provider-operation",
    usageOrigin: "pi",
    providerId: "fixture-provider",
    modelId: "fixture-model",
    inputTokens: totalTokens - 10,
    outputTokens: 10,
    totalTokens,
  };
}

function createGoalEventSlice(goal = lifecycle()) {
  let state = {
    goalLifecycles: { [SESSION]: goal },
    goalProgress: {},
    planCheckpoints: {},
    pendingPlans: {},
    planningStates: {},
    runningSessions: {},
    sessions: [],
    refreshQueuedPrompts: () => undefined,
    refreshSessions: async () => undefined,
  };
  const slice = createEventsSlice({
    get: () => state,
    set: (update) => {
      const next = typeof update === "function" ? update(state) : update;
      state = { ...state, ...next };
    },
    runtime: { nextPlanSyncGeneration() {} },
    withoutRecordKey: (record, key) => {
      const copy = { ...record };
      delete copy[key];
      return copy;
    },
    sessionModeForPlanningState: () => "agent",
    openPlanArtifact() {},
    notifyInteractivePrompt() {},
    flushPendingSessionConfiguration: async () => {},
    assistantErrorMessage: () => ({ role: "assistant", content: "" }),
    withCompactionMark: (marks, mark) => [...(marks ?? []), mark],
  });
  return { slice, read: () => state };
}

test("Main emits Goal tokens from its deduplicated active-turn usage aggregate", () => {
  const fixture = createPersistenceFixture({ tokenBaseline: 100 });
  for (const totalTokens of [40, 55]) {
    fixture.persistence.persistAgentEvent({
      sessionId: SESSION,
      turnId: TURN,
      ts: totalTokens,
      event: { type: "usage", usage: usage(totalTokens) },
    });
  }

  assert.deepEqual(fixture.emitted, [
    { sessionId: SESSION, proposalId: PROPOSAL, executionId: EXECUTION, turnId: TURN, tokensUsed: 140 },
    { sessionId: SESSION, proposalId: PROPOSAL, executionId: EXECUTION, turnId: TURN, tokensUsed: 155 },
  ]);
  assert.equal(fixture.activeTurnUsages.get(SESSION).totalTokens, 55);
});

test("Main does not attribute stale turns or non-Goal executions to a Goal", () => {
  const stale = createPersistenceFixture();
  stale.persistence.persistAgentEvent({
    sessionId: SESSION,
    turnId: "older-turn",
    ts: 1,
    event: { type: "usage", usage: usage(40) },
  });
  assert.deepEqual(stale.emitted, []);

  const plan = createPersistenceFixture({ kind: "plan" });
  plan.persistence.persistAgentEvent({
    sessionId: SESSION,
    turnId: TURN,
    ts: 1,
    event: { type: "usage", usage: usage(40) },
  });
  assert.deepEqual(plan.emitted, []);
});

test("Goal dispatch captures the Host cycle token baseline before opening the turn", async () => {
  const calls = [];
  const execution = {
    id: EXECUTION,
    proposalId: PROPOSAL,
    sessionId: SESSION,
    kind: "goal",
    plan: "# Goal",
    title: "Goal",
    question: "Continue?",
    artifact: { relativePath: "goal.md", sha256: "fixture", sizeBytes: 1 },
    targetPermissionMode: "ask",
    state: "queued",
  };
  const host = {
    async call(method) {
      calls.push(method);
      if (method === "plans.claimExecution") {
        return { execution: { ...execution, state: "running" } };
      }
      if (method === "settings.get") return {};
      if (method === "session.get") {
        return { session: { id: SESSION, permissionMode: "ask" } };
      }
      if (method === "plans.pending") {
        return { goal: lifecycle({ tokensUsed: 321, currentExecutionId: EXECUTION }) };
      }
      if (method === "session.beginTurn") return { turnId: TURN };
      throw new Error(`Unexpected Host call: ${method}`);
    },
  };
  const coordination = createSessionCoordination({
    activeTurns: new Map(),
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });
  const approvedExecutionTurns = new Map();
  const runtime = createPlanRuntime({
    runtimeState: {
      host,
      sidecar: { call: async () => ({ accepted: true }) },
    },
    planState: { approvedExecutionDrain: null },
    logger: { app() {} },
    sendToRenderer() {},
    coordination,
    scheduledRunsBySession: new Map(),
    activeToolCalls: new Map(),
    planSubmissionTurnIds: new Set(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    approvedExecutionTurns,
    startedApprovedExecutions: new Set(),
    finishedApprovedExecutions: new Set(),
    dispatchingApprovedExecutions: new Set(),
    inFlightExecutionFinishes: new Set(),
    pendingExecutionFinishes: new Map(),
    announceTurnEnded() {},
    emitAgentEvent() {},
    acquireSessionOperation: coordination.acquireSessionOperation,
    resolveAgentRuntimeLaunch: async () => ({
      providerId: "fixture-provider",
      modelId: "fixture-model",
      sidecarParams: {},
    }),
    isQuitting: () => false,
  });

  await runtime.dispatchApprovedPlan(execution);

  assert.ok(calls.indexOf("plans.pending") < calls.indexOf("session.beginTurn"));
  assert.deepEqual(approvedExecutionTurns.get(EXECUTION), {
    sessionId: SESSION,
    proposalId: PROPOSAL,
    kind: "goal",
    turnId: TURN,
    tokensUsedBaseline: 321,
  });
});

test("Goal live progress is monotonic and fenced to the current execution", () => {
  const goal = lifecycle();
  const first = progress({ tokensUsed: 150 });
  assert.deepEqual(mergeGoalProgress(goal, undefined, first), first);
  assert.deepEqual(
    mergeGoalProgress(goal, first, progress({ tokensUsed: 140 })),
    first,
  );
  assert.equal(
    mergeGoalProgress(goal, first, progress({ executionId: "old-execution", tokensUsed: 500 })),
    first,
  );
  assert.equal(
    mergeGoalProgress(lifecycle({ status: "paused" }), undefined, first),
    undefined,
  );
  assert.equal(goalTokensUsed(goal, first), 150);
  assert.equal(goalTokensUsed(goal, progress({ executionId: "old-execution", tokensUsed: 500 })), 100);
});

test("Goal progress reconciliation removes inactive and replaced execution overlays", () => {
  const retained = retainMatchingGoalProgress(
    {
      [SESSION]: lifecycle({ status: "active", currentExecutionId: "next-execution" }),
      "paused-session": lifecycle({ sessionId: "paused-session", status: "paused" }),
    },
    {
      [SESSION]: progress(),
      "paused-session": progress({ sessionId: "paused-session" }),
      "missing-session": progress({ sessionId: "missing-session" }),
    },
  );
  assert.deepEqual(retained, {});
});

test("Renderer accepts matching progress and drops it when Host changes execution", () => {
  const { slice, read } = createGoalEventSlice();
  slice.applyGoalProgressChanged(progress({ tokensUsed: 160 }));
  assert.equal(read().goalProgress[SESSION].tokensUsed, 160);

  slice.applyGoalProgressChanged(progress({ tokensUsed: 140 }));
  assert.equal(read().goalProgress[SESSION].tokensUsed, 160);

  slice.handlePlansChanged({
    sessionId: SESSION,
    state: "planning",
    goal: lifecycle({ cycle: 3, currentExecutionId: "next-execution", tokensUsed: 160 }),
  });
  assert.equal(read().goalProgress[SESSION], undefined);
  slice.applyGoalProgressChanged(progress({ tokensUsed: 999 }));
  assert.equal(read().goalProgress[SESSION], undefined);

  const pausedState = createGoalEventSlice();
  pausedState.slice.applyGoalProgressChanged(progress({ tokensUsed: 160 }));
  pausedState.slice.handlePlansChanged({
    sessionId: SESSION,
    state: "planning",
    goal: lifecycle({ status: "paused", version: 5 }),
  });
  assert.equal(pausedState.read().goalProgress[SESSION], undefined);
});

test("Renderer API validates and unsubscribes from the Goal progress IPC event", () => {
  const previousWindow = globalThis.window;
  const received = [];
  const listeners = new Map();
  const unsubscribed = [];
  globalThis.window = {
    piDesktop: {
      on(channel, listener) {
        listeners.set(channel, listener);
        return () => unsubscribed.push(channel);
      },
    },
  };

  try {
    const stop = api.onGoalProgress((event) => received.push(event));
    const channel = "pi-desktop/goals/event/progress";
    assert.equal(listeners.has(channel), true);
    const listener = listeners.get(channel);
    listener({ ...progress(), tokensUsed: -1 });
    listener(progress());
    assert.deepEqual(received, [progress()]);
    stop();
    assert.deepEqual(unsubscribed, [channel]);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("Goal elapsed time advances only while active and never below the Host snapshot", () => {
  const active = lifecycle({ cycleStartedAt: 10_000, elapsedMs: 12_000 });
  assert.equal(goalElapsedMs(active, 20_000), 12_000);
  assert.equal(goalElapsedMs(active, 30_000), 20_000);
  assert.equal(goalElapsedMs(lifecycle({ status: "paused", elapsedMs: 20_000 }), 30_000), 20_000);
});

test("Goal elapsed formatting retains second precision and locale units", () => {
  assert.equal(formatGoalElapsed(65_999, "en"), "1 min 5 sec");
  assert.equal(formatGoalElapsed(3_661_000, "en"), "1 hr 1 min 1 sec");
  assert.match(formatGoalElapsed(1_000, "zh-CN"), /1.*秒/);
});

test("Goal cycle and stopped-run copy names a cycle and a historical run", async () => {
  const read = (path) => readFile(join(here, "..", "..", "..", path), "utf8");
  const [zhCn, en] = await Promise.all([
    read("packages/i18n/src/locales/zh-CN/index.ts"),
    read("packages/i18n/src/locales/en/index.ts"),
  ]);
  assert.ok(zhCn.includes('round: "第 {{cycle}} 个周期 · 第 {{round}} / {{max}} 轮"'));
  assert.ok(zhCn.includes('processStopped: "该次运行已停止"'));
  assert.ok(en.includes('processStopped: "This run stopped"'));
});
