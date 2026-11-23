import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composerEngineMenuFocusIndex,
  deriveOmpEngineIssue,
} from "../src/features/chat/composer/omp-engine-compatibility.mjs";
import { readFile } from "node:fs/promises";

describe("OMP native engine selection", () => {
  it("keeps OMP independent from PI provider protocol compatibility", async () => {
    const picker = await readFile(new URL("../src/features/chat/composer/ComposerEnginePicker.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(picker, /ompProviderCompatibilityIssue/);
    assert.doesNotMatch(picker, /provider\?\.apiStyle/);
    assert.match(picker, /getOmpEngineStatus/);
  });

  it("keeps OMP readiness correlated to engine switches, including cached and unavailable status", async () => {
    const picker = await readFile(new URL("../src/features/chat/composer/ComposerEnginePicker.tsx", import.meta.url), "utf8");
    const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");

    assert.match(picker, /onIssueChange\(engine, issue\), \[engine, issue, onIssueChange\]/);
    assert.match(composer, /setAgentEngineIssueState\(\{ engine, issue \}\)/);
    assert.equal(deriveOmpEngineIssue("omp", { supported: true, installedVersion: "19.0.1" }, false, false), null);
    assert.equal(deriveOmpEngineIssue("pi", { supported: true, installedVersion: "19.0.1" }, false, false), null);
    assert.equal(deriveOmpEngineIssue("omp", null, true, false), "checking");
    assert.equal(deriveOmpEngineIssue("omp", null, false, true), "statusUnavailable");
    assert.equal(deriveOmpEngineIssue("omp", { supported: false, installedVersion: "19.0.1" }, false, false), "unsupportedPlatform");
    assert.equal(deriveOmpEngineIssue("omp", { supported: true, installedVersion: null }, false, false), "notInstalled");
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
