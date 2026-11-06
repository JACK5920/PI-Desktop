import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCAL_SHARED = fileURLToPath(
  new URL("../../../packages/shared/dist/index.js", import.meta.url),
);
const LOCAL_I18N = fileURLToPath(
  new URL("../../../packages/i18n/dist/index.js", import.meta.url),
);
const GOAL_API_MODULE = "\0goal-lifecycle-test-api";

async function withGoalModules(run) {
  const server = await createServer({
    root: ROOT,
    resolve: {
      alias: {
        "@pi-desktop/shared": LOCAL_SHARED,
        "@pi-desktop/i18n": LOCAL_I18N,
      },
    },
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: "goal-lifecycle-test-api",
        enforce: "pre",
        resolveId(source, importer) {
          return source.includes("lib/api") && importer?.includes("interaction-slice.ts")
            ? GOAL_API_MODULE
            : null;
        },
        load(id) {
          if (id !== GOAL_API_MODULE) return null;
          return `export const api = new Proxy({}, { get: (_target, key) => key === "controlGoal" ? (...args) => globalThis.__goalLifecycleControl(...args) : key === "updateGoalBudget" ? (...args) => globalThis.__goalLifecycleBudgetUpdate(...args) : () => Promise.resolve({}) });`;
        },
      },
    ],
  });
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: {} } };
  try {
    const [component, store, slice] = await Promise.all([
      server.ssrLoadModule("/src/components/GoalLifecycleBar.tsx"),
      server.ssrLoadModule("/src/stores/app-store.ts"),
      server.ssrLoadModule("/src/stores/slices/interaction-slice.ts"),
    ]);
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    await run({ ...component, ...store, ...slice, i18n });
  } finally {
    delete globalThis.__goalLifecycleControl;
    globalThis.document = previousDocument;
    await server.close();
  }
}

function goal(status, overrides = {}) {
  return {
    proposalId: "goal-proposal",
    sessionId: "goal-session",
    title: "Persistent goal",
    status,
    currentExecutionId: status === "active" ? "goal-execution" : undefined,
    cycle: 1,
    roundInCycle: 2,
    runCount: 2,
    maxRounds: 8,
    maxTokens: 250_000,
    maxDurationMs: 3_600_000,
    tokensUsed: 2_000,
    elapsedMs: 60_000,
    cycleStartedAt: Date.now() - 60_000,
    tokenBudgetUnlimited: false,
    stopReason: status === "interrupted" ? "host_restart" : undefined,
    latestReport: {
      outcome: "continue",
      summary: "One check remains.",
      criteria: [
        {
          criterion: "all tests pass",
          status: "unmet",
          evidence: ["pnpm test: FAIL — one regression remains"],
        },
      ],
    },
    updatedAt: "2026-11-02T00:00:00.000Z",
    version: 3,
    ...overrides,
  };
}

function renderBar({ GoalLifecycleBar, useAppStore, i18n }, lifecycle, options = {}) {
  Object.assign(useAppStore.getInitialState(), {
    controlGoal: async () => undefined,
    showToast: () => undefined,
    planCheckpoints: options.withProposal === false
      ? {}
      : {
          [lifecycle.sessionId]: {
            id: lifecycle.proposalId,
            title: "Persistent goal",
          },
        },
  });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(GoalLifecycleBar, {
        goal: lifecycle,
        liveProgress: options.liveProgress,
      }),
    ),
  );
}

test("Goal lifecycle bar renders a durable report and only actions valid for the current state", async () => {
  await withGoalModules((modules) => {
    const active = renderBar(modules, goal("active"));
    assert.match(active, /role="region" aria-label="Goal progress"/);
    assert.match(active, /data-testid="goal-lifecycle-bar" data-status="active"/);
    assert.match(active, /Persistent goal/);
    assert.match(active, /Cycle 1 · round 2 of 8/);
    assert.match(active, /Latest agent progress report/);
    assert.match(active, /Reported met|Not yet met/);
    assert.match(active, /pnpm test: FAIL — one regression remains/);
    assert.match(active, /data-testid="goal-pause"/);
    assert.match(active, /data-testid="goal-budget-edit"/);
    assert.match(active, /data-testid="goal-clear"/);
    assert.doesNotMatch(active, /data-testid="goal-resume"/);

    const interrupted = renderBar(modules, goal("interrupted"));
    assert.match(interrupted, /Interrupted when the Host restarted/);
    assert.match(interrupted, /data-testid="goal-resume"/);
    assert.doesNotMatch(interrupted, /data-testid="goal-pause"/);
    assert.match(interrupted, /data-testid="goal-clear"/);
    assert.match(interrupted, /data-testid="goal-budget-edit"/);

    const budgetStoppedUnlimited = renderBar(
      modules,
      goal("paused", { stopReason: "GOAL_BUDGET_EXHAUSTED", tokenBudgetUnlimited: true }),
    );
    assert.match(budgetStoppedUnlimited, /time or token budget/);
    assert.doesNotMatch(budgetStoppedUnlimited, /time budget\./);

    const completed = renderBar(modules, goal("completed"));
    assert.doesNotMatch(completed, /data-testid="goal-budget-edit"/);

    const restored = renderBar(modules, goal("interrupted"), { withProposal: false });
    assert.match(restored, /Persistent goal/);
  });
});

