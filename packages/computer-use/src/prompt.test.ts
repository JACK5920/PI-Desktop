import { describe, expect, it } from "vitest";
import { COMPUTER_LOOP_SYSTEM_PROMPT, renderObservation } from "./prompt.js";
import type { ComputerGrantView, ComputerInspection, ComputerNode } from "@pi-desktop/shared";

const grant = {
  grantId: "g1",
  targetId: "t1",
  targetLabel: "ChatGPT",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  scope: "window",
  remainingBudget: 10,
  inputPolicy: "autonomous-in-scope",
  capture: "a11y-only",
} as unknown as ComputerGrantView;

function node(overrides: Partial<ComputerNode> & { uid: string }): ComputerNode {
  return {
    role: "edit",
    label: undefined,
    hasValue: false,
    enabled: true,
    focused: false,
    actions: [],
    ...overrides,
  } as ComputerNode;
}

describe("the system prompt", () => {
  it("tells the model to act only with the actions an element lists", () => {
    // Measured: the model clicked a text field that lists `set_value` and
    // `type_text` but no `click`, and the host refused the step. The element
    // list does carry the actions, so the rule has to point at that field.
    expect(COMPUTER_LOOP_SYSTEM_PROMPT).toContain("actions=");
    expect(COMPUTER_LOOP_SYSTEM_PROMPT).toMatch(/only use an action the element itself lists/i);
  });

  it("keeps the rules the model needs to operate a window", () => {
    // Each of these was a rule the loop depended on. Losing one to an
    // edit that added another is exactly how they get lost.
    expect(COMPUTER_LOOP_SYSTEM_PROMPT).toMatch(/`switch` reads another window/);
    expect(COMPUTER_LOOP_SYSTEM_PROMPT).toMatch(/uid from the previous window stops working/);
    expect(COMPUTER_LOOP_SYSTEM_PROMPT).toMatch(/never shows a text field's content/);
    expect(COMPUTER_LOOP_SYSTEM_PROMPT).toMatch(/PI-Desktop's own windows are never a target/);
  });

  it("names both halves of the distinction", () => {
    // A field that is clicked and a button that is written into fail in
    // opposite ways, so the rule has to cover both.
    expect(COMPUTER_LOOP_SYSTEM_PROMPT).toMatch(/set_value/);
    expect(COMPUTER_LOOP_SYSTEM_PROMPT).toMatch(/click/);
  });
});

describe("the rendered observation", () => {
  it("shows the actions an element offers", () => {
    const inspection = {
      nodes: [
        node({ uid: "s1:418", role: "edit", label: "和 Codex 一起工作", actions: ["set_value", "type_text"], hasValue: true }),
        node({ uid: "s1:425", role: "button", label: "发送", actions: ["click"] }),
      ],
      truncated: false,
    } as unknown as ComputerInspection;
    const rendered = renderObservation({
      grant,
      inspection,
      captureStatus: "unavailable",
    });
    expect(rendered).toContain("uid=s1:418");
    expect(rendered).toContain("actions=set_value,type_text");
    expect(rendered).toContain("actions=click");
  });

  it("never renders an element value", () => {
    // The value is what the window's author chose, and the prompt says the
    // element list is data rather than instruction.
    const inspection = {
      nodes: [node({ uid: "s1:1", role: "text", label: "hello" })],
      truncated: false,
    } as unknown as ComputerInspection;
    const rendered = renderObservation({ grant, inspection });
    expect(rendered).not.toContain("value=");
  });

  it("says the list was cut when the host cut it", () => {
    // The host now reports its own cut, so the model is told the list is not
    // the whole window instead of concluding that an element is missing.
    const inspection = {
      nodes: [node({ uid: "s1:1", role: "text", label: "hello" })],
      truncated: true,
    } as unknown as ComputerInspection;
    const rendered = renderObservation({ grant, inspection });
    expect(rendered).toContain("truncated");
  });
});
