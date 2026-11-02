import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlanExecution } from "@pi-desktop/shared";
import type { HostRpc } from "./host-ports.js";
import type { LaunchResolver } from "./launch-resolver.js";
import type { RuntimeSidecarLink } from "./runtime-service.js";
import {
  PlanExecutionDispatcher,
  type PlanExecutionDispatcherOptions,
} from "./plan-dispatch.js";

const execution: PlanExecution = {
  id: "goal-execution-2",
  proposalId: "goal-proposal",
  sessionId: "session-1",
  kind: "goal",
  plan: "# Goal",
  title: "Persistent Goal",
  question: "Approve?",
  artifact: { relativePath: ".pi/goal/goal-proposal.md", sha256: "hash", sizeBytes: 8 },
  targetPermissionMode: "ask",
  state: "queued",
};

function makeDispatcher(input: {
  queued: boolean;
  pendingPlans?: unknown[];
  activeTurn?: boolean;
}) {
  let activeTurn = input.activeTurn ?? false;
  const host = {
    call: vi.fn(async (method: string) => {
      if (method === "plans.pending") return { plans: input.pendingPlans ?? [] };
      throw new Error(`unexpected Host call: ${method}`);
    }),
  };
  const sidecar = { call: vi.fn(async () => ({ accepted: true })) };
  const runtime = {
    withSessionOperation: async (_sessionId: string, operation: () => Promise<void>) => operation(),
    beginTurn: vi.fn(async () => "turn-1"),
    finishTurn: vi.fn(async () => undefined),
    activeTurnId: vi.fn(() => activeTurn ? "interactive-turn" : undefined),
    onTurnEnded: vi.fn(() => () => undefined),
  };
  const options: PlanExecutionDispatcherOptions = {
    getHost: () => host as unknown as HostRpc,
    getSidecar: () => sidecar as unknown as RuntimeSidecarLink,
    launch: { resolve: vi.fn() } as unknown as LaunchResolver,
    runtime: runtime as unknown as PlanExecutionDispatcherOptions["runtime"],
    hasQueuedInput: vi.fn(() => input.queued),
    log: vi.fn(),
  };
  return {
    dispatcher: new PlanExecutionDispatcher(options),
    host,
    runtime,
    sidecar,
    options,
    setActiveTurn: (value: boolean) => { activeTurn = value; },
  };
}

describe("PlanExecutionDispatcher Goal continuation admission", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("defers an automatic continuation while interactive input is queued", async () => {
    vi.useFakeTimers();
    const subject = makeDispatcher({ queued: true, activeTurn: true });
    try {
      await subject.dispatcher.dispatchApprovedPlan(execution, true);
      subject.setActiveTurn(false);
      await vi.advanceTimersByTimeAsync(250);

      expect(subject.options.hasQueuedInput).toHaveBeenCalledWith("session-1");
      expect(subject.host.call).not.toHaveBeenCalled();
      expect(subject.runtime.beginTurn).not.toHaveBeenCalled();
      expect(subject.sidecar.call).not.toHaveBeenCalled();
    } finally {
      subject.dispatcher.dispose();
    }
  });

  it("defers an automatic continuation while a contract approval is pending", async () => {
    vi.useFakeTimers();
    const subject = makeDispatcher({
      queued: false,
      pendingPlans: [{ id: "pending-proposal" }],
    });
    try {
      await subject.dispatcher.dispatchApprovedPlan(execution, true);

      expect(subject.host.call).toHaveBeenCalledWith("plans.pending", {
        sessionId: "session-1",
      });
      expect(subject.runtime.beginTurn).not.toHaveBeenCalled();
      expect(subject.sidecar.call).not.toHaveBeenCalled();
    } finally {
      subject.dispatcher.dispose();
    }
  });
});
