import { afterEach, describe, expect, it } from "vitest";
import type { ComputerGrantView } from "@pi-desktop/shared";
import {
  getActiveComputerUseActivity,
  publishComputerUseActivity,
  publishComputerUseRun,
  subscribeComputerUseActivity,
} from "./active-run.js";

const grant: ComputerGrantView = {
  grantId: "grant-1",
  revision: 1,
  scope: "desktop",
  targetId: "window-1",
  targetLabel: "Fixture",
  appKey: "fixture",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  inputPolicy: "autonomous-in-scope",
  capture: "a11y-only",
  remainingBudget: 10,
  sessionId: "session-1",
  createdAt: "2026-11-07T00:00:00.000Z",
  expiresAt: "2026-11-07T00:15:00.000Z",
  state: "active",
};

afterEach(() => publishComputerUseRun(null));

describe("Computer Use activity state", () => {
  it("publishes only the current grant and clears activity when that grant ends", () => {
    const changes: unknown[] = [];
    const unsubscribe = subscribeComputerUseActivity((activity) => changes.push(activity));
    publishComputerUseRun({ grant, sessionId: grant.sessionId, toolCallId: "tool-1" });

    publishComputerUseActivity({
      grantId: grant.grantId,
      phase: "acting",
      action: "click",
      target: "A".repeat(200),
      recentSteps: [{ index: 1, action: "click", target: "B".repeat(200), ok: true }],
    });
    expect(getActiveComputerUseActivity()).toMatchObject({
      grantId: grant.grantId,
      phase: "acting",
      target: "A".repeat(80),
      recentSteps: [{ target: "B".repeat(80) }],
    });

    publishComputerUseActivity({
      grantId: "stale-grant",
      phase: "failed",
      recentSteps: [],
    });
    expect(getActiveComputerUseActivity()?.grantId).toBe(grant.grantId);

    publishComputerUseRun(null);
    expect(getActiveComputerUseActivity()).toBeNull();
    expect(changes.at(-1)).toBeNull();
    unsubscribe();
  });
});
