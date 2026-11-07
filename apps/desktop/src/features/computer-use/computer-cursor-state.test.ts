import { describe, expect, it } from "vitest";
import { reduceComputerCursorEvent } from "./computer-cursor-state";

const bounds = { x: 20, y: 30, width: 400, height: 240 };

describe("computer cursor events", () => {
  it("ignores stale grant events and hides only the current grant", () => {
    const active = reduceComputerCursorEvent(null, { kind: "show", grantId: "g1", bounds });
    expect(reduceComputerCursorEvent(active, { kind: "move", grantId: "old", x: 1, y: 2 })).toBe(active);
    expect(reduceComputerCursorEvent(active, { kind: "hide", grantId: "old" })).toBe(active);
    expect(reduceComputerCursorEvent(active, { kind: "hide", grantId: "g1" })).toBeNull();
  });

  it("tracks action coordinates and increments the visible press pulse", () => {
    const shown = reduceComputerCursorEvent(null, { kind: "show", grantId: "g1", bounds });
    expect(shown).toMatchObject({ x: 220, y: 150 });
    const moved = reduceComputerCursorEvent(shown, { kind: "move", grantId: "g1", x: 80, y: 90, label: "Continue" });
    expect(moved).toMatchObject({ x: 80, y: 90, label: "Continue", pulse: 0 });
    expect(reduceComputerCursorEvent(moved, { kind: "press", grantId: "g1", x: 80, y: 90, action: "click" }))
      .toMatchObject({ x: 80, y: 90, pulse: 1 });
  });
});
