import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composerEngineMenuFocusIndex,
} from "../src/features/chat/composer/omp-engine-compatibility.mjs";
import { readFile } from "node:fs/promises";

describe("OMP native engine selection", () => {
  it("keeps OMP independent from PI provider protocol compatibility", async () => {
    const picker = await readFile(new URL("../src/features/chat/composer/ComposerEnginePicker.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(picker, /ompProviderCompatibilityIssue/);
    assert.doesNotMatch(picker, /provider\?\.apiStyle/);
    assert.match(picker, /getOmpEngineStatus/);
  });

  it("moves menu focus with arrows and Home/End while skipping disabled entries", () => {
    const items = [{ disabled: false }, { disabled: true }, { disabled: false }];
    assert.equal(composerEngineMenuFocusIndex(items, 0, "ArrowDown"), 2);
    assert.equal(composerEngineMenuFocusIndex(items, 2, "ArrowDown"), 0);
    assert.equal(composerEngineMenuFocusIndex(items, 2, "ArrowUp"), 0);
    assert.equal(composerEngineMenuFocusIndex(items, 0, "End"), 2);
    assert.equal(composerEngineMenuFocusIndex(items, 2, "Home"), 0);
    assert.equal(composerEngineMenuFocusIndex(items, 0, "Enter"), -1);
  });
});
