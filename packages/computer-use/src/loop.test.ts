import { describe, expect, it } from "vitest";
import { renderHistory } from "./prompt.js";
import type { ComputerAction, ComputerCursorEvent, ComputerGrantView, ComputerLoopActivity, ComputerNode } from "@pi-desktop/shared";

import { runComputerLoop, type ComputerLoopDeps } from "./loop.js";
import { renderObservation, type Observation } from "./prompt.js";

function grant(overrides: Partial<ComputerGrantView> = {}): ComputerGrantView {
  return {
    grantId: "cug_1",
    revision: 3,
    scope: "desktop",
    targetId: "77:12",
    targetLabel: "Example — Document",
    appKey: "example",
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    inputPolicy: "autonomous-in-scope",
    capture: "a11y-only",
    remainingBudget: 10,
    sessionId: "session-1",
    createdAt: "2026-11-04T00:00:00.000Z",
    expiresAt: "2026-11-04T00:15:00.000Z",
    state: "active",
    ...overrides,
  };
}

const saveButton: ComputerNode = {
  uid: "0.1#ab",
  role: "AXButton",
  label: "Save",
  hasValue: false,
  enabled: true,
  focused: false,
  bounds: { x: 150, y: 200, width: 80, height: 24 },
  actions: ["click"],
};

function observation(nodes: ComputerNode[] = [saveButton], overrides: Partial<Observation> = {}): Observation {
  return {
    grant: grant(),
    inspection: {
      grantId: "cug_1",
      revision: 3,
      bounds: { x: 100, y: 100, width: 800, height: 600 },
      fidelity: "full",
      nodes,
      truncated: false,
      secureInput: false,
    },
    ...overrides,
  };
}

type Harness = {
  deps: ComputerLoopDeps;
  acted: ComputerAction[];
  cursor: ComputerCursorEvent[];
  activity: ComputerLoopActivity[];
  decisions: number;
};

