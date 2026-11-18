import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { selectOmpModelAndRefreshThinkingLevels } from "../src/features/chat/composer/omp-model-selection.mjs";

test("switching OMP models replaces the old thinking ladder with the selected model's levels", async () => {
  const commands = [];
  const transitions = [];
  let visibleLevels = ["off"];
  const levels = await selectOmpModelAndRefreshThinkingLevels({
    rpcCommand: async (input) => {
      commands.push(input.command);
      transitions.push(`rpc:${input.command}`);
      if (input.command === "get_available_thinking_levels") {
        return { data: { levels: ["medium", "high", "xhigh", "max"] } };
      }
      return { data: {} };
    },
    sessionId: "omp-session",
    provider: "workbuddy",
    modelId: "hy4flash-free",
    onModelApplied: () => { transitions.push("model-applied"); visibleLevels = []; },
    onThinkingLevels: (next) => { transitions.push("levels-applied"); visibleLevels = next; },
  });

  assert.deepEqual(commands, ["set_model", "get_available_thinking_levels"]);
  assert.deepEqual(transitions, ["rpc:set_model", "model-applied", "rpc:get_available_thinking_levels", "levels-applied"]);
  assert.deepEqual(levels, ["medium", "high", "xhigh", "max"]);
  assert.deepEqual(visibleLevels, ["medium", "high", "xhigh", "max"]);
});

test("a missing OMP thinking-level response clears stale options instead of reusing them", async () => {
  let visibleLevels = ["off"];
  const levels = await selectOmpModelAndRefreshThinkingLevels({
    rpcCommand: async (input) => input.command === "get_available_thinking_levels"
      ? { data: { levels: [] } }
      : { data: {} },
    sessionId: "omp-session",
    provider: "workbuddy",
    modelId: "model-without-thinking",
    onModelApplied: () => { visibleLevels = []; },
    onThinkingLevels: (next) => { visibleLevels = next; },
  });

  assert.deepEqual(levels, []);
  assert.deepEqual(visibleLevels, []);
});

test("the OMP model picker uses the refresh workflow when a model row is chosen", async () => {
  const source = await readFile(new URL("../src/features/chat/composer/ComposerOmpModelPicker.tsx", import.meta.url), "utf8");

  assert.match(source, /selectOmpModelAndRefreshThinkingLevels\(/);
  assert.match(source, /onModelApplied:\s*\(\)\s*=>\s*\{[\s\S]*?setThinkingLevels\(\[\]\)/);
  assert.match(source, /onThinkingLevels:\s*\(levels\)\s*=>\s*\{[\s\S]*?setThinkingLevels\(levels\)/);
});