test("Goal lifecycle bar shows matching live reported token progress", async () => {
  await withGoalModules((modules) => {
    const current = renderBar(modules, goal("active"), {
      liveProgress: {
        sessionId: "goal-session",
        proposalId: "goal-proposal",
        executionId: "goal-execution",
        turnId: "goal-turn",
        tokensUsed: 2_450,
      },
    });
    assert.match(current, /2,450 \/ 250,000 tokens/);

    const stale = renderBar(modules, goal("active"), {
      liveProgress: {
        sessionId: "goal-session",
        proposalId: "goal-proposal",
        executionId: "old-execution",
        turnId: "old-turn",
        tokensUsed: 9_999,
      },
    });
    assert.match(stale, /2,000 \/ 250,000 tokens/);
    assert.doesNotMatch(stale, /9,999 \/ 250,000 tokens/);
  });
});

test("Goal lifecycle bar renders active cycle elapsed time to the second", async () => {
  const originalNow = Date.now;
  Date.now = () => 75_000;
  try {
    await withGoalModules((modules) => {
      const active = renderBar(
        modules,
        goal("active", { cycleStartedAt: 10_000, elapsedMs: 0 }),
      );
      assert.match(active, /1 min 5 sec/);
    });
  } finally {
    Date.now = originalNow;
  }
});

test("Goal budget edits use Host result to reconcile the durable lifecycle", async () => {
  await withGoalModules(async ({ createInteractionSlice }) => {
    const calls = [];
    const events = [];
    const updatedGoal = goal("active", {
      maxRounds: 18,
      maxTokens: 600_000,
      maxDurationMs: 86_400_000,
      tokenBudgetUnlimited: true,
    });
    globalThis.__goalLifecycleBudgetUpdate = async (request) => {
      calls.push(request);
      return { goal: updatedGoal };
    };
    const state = { handlePlansChanged: (event) => events.push(event) };
    let actions;
    actions = createInteractionSlice({
      get: () => ({ ...state, ...actions }),
      set: () => undefined,
      runtime: {},
      interactionRuntime: { planResolutionRequests: new Map(), nextToastId: () => 1 },
    });

    await actions.updateGoalBudget("goal-session", "goal-proposal", {
      maxRounds: 18,
      maxTokens: 600_000,
      maxDurationMs: 86_400_000,
      tokenBudgetUnlimited: true,
    });

    assert.deepEqual(calls, [{
      sessionId: "goal-session",
      proposalId: "goal-proposal",
      budget: {
        maxRounds: 18,
        maxTokens: 600_000,
        maxDurationMs: 86_400_000,
        tokenBudgetUnlimited: true,
      },
    }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].goal.maxRounds, 18);
    assert.equal(events[0].goal.maxTokens, 600_000);
    assert.equal(events[0].goal.maxDurationMs, 86_400_000);
    assert.equal(events[0].goal.tokenBudgetUnlimited, true);
  });
});

test("Goal controls coalesce identical calls and serialize distinct actions per session", async () => {
  await withGoalModules(async ({ createInteractionSlice }) => {
    const calls = [];
    const events = [];
    const deferred = new Map();
    let notifyClearStarted;
    const clearStarted = new Promise((resolve) => {
      notifyClearStarted = resolve;
    });
    globalThis.__goalLifecycleControl = ({ sessionId, proposalId, action }) => {
      calls.push({ sessionId, proposalId, action });
      if (action === "clear") notifyClearStarted();
      return new Promise((resolve, reject) => deferred.set(action, { resolve, reject }));
    };
    const state = { handlePlansChanged: (event) => events.push(event) };
    let actions;
    actions = createInteractionSlice({
      get: () => ({ ...state, ...actions }),
      set: () => undefined,
      runtime: {},
      interactionRuntime: { planResolutionRequests: new Map(), nextToastId: () => 1 },
    });

    const pause = actions.controlGoal("goal-session", "goal-proposal", "pause");
    const duplicatePause = actions.controlGoal("goal-session", "goal-proposal", "pause");
    const clear = actions.controlGoal("goal-session", "goal-proposal", "clear");
    assert.deepEqual(calls, [{
      sessionId: "goal-session",
      proposalId: "goal-proposal",
      action: "pause",
    }]);

    deferred.get("pause").resolve({ goal: goal("paused", { stopReason: "user_paused" }) });
    await Promise.all([pause, duplicatePause]);
    await clearStarted;
    assert.deepEqual(calls, [
      { sessionId: "goal-session", proposalId: "goal-proposal", action: "pause" },
      { sessionId: "goal-session", proposalId: "goal-proposal", action: "clear" },
    ]);

    deferred.get("clear").resolve({ goal: goal("cleared", { stopReason: "user_cleared" }) });
    await clear;
    assert.deepEqual(events.map((event) => event.goal.status), ["paused", "cleared"]);
  });
});