function harness(answers: string[], options: { act?: () => void; observe?: () => Observation } = {}): Harness {
  const acted: ComputerAction[] = [];
  const cursor: ComputerCursorEvent[] = [];
  const activity: ComputerLoopActivity[] = [];
  const state = { decisions: 0 };
  const deps: ComputerLoopDeps = {
    observe: async () => (options.observe ? options.observe() : observation()),
    act: async (action) => {
      options.act?.();
      acted.push(action);
      return { grantId: "cug_1", revision: 3, remainingBudget: 9, dispatched: "accessibility-action" };
    },
    decide: async () => {
      const answer = answers[Math.min(state.decisions, answers.length - 1)];
      state.decisions += 1;
      return answer;
    },
    onCursor: (event) => cursor.push(event),
    onActivity: (event) => activity.push(event),
  };
  return {
    deps,
    acted,
    cursor,
    activity,
    get decisions() {
      return state.decisions;
    },
  };
}

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("runComputerLoop", () => {
  it("tells the model when requested pixel capture is unavailable", () => {
    const rendered = renderObservation(observation([], { captureStatus: "unavailable" }));
    expect(rendered).toContain("Pixel capture was requested but is unavailable for this observation.");
    expect(rendered).toContain("Use only the listed accessibility data; do not claim visual inspection.");
  });

  it("acts once and stops on done", async () => {
    const h = harness([
      '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}',
      '{"kind":"done","summary":"saved","evidence":["0.1#ab"]}',
    ]);
    const result = await runComputerLoop({ instruction: "save the document" }, h.deps);
    expect(result.outcome).toBe("done");
    expect(result.verification).toBe("model-confirmed");
    expect(h.acted).toEqual([{ kind: "click", uid: "0.1#ab" }]);
    expect(result.steps.filter((step) => step.ok && step.action === "click")).toHaveLength(1);
    // The model's claim is labelled, never presented as the loop's own report.
    expect(result.summary).toContain("Model's account: saved");
    expect(result.summary).toContain("Dispatched 1 of 1 action");
  });

  it("marks a successful action as dispatched and then compares the fresh UIA state", async () => {
    let clicked = false;
    const h = harness([
      '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}',
      '{"kind":"done","summary":"saved","evidence":["0.1#ab"]}',
    ], {
      act: () => { clicked = true; },
      observe: () => observation([{ ...saveButton, label: clicked ? "Saved" : "Save" }]),
    });

    const result = await runComputerLoop({ instruction: "save the document" }, h.deps);

    expect(result.steps).toContainEqual(expect.objectContaining({ action: "click", verification: "observed-change" }));
    expect(result.steps).toContainEqual(expect.objectContaining({ action: "done", verification: "model-confirmed", evidenceCount: 1 }));
    expect(h.activity).toContainEqual(expect.objectContaining({ phase: "observing", verification: "observed-change" }));
    expect(result.verification).toBe("model-confirmed");
  });

  it("does not replay a non-idempotent action when the UIA tree shows no change", async () => {
    const h = harness([
      '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}',
      '{"kind":"done","summary":"the requested state is visible","evidence":["0.1#ab"]}',
    ]);

    const result = await runComputerLoop({ instruction: "click once" }, h.deps);

    expect(h.acted).toHaveLength(1);
    expect(result.steps).toContainEqual(expect.objectContaining({ action: "click", verification: "observed-no-change" }));
    expect(result.outcome).toBe("done");
    expect(result.verification).toBe("model-confirmed");
  });

  it("refuses a second write of the same text to the same field", async () => {
    // The element list never shows a field's content, so a model cannot tell
    // a landed write from a lost one. Measured: a model asked to type one
    // line alternated `type_text` and `set_value` with the same text for
    // eight steps. The second write of the same text is refused, whichever
    // action kind it uses.
    const field: ComputerNode = {
      ...saveButton,
      role: "AXTextField",
      label: "Name",
      hasValue: true,
      actions: ["set_value", "type_text"],
    };
    const h = harness(
      [
        '{"kind":"action","action":{"kind":"type_text","uid":"0.1#ab","text":"same"}}',
        '{"kind":"action","action":{"kind":"set_value","uid":"0.1#ab","text":"same"}}',
        '{"kind":"done","summary":"typed","evidence":[]}',
      ],
      { observe: () => observation([field]) },
    );

    await runComputerLoop({ instruction: "type the text" }, h.deps);

    const writes = h.acted.filter((action) => action.kind === "type_text" || action.kind === "set_value");
    expect(writes).toHaveLength(1);
    const skipped = h.activity.filter((event) => event.phase === "acting");
    expect(skipped.length).toBe(1);
  });

  it("accepts an empty evidence list when the host confirmed the write", async () => {
    // The field has to offer the write, or the step is refused before the
    // host ever sees it.
    const field: ComputerNode = {
      ...saveButton,
      role: "AXTextField",
      label: "Name",
      hasValue: true,
      actions: ["set_value"],
    };
    // A write's result is the content of a field, and the accessibility tree
    // never publishes a field's content -- so there is no element the model
    // could cite. The host can read the field back and compare it with what
    // was written, and that verdict is stronger than any citation.
    const h = harness(
      [
        '{"kind":"action","action":{"kind":"set_value","uid":"0.1#ab","text":"written"}}',
        '{"kind":"done","summary":"typed","evidence":[]}',
      ],
      {
        observe: () => observation([field]),
        act: () => undefined,
      },
    );
    const deps: ComputerLoopDeps = {
      ...h.deps,
      act: async () => ({
        grantId: "cug_1",
        revision: 3,
        remainingBudget: 9,
        dispatched: "accessibility-action",
        verified: true,
      }),
    };

    const result = await runComputerLoop({ instruction: "type the text" }, deps);

    expect(result.outcome).toBe("done");
    expect(result.verification).toBe("model-confirmed");
    expect(result.summary).toContain("read the field back");
  });

  it("does not carry a write confirmation across a later action", async () => {
    // The confirmation belongs to the write it verified. A run-scoped flag
    // carried an old verdict forward: a confirmed write followed by a click
    // that did nothing would still let the model close with an empty evidence
    // list and be told the result was confirmed.
    const field: ComputerNode = {
      ...saveButton,
      role: "AXTextField",
      label: "Name",
      hasValue: true,
      actions: ["set_value", "type_text", "click"],
    };
    const h = harness(
      [
        '{"kind":"action","action":{"kind":"set_value","uid":"0.1#ab","text":"written"}}',
        '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}',
        '{"kind":"done","summary":"typed","evidence":[]}',
      ],
      { observe: () => observation([field]) },
    );
    const deps: ComputerLoopDeps = {
      ...h.deps,
      act: async (action) => ({
        grantId: "cug_1",
        revision: 3,
        remainingBudget: 9,
        dispatched: "accessibility-action",
        // The write was confirmed; the click that followed was not.
        verified: action.kind === "set_value" ? true : undefined,
      }),
    };

    const result = await runComputerLoop({ instruction: "type the text" }, deps);

    expect(result.outcome).not.toBe("done");
    expect(result.verification).not.toBe("model-confirmed");
  });

  it("does not accept an empty evidence list when the host could not confirm the write", async () => {
    // The same shape without the host's verdict is still a self-report at
    // best, and the refusal is the honest answer.
    const h = harness(
      [
        '{"kind":"action","action":{"kind":"set_value","uid":"0.1#ab","text":"written"}}',
        '{"kind":"done","summary":"typed","evidence":[]}',
      ],
      { observe: () => observation([field]), act: () => undefined },
    );
    const deps: ComputerLoopDeps = {
      ...h.deps,
      act: async () => ({
        grantId: "cug_1",
        revision: 3,
        remainingBudget: 9,
        dispatched: "accessibility-action",
        verified: false,
      }),
    };

    const result = await runComputerLoop({ instruction: "type the text" }, deps);

    expect(result.outcome).not.toBe("done");
  });

  it("does not write a read-back onto a step the host refused", async () => {
    // The model asked for an action the element does not offer. Nothing was
    // dispatched, so the tree that follows says nothing about that action --
    // writing "observed-change" onto it would claim the application reacted
    // to something it never received.
    const readOnly: ComputerNode = { ...saveButton, actions: [] };
    const h = harness([
      '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}',
      '{"kind":"done","summary":"never happened","evidence":[]}',
    ], {
      observe: () => observation([readOnly]),
    });

    const result = await runComputerLoop({ instruction: "click the button" }, h.deps);

    const refused = result.steps.find((step) => step.action === "click");
    expect(refused).toBeDefined();
    expect(refused?.ok).toBe(false);
    expect(refused?.verification).toBe("refused");
    expect(refused?.errorCode).toBe("COMPUTER_ACTION_REJECTED");
    expect(h.acted).toHaveLength(0);
  });

  it("re-observes stale completion evidence and accepts only a UID in the latest Host observation", async () => {
    let observations = 0;
    const h = harness([
      '{"kind":"action","action":{"kind":"hover","uid":"0.1#ab"}}',
      '{"kind":"done","summary":"finished","evidence":["0.1#ab"]}',
      '{"kind":"done","summary":"finished","evidence":["0.2#cd"]}',
    ], {
      act: () => undefined,
      observe: () => {
        observations += 1;
        const oldNode = { ...saveButton, actions: ["hover"] as ComputerNode["actions"] };
        return observation([observations === 1 ? oldNode : { ...saveButton, uid: "0.2#cd", label: "Saved" }]);
      },
    });

    const result = await runComputerLoop({ instruction: "check the document" }, h.deps);

    expect(observations).toBe(4);
    expect(h.decisions).toBe(3);
    expect(h.acted).toEqual([{ kind: "hover", uid: "0.1#ab" }]);
    expect(result.outcome).toBe("done");
    expect(result.verification).toBe("model-confirmed");
    expect(result.steps).toContainEqual(expect.objectContaining({ action: "done", ok: false, verification: "unverified" }));
    expect(result.steps).toContainEqual(expect.objectContaining({ action: "done", ok: true, verification: "model-confirmed" }));
  });

  it("returns an explicit unverified outcome when the model cannot cite current UIA evidence", async () => {
    const h = harness(['{"kind":"done","summary":"finished"}']);

    const result = await runComputerLoop({ instruction: "check the document" }, h.deps);

    expect(h.decisions).toBe(2);
    expect(h.activity.filter((event) => event.phase === "observing")).toHaveLength(5);
    expect(h.acted).toEqual([]);
    expect(result.outcome).toBe("unverified");
    expect(result.verification).toBe("unverified");
    expect(result.summary).toContain("without claiming completion");
    expect(result.steps.filter((step) => step.action === "done")).toHaveLength(2);
  });

  it("rejects evidence if the accessible UI changes while the model is answering", async () => {
    let observations = 0;
    const h = harness([
      '{"kind":"done","summary":"finished","evidence":["0.1#ab"]}',
      '{"kind":"done","summary":"finished","evidence":["0.1#ab"]}',
    ], {
      observe: () => {
        observations += 1;
        return observation([{ ...saveButton, label: observations === 1 ? "Ready" : "Saved" }]);
      },
    });

    const result = await runComputerLoop({ instruction: "check the saved state" }, h.deps);

    expect(observations).toBe(3);
    expect(h.decisions).toBe(2);
    expect(h.acted).toEqual([]);
    expect(result.outcome).toBe("done");
    expect(result.steps).toContainEqual(expect.objectContaining({ action: "done", ok: false, verification: "unverified" }));
    expect(result.verification).toBe("model-confirmed");
  });

  it("does not treat a screenshot by itself as structured completion evidence", async () => {
    const h = harness(['{"kind":"done","summary":"the visual task is complete"}'], {
      observe: () => observation([], {
        grant: grant({ capture: "a11y-and-pixels" }),
        capture: { mimeType: "image/png", base64: "fixture-only" },
      }),
    });

    const result = await runComputerLoop({ instruction: "confirm the visual state" }, h.deps);

    expect(result.outcome).toBe("unverified");
    expect(result.verification).toBe("unverified");
    expect(h.acted).toEqual([]);
  });

  it("publishes truthful phases and the current action without exposing typed text", async () => {
    const input: ComputerNode = { ...saveButton, role: "AXTextField", label: "Input", hasValue: true, actions: ["set_value"] };
    const h = harness([
      '{"kind":"action","action":{"kind":"set_value","uid":"0.1#ab","text":"secret value"}}',
      '{"kind":"done","summary":"saved","evidence":["0.1#ab"]}',
    ], { observe: () => observation([input]) });

    await runComputerLoop({ instruction: "set the value" }, h.deps);

    expect(h.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "observing" }),
      expect.objectContaining({ phase: "thinking" }),
      expect.objectContaining({ phase: "acting", action: "set_value", target: "Input" }),
    ]));
    expect(JSON.stringify(h.activity)).not.toContain("secret value");
  });

  it("observeOnly describes the scope and dispatches nothing", async () => {
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}']);
    const result = await runComputerLoop({ instruction: "what is on screen", observeOnly: true }, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.acted).toEqual([]);
    expect(h.decisions).toBe(0, "observe-only never asks the model to act");
    expect(result.summary).toContain("1 accessible element");
  });

  it("stops at the step limit without claiming success", async () => {
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}']);
    const result = await runComputerLoop({ instruction: "click forever", maxSteps: 3 }, h.deps);
    expect(result.outcome).toBe("step-limit");
    expect(h.acted).toHaveLength(3);
    expect(result.summary).toContain("may be unfinished");
  });

  it("re-observes the final action even when it reaches the per-call step limit", async () => {
    let dispatched = false;
    const observedStates: string[] = [];
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}'], {
      act: () => { dispatched = true; },
      observe: () => {
        const label = dispatched ? "CU-FIXTURE-AFTER" : "CU-FIXTURE-BEFORE";
        observedStates.push(label);
        return observation([{ ...saveButton, label }]);
      },
    });

    const result = await runComputerLoop({ instruction: "click once", maxSteps: 1 }, h.deps);

    expect(result.outcome).toBe("step-limit");
    expect(observedStates).toEqual(["CU-FIXTURE-BEFORE", "CU-FIXTURE-AFTER"]);
  });

  it("gives up after repeated unusable answers", async () => {
    const h = harness(["I clicked Save for you."]);
    const result = await runComputerLoop({ instruction: "save" }, h.deps);
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("COMPUTER_ACTION_REJECTED");
    expect(h.acted).toEqual([]);
  });

  it("retries one malformed model answer without spending an action step", async () => {
    const h = harness(["{not json}", '{"kind":"done","summary":"already saved","evidence":["0.1#ab"]}']);
    const result = await runComputerLoop({ instruction: "save", maxSteps: 1 }, h.deps);
    expect(result.outcome).toBe("done");
    expect(h.decisions).toBe(2);
    expect(h.acted).toEqual([]);
  });

  it("surfaces a question instead of guessing", async () => {
    const h = harness(['{"kind":"ask","question":"which document?"}']);
    const result = await runComputerLoop({ instruction: "save it" }, h.deps);
    expect(result.outcome).toBe("needs-user");
    expect(result.question).toBe("which document?");
    expect(h.acted).toEqual([]);
  });

  it("treats a revoked grant as terminal and stops immediately", async () => {
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}'], {
      act: () => {
        throw coded("COMPUTER_GRANT_EXPIRED");
      },
    });
    const result = await runComputerLoop({ instruction: "save", maxSteps: 5 }, h.deps);
    expect(result.outcome).toBe("expired");
    expect(result.errorCode).toBe("COMPUTER_GRANT_EXPIRED");
    expect(h.decisions).toBe(1, "a terminal refusal is not retried");
  });

  it("reports a budget refusal as its own outcome", async () => {
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}'], {
      act: () => {
        throw coded("COMPUTER_BUDGET_EXHAUSTED");
      },
    });
    const result = await runComputerLoop({ instruction: "save" }, h.deps);
    expect(result.outcome).toBe("budget-exhausted");
  });

  it("stops when the same non-terminal refusal repeats", async () => {
    const h = harness(['{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}'], {
      act: () => {
        throw coded("COMPUTER_ELEMENT_NOT_ACTIONABLE");
      },
    });
    const result = await runComputerLoop({ instruction: "save", maxSteps: 8 }, h.deps);
    expect(result.outcome).toBe("failed");
    expect(result.steps.filter((step) => !step.ok)).toHaveLength(2);
  });

  it("refuses an invented uid without reaching the host", async () => {
    const h = harness([
      '{"kind":"action","action":{"kind":"click","uid":"9.9#ff"}}',
      '{"kind":"done","summary":"gave up","evidence":["0.1#ab"]}',
    ]);
    const result = await runComputerLoop({ instruction: "save" }, h.deps);
    expect(h.acted).toEqual([]);
    expect(result.steps[0]).toMatchObject({ ok: false, errorCode: "COMPUTER_ACTION_REJECTED" });
  });

  it("fails closed when the first observation is refused", async () => {
    const deps: ComputerLoopDeps = {
      observe: async () => {
        throw coded("COMPUTER_SECURE_INPUT_REFUSED");
      },
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () => '{"kind":"done","summary":"x","evidence":["0.1#ab"]}',
    };
    const result = await runComputerLoop({ instruction: "save" }, deps);
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("COMPUTER_SECURE_INPUT_REFUSED");
  });

  it("draws the cursor around each action and hides it at the end", async () => {
    const h = harness([
      '{"kind":"action","action":{"kind":"click","uid":"0.1#ab"}}',
      '{"kind":"done","summary":"saved","evidence":["0.1#ab"]}',
    ]);
    await runComputerLoop({ instruction: "save" }, h.deps);
    const kinds = h.cursor.map((event) => event.kind);
    expect(kinds[0]).toBe("show");
    expect(kinds).toContain("move");
    expect(kinds).toContain("press");
    expect(kinds[kinds.length - 1]).toBe("hide");
    const move = h.cursor.find((event) => event.kind === "move");
    // The drawn point is the element's centre, in screen coordinates.
    expect(move).toMatchObject({ x: 190, y: 212 });
  });

  it("switches to another window without spending an action", async () => {
    const asked: (string | undefined)[] = [];
    const cursor: ComputerCursorEvent[] = [];
    const answers = ['{"kind":"switch","window":"88:4","note":"the task is over there"}', '{"kind":"done","summary":"read it","evidence":["0.1#ab"]}'];
    let decisions = 0;
    const deps: ComputerLoopDeps = {
      observe: async (targetId) => {
        asked.push(targetId);
        return observation([saveButton], {
          grant: grant(
            targetId
              ? { targetId, targetLabel: "Other — Inbox", revision: 4, bounds: { x: 0, y: 0, width: 400, height: 300 } }
              : {},
          ),
          windows: [
            { targetId: "77:12", appName: "Example", title: "Document", appKey: "example", bounds: grant().bounds },
            { targetId: "88:4", appName: "Other", title: "Inbox", appKey: "other", bounds: grant().bounds },
          ],
        });
      },
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () => answers[Math.min(decisions++, answers.length - 1)],
      onCursor: (event) => cursor.push(event),
    };
    const result = await runComputerLoop({ instruction: "read the inbox" }, deps);
    expect(result.outcome).toBe("done");
    expect(asked).toEqual([undefined, "88:4", "88:4"]);
    expect(result.steps[0]).toMatchObject({ action: "switch", ok: true, target: "Other — Inbox" });
    // A switch is a read: it must not read as work done on the machine.
    expect(result.summary).toContain("No action was dispatched.");
    // The overlay follows the window being worked on.
    expect(cursor.filter((event) => event.kind === "show")).toHaveLength(2);
  });

  it("canonicalizes a copied window label to its exact host-issued id", async () => {
    const observed: (string | undefined)[] = [];
    let decisions = 0;
    let renderedObservation = "";
    const entry = { targetId: "35316:855254:probe.exe", appName: "probe.exe", title: "CU Probe Target", appKey: "probe.exe", bounds: grant().bounds };
    const deps: ComputerLoopDeps = {
      observe: async (targetId) => {
        observed.push(targetId);
        return observation([saveButton], {
          grant: grant(targetId ? { targetId, targetLabel: "probe.exe — CU Probe Target" } : {}),
          windows: [entry],
        });
      },
      act: async () => { throw new Error("must not act"); },
      decide: async (request) => {
        renderedObservation = request.observation;
        return [
          '{"kind":"switch","window":"35316:855254:probe.exe probe.exe — CU Probe Target"}',
          '{"kind":"done","summary":"read it","evidence":["0.1#ab"]}',
        ][Math.min(decisions++, 1)];
      },
    };

    const result = await runComputerLoop({ instruction: "read the target" }, deps);
    expect(result.outcome).toBe("done");
    expect(observed).toEqual([undefined, "35316:855254:probe.exe", "35316:855254:probe.exe"]);
    expect(renderedObservation).toContain('window_id="35316:855254:probe.exe" label="probe.exe — CU Probe Target"');
  });

  it("does not prefix-match or send an unrecognized window label to Host", async () => {
    const observed: (string | undefined)[] = [];
    let decisions = 0;
    const entry = { targetId: "35316:855254:probe.exe", appName: "probe.exe", title: "CU Probe Target", appKey: "probe.exe", bounds: grant().bounds };
    const deps: ComputerLoopDeps = {
      observe: async (targetId) => {
        observed.push(targetId);
        return observation([saveButton], { windows: [entry] });
      },
      act: async () => { throw new Error("must not act"); },
      decide: async () => [
        '{"kind":"switch","window":"35316:855254:probe.exe unexpected suffix"}',
        '{"kind":"done","summary":"stopped safely","evidence":["0.1#ab"]}',
      ][Math.min(decisions++, 1)],
    };

    const result = await runComputerLoop({ instruction: "read the target" }, deps);
    expect(result.outcome).toBe("done");
    expect(observed).toEqual([undefined, grant().targetId]);
    expect(result.steps[0]).toMatchObject({ action: "switch", ok: false, errorCode: "COMPUTER_TARGET_UNAVAILABLE" });
  });

  it("retries a temporarily unavailable switch only against the requested target", async () => {
    const observed: (string | undefined)[] = [];
    let failures = 0;
    let decisions = 0;
    const deps: ComputerLoopDeps = {
      observe: async (targetId) => {
        observed.push(targetId);
        if (targetId && failures++ < 2) throw coded("COMPUTER_TARGET_UNAVAILABLE");
        return observation([saveButton], {
          grant: grant(targetId ? { targetId, targetLabel: "Other — Inbox" } : {}),
          windows: [{ targetId: "88:4", appName: "Other", title: "Inbox", appKey: "other", bounds: grant().bounds }],
        });
      },
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () =>
        [
          '{"kind":"switch","window":"88:4"}',
          '{"kind":"done","summary":"read it","evidence":["0.1#ab"]}',
        ][Math.min(decisions++, 1)],
    };

    const result = await runComputerLoop({ instruction: "read the inbox" }, deps);
    expect(result.outcome).toBe("done");
    expect(observed).toEqual([undefined, "88:4", "88:4", "88:4", "88:4"]);
    expect(result.steps).toEqual([
      expect.objectContaining({ action: "switch", ok: true }),
      expect.objectContaining({ action: "done", ok: true, verification: "model-confirmed" }),
    ]);
  });

  it("reports a refused window but does not claim done without current UIA evidence", async () => {
    const answers = ['{"kind":"switch","window":"self"}', '{"kind":"done","summary":"left it alone","evidence":["0.1#ab"]}'];
    let decisions = 0;
    const deps: ComputerLoopDeps = {
      observe: async (targetId) => {
        if (targetId === "self") throw coded("COMPUTER_SELF_TARGET_REFUSED");
        if (targetId && targetId !== grant().targetId) throw coded("COMPUTER_TARGET_UNAVAILABLE");
        return observation([], { windows: [{ targetId: "self", appName: "PI-Desktop", title: "", appKey: "pi", bounds: grant().bounds, refusedReason: "self" }] });
      },
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () => answers[Math.min(decisions++, answers.length - 1)],
    };
    const result = await runComputerLoop({ instruction: "click PI-Desktop's own approve button" }, deps);
    expect(result.outcome).toBe("unverified");
    expect(result.steps[0]).toMatchObject({
      action: "switch",
      ok: false,
      errorCode: "COMPUTER_SELF_TARGET_REFUSED",
    });
  });

  it("stops when the grant dies during a switch", async () => {
    const deps: ComputerLoopDeps = {
      observe: async (targetId) => {
        if (targetId) throw coded("COMPUTER_GRANT_EXPIRED");
        return observation([], { windows: [{ targetId: "88:4", appName: "Other", title: "Inbox", appKey: "other", bounds: grant().bounds }] });
      },
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () => '{"kind":"switch","window":"88:4"}',
    };
    const result = await runComputerLoop({ instruction: "look at the other window", maxSteps: 5 }, deps);
    expect(result.outcome).toBe("expired");
    expect(result.errorCode).toBe("COMPUTER_GRANT_EXPIRED");
  });

  it("hides the cursor even when the loop throws", async () => {
    const cursor: ComputerCursorEvent[] = [];
    const deps: ComputerLoopDeps = {
      observe: async () => observation(),
      act: async () => {
        throw new Error("boom");
      },
      decide: async () => {
        throw new Error("provider exploded");
      },
      onCursor: (event) => cursor.push(event),
    };
    const result = await runComputerLoop({ instruction: "save" }, deps);
    expect(result.outcome).toBe("failed");
    expect(cursor[cursor.length - 1]?.kind).toBe("hide");
  });

  // -------------------------------------------------------------------------
  // Regressions for the "churning uid" defect.
  //
  // These are the two tests whose absence let the bug ship. Every other test in
  // this file stubs `observe` to return the same fixed uid (`0.1#ab`) forever,
  // which is the OPPOSITE of what the cua backend does: it re-mints
  // `{snapshot}:{row}` on every read. Under a fixed-uid stub both the change
  // signal and the completion check look healthy, because uid equality happens
  // to hold.
  //
  // So the stub below re-mints uids per tick and keeps `identity` stable, which
  // is exactly the live wire shape.
  // -------------------------------------------------------------------------
  describe("with a uid that is re-minted on every observation", () => {
    /** Same element, new uid each time — the cua backend's real behaviour. */
    function churn(tick: number, nodes: Array<Omit<ComputerNode, "uid">>): Observation {
      return observation(
        nodes.map((node, i) => ({ ...node, uid: `s${String(tick).padStart(8, "0")}:${i}` })),
      );
    }

    const saveByPath: Omit<ComputerNode, "uid"> = {
      identity: "pane#0/button#0",
      role: "button",
      label: "Save",
      hasValue: false,
      enabled: true,
      focused: false,
      actions: ["click"],
    };

    it("reports observed-no-change when the tree is identical under new uids", async () => {
      // A keystroke that changes nothing must read back as "no change". Before
      // the fix the signature included `uid`, so two reads of an untouched
      // window always differed and this outcome was unreachable.
      let tick = 1;
      const seen: string[] = [];
      const h = harness(
        [
          '{"kind":"action","action":{"kind":"press_keys","keys":["cmd+a"],"uid":"PLACEHOLDER"}}',
          '{"kind":"done","summary":"selected","evidence":[]}',
        ],
        { observe: () => churn(tick++, [saveByPath]) },
      );
      const deps: ComputerLoopDeps = {
        ...h.deps,
        observe: async () => {
          const next = await h.deps.observe();
          seen.push(next.inspection.nodes[0].uid);
          return next;
        },
        decide: async () => {
          const raw = (await h.deps.decide()) as string;
          return raw.replaceAll("PLACEHOLDER", seen[seen.length - 1] ?? "");
        },
      };

      const result = await runComputerLoop({ instruction: "select all", maxSteps: 3 }, deps);

      expect(result.steps).toContainEqual(
        expect.objectContaining({ action: "press_keys", verification: "observed-no-change" }),
      );
    });

    it("accepts completion evidence whose uid was re-minted between the decision and the check", async () => {
      // The model cites the uid it saw while deciding; the host re-reads before
      // validating. Those are different uids for the same element, and before
      // the fix the two uid sets never intersected — so `done` could not
      // succeed at all on the cua backend.
      let tick = 1;
      const seen: string[] = [];
      const h = harness(
        [
          '{"kind":"action","action":{"kind":"click","uid":"PLACEHOLDER"}}',
          '{"kind":"done","summary":"saved","evidence":["PLACEHOLDER"]}',
        ],
        { observe: () => churn(tick++, [saveByPath]) },
      );
      const deps: ComputerLoopDeps = {
        ...h.deps,
        observe: async () => {
          const next = await h.deps.observe();
          seen.push(next.inspection.nodes[0].uid);
          return next;
        },
        decide: async () => {
          const raw = (await h.deps.decide()) as string;
          return raw.replaceAll("PLACEHOLDER", seen[seen.length - 1] ?? "");
        },
      };

      const result = await runComputerLoop({ instruction: "save", maxSteps: 4 }, deps);

      expect(result.outcome).toBe("done");
      expect(result.verification).toBe("model-confirmed");
      expect(result.steps).toContainEqual(
        expect.objectContaining({ action: "done", ok: true, verification: "model-confirmed" }),
      );
    });

    it("refuses completion evidence when identical siblings make the ordinal identity ambiguous", async () => {
      let tick = 1;
      let latestUid = "";
      const identicalSibling = { ...saveByPath, identity: "pane#0/button#1" };
      const h = harness([], {
        observe: () => churn(tick++, [saveByPath, identicalSibling]),
      });
      const deps: ComputerLoopDeps = {
        ...h.deps,
        observe: async () => {
          const next = await h.deps.observe();
          latestUid = next.inspection.nodes[0].uid;
          return next;
        },
        decide: async () => JSON.stringify({
          kind: "done",
          summary: "saved",
          evidence: [latestUid],
        }),
      };

      const result = await runComputerLoop({ instruction: "save", maxSteps: 4 }, deps);

      expect(result.outcome).toBe("unverified");
      expect(result.verification).toBe("unverified");
      expect(result.steps).not.toContainEqual(
        expect.objectContaining({ action: "done", ok: true, verification: "model-confirmed" }),
      );
    });

    it("rejects evidence whose element changed after the model last saw it", async () => {
      // The fix must not turn the check into a rubber stamp. The model cites the
      // uid it saw; by the time the host validates, that same element (same
      // identity) has a different accessibility state. That is a refusal.
      //
      // The citation is pinned to the FIRST observation on purpose: the loop
      // lets the model retry a rejected done against a fresh read, which would
      // otherwise make this pass for the wrong reason.
      let tick = 1;
      let firstUid = "";
      const h = harness(
        [
          '{"kind":"action","action":{"kind":"click","uid":"PLACEHOLDER"}}',
          '{"kind":"done","summary":"saved","evidence":["PLACEHOLDER"]}',
        ],
        {
          observe: () => {
            // Enabled for the read the model acts from, disabled from then on.
            const node = tick >= 2 ? { ...saveByPath, enabled: false } : saveByPath;
            return churn(tick++, [node]);
          },
        },
      );
      const deps: ComputerLoopDeps = {
        ...h.deps,
        observe: async () => {
          const next = await h.deps.observe();
          if (firstUid === "") firstUid = next.inspection.nodes[0].uid;
          return next;
        },
        decide: async () => {
          const raw = (await h.deps.decide()) as string;
          return raw.replaceAll("PLACEHOLDER", firstUid);
        },
      };

      const result = await runComputerLoop({ instruction: "save", maxSteps: 2 }, deps);

      expect(result.outcome).toBe("unverified");
      expect(result.steps).toContainEqual(
        expect.objectContaining({ action: "done", ok: false, verification: "unverified" }),
      );
    });

    it("closes as self-reported when a dispatched action provably changed nothing", async () => {
      // A selection, a scroll position, a key that changes nothing on screen:
      // the tree genuinely did not move, so no citation can ever validate. The
      // agent may close with an empty evidence list, and the loop labels the
      // outcome as self-reported rather than pretending it was verified.
      let tick = 1;
      let firstUid = "";
      const h = harness(
        [
          '{"kind":"action","action":{"kind":"press_keys","keys":["cmd+a"],"uid":"PLACEHOLDER"}}',
          '{"kind":"done","summary":"selected all","evidence":[]}',
        ],
        { observe: () => churn(tick++, [saveByPath]) },
      );
      const deps: ComputerLoopDeps = {
        ...h.deps,
        observe: async () => {
          const next = await h.deps.observe();
          if (firstUid === "") firstUid = next.inspection.nodes[0].uid;
          return next;
        },
        decide: async () => {
          const raw = (await h.deps.decide()) as string;
          return raw.replaceAll("PLACEHOLDER", firstUid);
        },
      };

      const result = await runComputerLoop({ instruction: "select all", maxSteps: 4 }, deps);

      expect(result.outcome).toBe("unverified");
      expect(result.verification).toBe("unverified-by-design");
      expect(result.steps).toContainEqual(
        expect.objectContaining({ action: "press_keys", verification: "observed-no-change" }),
      );
      expect(result.steps).toContainEqual(
        expect.objectContaining({ action: "done", ok: false, verification: "unverified-by-design" }),
      );
      expect(h.activity).toContainEqual(
        expect.objectContaining({ phase: "unverified", verification: "unverified-by-design" }),
      );
    });

    it("does not accept an empty evidence list when the tree did change", async () => {
      // The escape hatch must stay narrow: if the read-back said the tree moved,
      // there is something to cite, so an empty list is still a refusal.
      let tick = 1;
      let firstUid = "";
      const h = harness(
        [
          '{"kind":"action","action":{"kind":"click","uid":"PLACEHOLDER"}}',
          '{"kind":"done","summary":"saved","evidence":[]}',
        ],
        {
          observe: () => {
            // The label changes on every read, so the tree never looks still.
            const node = { ...saveByPath, label: `Save ${tick}` };
            return churn(tick++, [node]);
          },
        },
      );
      const deps: ComputerLoopDeps = {
        ...h.deps,
        observe: async () => {
          const next = await h.deps.observe();
          if (firstUid === "") firstUid = next.inspection.nodes[0].uid;
          return next;
        },
        decide: async () => {
          const raw = (await h.deps.decide()) as string;
          return raw.replaceAll("PLACEHOLDER", firstUid);
        },
      };

      const result = await runComputerLoop({ instruction: "save", maxSteps: 2 }, deps);

      expect(result.steps).toContainEqual(
        expect.objectContaining({ action: "done", ok: false, verification: "unverified" }),
      );
    });

    it("tells the model it is repeating itself once the tree keeps not changing", () => {
      // A real run sent `ctrl+a` five times and clicked a non-clickable field
      // twice before hitting the step limit. The verification was honest; the
      // model simply had no signal that repeating would not help.
      const still = (index: number) => ({
        index,
        action: "press_keys" as const,
        ok: true,
        verification: "observed-no-change" as const,
      });
      const hint = "Do not keep repeating the same action";

      // One no-change step is not enough to call it stuck.
      expect(renderHistory([still(0)])).not.toContain(hint);
      // Two consecutive ones are.
      expect(renderHistory([still(0), still(1)])).toContain(hint);
    });

    it("does not call it stuck when the tree did change", () => {
      // The hint must stay specific: a real change means progress, and saying
      // "you are stuck" there would steer the model away from a working action.
      const hint = "Do not keep repeating the same action";
      const changed = {
        index: 0,
        action: "click" as const,
        ok: true,
        verification: "observed-change" as const,
      };
      const still = {
        index: 1,
        action: "press_keys" as const,
        ok: true,
        verification: "observed-no-change" as const,
      };
      expect(renderHistory([changed, still])).not.toContain(hint);
    });
  });
});

