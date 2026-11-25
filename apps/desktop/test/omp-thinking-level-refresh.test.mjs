import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeOmpModelPickerRows, selectOmpModelAndRefreshThinkingLevels } from "../src/features/chat/composer/omp-model-selection.mjs";

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

test("OMP 19.2 quick-role model picks preserve native role and auto effort", async () => {
  const commands = [];
  await selectOmpModelAndRefreshThinkingLevels({
    rpcCommand: async (input) => {
      commands.push(input);
      return input.command === "get_available_thinking_levels" ? { data: { levels: ["auto", "off", "high"] } } : { data: {} };
    },
    sessionId: "omp-session",
    provider: "openai",
    modelId: "gpt-model",
    role: "plan",
    thinkingLevel: "auto",
  });

  assert.deepEqual(commands[0], {
    sessionId: "omp-session",
    command: "set_model",
    fields: { provider: "openai", modelId: "gpt-model", role: "plan", thinkingLevel: "auto" },
  });
  assert.deepEqual(commands[1].command, "get_available_thinking_levels");
});

test("a successful OMP model switch stays successful when the follow-up thinking lookup fails", async () => {
  const transitions = [];
  const levels = await selectOmpModelAndRefreshThinkingLevels({
    rpcCommand: async ({ command }) => {
      transitions.push(command);
      if (command === "get_available_thinking_levels") throw new Error("capability refresh unavailable");
      return { data: {} };
    },
    sessionId: "omp-session",
    provider: "openai",
    modelId: "gpt-model",
    role: "plan",
    thinkingLevel: "auto",
    onModelApplied: () => transitions.push("model-applied"),
    onThinkingLevels: (reported) => transitions.push(`levels:${reported.length}`),
    onThinkingLevelsError: (error) => transitions.push(`refresh-error:${error.message}`),
  });

  assert.deepEqual(transitions, [
    "set_model",
    "model-applied",
    "get_available_thinking_levels",
    "levels:0",
    "refresh-error:capability refresh unavailable",
  ]);
  assert.deepEqual(levels, []);
});

test("OMP 19.2 model-picker rows retain validated quick-role metadata only", () => {
  assert.deepEqual(normalizeOmpModelPickerRows({ data: { rows: [
    { provider: "openai", id: "gpt-model", name: "GPT", role: "plan", thinkingLevel: "auto", current: true, roles: [{ role: "plan", label: "Plan" }], thinking: ["auto", "high"] },
    { provider: "", id: "invalid" },
    { provider: "openai", id: "unsafe", role: "main", thinkingLevel: "surprise", current: "yes" },
  ] } }), [
    { provider: "openai", id: "gpt-model", name: "GPT", role: "plan", thinkingLevel: "auto", current: true, roles: [{ role: "plan", label: "Plan" }], thinking: ["auto", "high"] },
    { provider: "openai", id: "unsafe", name: "unsafe", role: "main" },
  ]);
});

test("the OMP model picker uses the refresh workflow when a model row is chosen", async () => {
  const source = await readFile(new URL("../src/features/chat/composer/ComposerOmpModelPicker.tsx", import.meta.url), "utf8");

  assert.match(source, /selectOmpModelAndRefreshThinkingLevels\(/);
  assert.match(source, /onModelApplied:\s*\(\)\s*=>\s*\{[\s\S]*?setThinkingLevels\(\[\]\)/);
  assert.match(source, /onThinkingLevels:\s*\(levels\)\s*=>\s*\{[\s\S]*?setThinkingLevels\(levels\)/);
  assert.match(source, /let modelApplied = false/);
  assert.match(source, /if \(modelApplied\)[\s\S]*?modelAppliedButRefreshFailed/);
  assert.match(source, /candidate\.role \? candidate\.thinkingLevel \?\? null : null/);
});
