import { describe, expect, it } from "vitest";

import type { ComputerAction, ComputerInspection } from "@pi-desktop/shared";

import { keystrokeFocusNotice } from "./focus-notice.js";

function inspection(focused: boolean, uid = "s00000001:0"): ComputerInspection {
  return {
    grantId: "cug_1",
    revision: 2,
    fidelity: "full",
    truncated: false,
    secureInput: false,
    bounds: { x: 0, y: 0, width: 100, height: 80 },
    nodes: [
      {
        uid,
        identity: "document#0/edit#0",
        role: "edit",
        label: "composer",
        hasValue: true,
        enabled: true,
        focused,
        actions: ["set_value", "type_text"],
      },
    ],
  } as ComputerInspection;
}

function action(kind: ComputerAction["kind"], uid?: string): ComputerAction {
  return { kind, ...(uid ? { uid } : {}) } as ComputerAction;
}

describe("keystrokeFocusNotice", () => {
  it("warns when press_keys names an element that was not focused", () => {
    const notice = keystrokeFocusNotice(action("press_keys", "s00000001:0"), inspection(false));
    expect(notice).toBeDefined();
    // The notice has to name the remedy, not just the symptom.
    expect(notice).toContain("Click it first");
  });

  it("warns for type_text on an unfocused element as well", () => {
    expect(keystrokeFocusNotice(action("type_text", "s00000001:0"), inspection(false))).toBeDefined();
  });

  it("stays silent when the named element already held focus", () => {
    expect(keystrokeFocusNotice(action("press_keys", "s00000001:0"), inspection(true))).toBeUndefined();
  });

  it("stays silent for set_value, which never needs keyboard focus", () => {
    expect(keystrokeFocusNotice(action("set_value", "s00000001:0"), inspection(false))).toBeUndefined();
  });

  it("stays silent for pointer actions", () => {
    expect(keystrokeFocusNotice(action("click", "s00000001:0"), inspection(false))).toBeUndefined();
    expect(keystrokeFocusNotice(action("scroll", "s00000001:0"), inspection(false))).toBeUndefined();
  });

  it("stays silent for a global chord that names no element", () => {
    expect(keystrokeFocusNotice(action("press_keys"), inspection(false))).toBeUndefined();
  });

  it("stays silent for a uid the observation does not contain", () => {
    expect(
      keystrokeFocusNotice(action("press_keys", "s00000009:7"), inspection(false)),
    ).toBeUndefined();
  });

  it("reads the focus of the named element, not of the first row", () => {
    const tree = inspection(true);
    tree.nodes.push({
      uid: "s00000001:1",
      identity: "document#0/edit#1",
      role: "edit",
      hasValue: true,
      enabled: true,
      focused: false,
      actions: ["type_text"],
    });
    expect(keystrokeFocusNotice(action("press_keys", "s00000001:1"), tree)).toBeDefined();
    expect(keystrokeFocusNotice(action("press_keys", "s00000001:0"), tree)).toBeUndefined();
  });
});