describe("repeated write guard", () => {
  // The element list renders `has-value`, never the value, so a model cannot
  // tell a landed write from a lost one. Without a guard it answered by
  // writing the same value into the same field over and over.
  const textField: ComputerNode = {
    uid: "0.2#cd",
    identity: "AXTextField#0",
    role: "AXTextField",
    label: "Name",
    hasValue: true,
    enabled: true,
    focused: false,
    bounds: { x: 150, y: 240, width: 200, height: 24 },
    actions: ["set_value"],
  };

  it("dispatches the same write to the same field only once", async () => {
    const write = JSON.stringify({
      kind: "action",
      action: { kind: "set_value", uid: textField.uid, text: "PI-INTERNAL-PROBE" },
    });
    const h = harness([write], { observe: () => observation([textField]) });
    const result = await runComputerLoop({ instruction: "set the name", maxSteps: 6 }, h.deps);

    const writes = h.acted.filter((action) => action.kind === "set_value");
    expect(writes.length).toBe(1);
    expect(result.steps.filter((step) => step.action === "set_value").length).toBeGreaterThanOrEqual(1);
  });

  it("still dispatches a different value to the same field", async () => {
    const first = JSON.stringify({
      kind: "action",
      action: { kind: "set_value", uid: textField.uid, text: "one" },
    });
    const second = JSON.stringify({
      kind: "action",
      action: { kind: "set_value", uid: textField.uid, text: "two" },
    });
    const h = harness([first, second], { observe: () => observation([textField]) });
    await runComputerLoop({ instruction: "set the name", maxSteps: 6 }, h.deps);

    const writes = h.acted.filter((action) => action.kind === "set_value");
    expect(writes.map((action) => action.text)).toEqual(["one", "two"]);
  });

  it("leaves repeated clicks alone", async () => {
    const click = JSON.stringify({ kind: "action", action: { kind: "click", uid: saveButton.uid } });
    const h = harness([click], { observe: () => observation([saveButton]) });
    await runComputerLoop({ instruction: "click save twice", maxSteps: 6 }, h.deps);

    const clicks = h.acted.filter((action) => action.kind === "click");
    expect(clicks.length).toBeGreaterThan(1);
  });
});
describe("switch to the current window", () => {
  // Switching to the window already in focus changes nothing. Recorded as a
  // success it told the model the switch had worked, and a model that could
  // not find its window answered by switching again and again until the step
  // limit ran out.
  it("treats a switch to the window already in focus as a no-op, not a failure", async () => {
    // The model asked to be where the host already is. Recorded as a refusal
    // it told the model the switch had failed, and a model that could not find
    // its window answered by switching again and again until the step limit
    // ran out.
    const answers = [
      '{"kind":"switch","window":"77:12","note":"over here"}',
      '{"kind":"done","summary":"already there","evidence":["0.1#ab"]}',
    ];
    let decisions = 0;
    const deps: ComputerLoopDeps = {
      observe: async () =>
        observation([saveButton], {
          windows: [
            { targetId: "77:12", appName: "Example", title: "Document", appKey: "example", bounds: grant().bounds },
          ],
        }),
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () => answers[Math.min(decisions++, answers.length - 1)],
    };
    const result = await runComputerLoop({ instruction: "look at this" }, deps);
    const switchStep = result.steps.find((step) => step.action === "switch");
    expect(switchStep).toMatchObject({ ok: true, verification: "observed" });
    expect(switchStep?.errorCode).toBeUndefined();
  });

  it("stops a run that keeps switching to the same window", async () => {
    // The model never found its window and answered with the same switch every
    // time. Two identical refusals end the run instead of burning the steps.
    const answers = ['{"kind":"switch","window":"77:12","note":"over here"}'];
    let decisions = 0;
    const deps: ComputerLoopDeps = {
      observe: async () =>
        observation([saveButton], {
          windows: [
            { targetId: "77:12", appName: "Example", title: "Document", appKey: "example", bounds: grant().bounds },
          ],
        }),
      act: async () => {
        throw new Error("must not act");
      },
      decide: async () => answers[Math.min(decisions++, answers.length - 1)],
    };
    const result = await runComputerLoop({ instruction: "look at this", maxSteps: 20 }, deps);
    expect(result.outcome).toBe("failed");
    expect(result.steps.filter((step) => step.action === "switch")).toHaveLength(2);
  });
});
describe("completion evidence for a consumed element", () => {
  // A menu item disappears the moment it is clicked — that is what closing a
  // menu means. A model that cites the item it just clicked cites a uid that
  // no longer resolves, and the completion check refused a click that plainly
  // landed.
  it("accepts a citation for an element the action consumed", async () => {
    const menuItem = {
      uid: "0.9#mm",
      identity: "AXMenuItem#0",
      role: "AXMenuItem",
      label: "全选",
      hasValue: false,
      enabled: true,
      focused: false,
      bounds: { x: 20, y: 30, width: 90, height: 22 },
      actions: ["click" as const],
    };
    const clickItem = JSON.stringify({ kind: "action", action: { kind: "click", uid: menuItem.uid } });
    const doneCitingItem = JSON.stringify({
      kind: "done",
      summary: "clicked 全选",
      evidence: [menuItem.uid],
    });

    let decisions = 0;
    let observes = 0;
    const deps: ComputerLoopDeps = {
      observe: async () => {
        observes += 1;
        // 1: decision read (menu open) · 2: read after the click (menu closed)
        // · 3: the read that verifies the done answer (menu still closed)
        const menuOpen = observes === 1 || observes === 3;
        return observation(menuOpen ? [menuItem] : []);
      },
      act: async () => ({ grantId: "cug_1", revision: 3, remainingBudget: 9, dispatched: "accessibility-action" }),
      decide: async () => (decisions++ === 0 ? clickItem : doneCitingItem),
    };

    const result = await runComputerLoop({ instruction: "click 全选", maxSteps: 6 }, deps);
    expect(result.outcome).toBe("unverified");
    expect(result.verification).toBe("unverified-by-design");
    expect(result.steps.some((step) => step.action === "click" && step.ok)).toBe(true);
  });

  it("still refuses a citation for an element the action did not consume", async () => {
    const menuItem = {
      uid: "0.9#mm",
      identity: "AXMenuItem#0",
      role: "AXMenuItem",
      label: "全选",
      hasValue: false,
      enabled: true,
      focused: false,
      bounds: { x: 20, y: 30, width: 90, height: 22 },
      actions: ["click" as const],
    };
    const clickItem = JSON.stringify({ kind: "action", action: { kind: "click", uid: menuItem.uid } });
    // The model cites a uid it was never shown.
    const doneCitingGhost = JSON.stringify({
      kind: "done",
      summary: "clicked something",
      evidence: ["0.9#ghost"],
    });

    let decisions = 0;
    let observes = 0;
    const deps: ComputerLoopDeps = {
      observe: async () => {
        observes += 1;
        return observation(observes <= 1 ? [menuItem] : []);
      },
      act: async () => ({ grantId: "cug_1", revision: 3, remainingBudget: 9, dispatched: "accessibility-action" }),
      decide: async () => (decisions++ === 0 ? clickItem : doneCitingGhost),
    };

    const result = await runComputerLoop({ instruction: "click 全选", maxSteps: 6 }, deps);
    // The citation names a uid the model was never shown, so this is not the
    // consumed-element case: it must not be reported as one.
    expect(result.verification).not.toBe("unverified-by-design");
  });
});