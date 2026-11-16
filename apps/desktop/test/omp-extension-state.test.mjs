import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOmpEditorText, ompExtensionRequestNeedsResponse, ompSelectOptionKind, updateOmpStatusMap, updateOmpWidgetMap } from "../src/components/omp-extension-state.mjs";

test("OMP status slots update and clear independently with bounded keys and content", () => {
  let state = updateOmpStatusMap({}, "compile", "Compiling");
  state = updateOmpStatusMap(state, "tests", "Tests running");
  assert.deepEqual(state, { compile: "Compiling", tests: "Tests running" });
  state = updateOmpStatusMap(state, "compile", undefined);
  assert.deepEqual(state, { tests: "Tests running" });
  assert.equal(updateOmpStatusMap({}, "x", "s".repeat(2500)).x.length, 2000);
});

test("OMP widgets are keyed, placement-aware, removable, and bounded", () => {
  let state = updateOmpWidgetMap({}, "tasks", ["one", "two"], "belowEditor");
  state = updateOmpWidgetMap(state, "summary", ["ok"], "aboveEditor");
  assert.deepEqual(state.tasks, { key: "tasks", lines: ["one", "two"], placement: "belowEditor" });
  assert.deepEqual(state.summary, { key: "summary", lines: ["ok"], placement: "aboveEditor" });
  state = updateOmpWidgetMap(state, "tasks", undefined);
  assert.equal(state.tasks, undefined);
  const capped = updateOmpWidgetMap({}, "wide", ["x".repeat(5000), "tail"], "unexpected");
  assert.equal(capped.wide.lines[0].length, 2000);
  assert.equal(capped.wide.placement, "aboveEditor");
  assert.equal(normalizeOmpEditorText("draft"), "draft");
  assert.equal(normalizeOmpEditorText("x".repeat(64_001)), null);
});

test("OMP select requests preserve checkbox toggles and unmarked action rows", () => {
  const request = { options: ["one", "two", "done"], selectionMarker: "checkbox", checkedIndices: [1], markableCount: 2 };
  assert.equal(ompSelectOptionKind(request, 0), "checkbox");
  assert.equal(ompSelectOptionKind(request, 1), "checkbox");
  assert.equal(ompSelectOptionKind(request, 2), "action");
  assert.equal(ompSelectOptionKind({ ...request, markableCount: 20 }, 2), "checkbox", "the markable count is clamped to the option list");
  assert.equal(ompSelectOptionKind({ options: ["a", "b"], selectionMarker: "radio", markableCount: 1 }, 1), "action");
  assert.equal(ompSelectOptionKind({ options: ["a"] }, 0), "radio", "legacy simple selects remain single-choice");
  assert.equal(ompExtensionRequestNeedsResponse("select"), true);
  assert.equal(ompExtensionRequestNeedsResponse("open_url"), false, "open_url is fire-and-forget");
});

test("the OMP RPC interaction preserves separate statuses and widgets and does not replace a draft automatically", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../src/components/OmpRpcInteraction.tsx", import.meta.url), "utf8");
  assert.match(source, /updateOmpStatusMap/);
  assert.match(source, /updateOmpWidgetMap/);
  assert.match(source, /normalizeOmpEditorText/);
  assert.match(source, /checkboxSelect \? void answer\(undefined, label\)/);
  assert.match(source, /role=\{checkboxSelect \? "group" : "radiogroup"\}/);
  assert.match(source, /open_url is a fire-and-forget RPC notification/);
  assert.match(source, /ompExtensionRequestNeedsResponse\(request\?\.method\)/);
  assert.match(source, /append: true/);
  assert.doesNotMatch(source, /setState\(\{ composerPrefill: \{ sessionId, text: frame\.text, fileReferences: \[\] \} \}\)/);
});
