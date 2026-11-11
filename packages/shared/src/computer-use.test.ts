import { describe, expect, it } from "vitest";
import {
  COMPUTER_MAX_STEPS_LIMIT,
  COMPUTER_RPC_SCHEMA_MAX,
  COMPUTER_RPC_SCHEMA_MIN,
  COMPUTER_USE_DEFAULTS,
  computerRpcSchemaMismatchMessage,
  computerUseModelBindingForSource,
  isComputerRpcSchemaCompatible,
  needsAccessibilityRequest,
  type ComputerCapabilities,
  validateComputerToolArgs,
  validateComputerUseSettings,
} from "./computer-use.js";

it("computerUse settings accept the minimum shape", () => {
  expect(validateComputerUseSettings({ enabled: false })).toEqual({ enabled: false });
});

it("computerUse settings allow users to override application-level restrictions", () => {
  expect(validateComputerUseSettings({
    enabled: true,
    restrictions: {
      disableAll: true,
      blockSelfTarget: false,
      blockSecureInput: false,
      enforceDenylist: false,
      blockElevatedTargets: false,
    },
  })).toEqual({
    enabled: true,
    restrictions: {
      disableAll: true,
      blockSelfTarget: false,
      blockSecureInput: false,
      enforceDenylist: false,
      blockElevatedTargets: false,
    },
  });
});

it("computerUse settings reject invalid restriction overrides", () => {
  for (const restrictions of [
    { disableAll: "yes" },
    { blockSelfTarget: 0 },
    { blockSecureInput: null },
    { enforceDenylist: false, unknown: true },
  ]) {
    expect(() => validateComputerUseSettings({ enabled: true, restrictions })).toThrow(/invalid/);
  }
});

it("runs are autonomous by default and still take pixels only on request", () => {
  // ADR 0344: the switch is the consent, so an unset policy must not imply a
  // per-step card that does not exist. Pixels stay opt-in, because they land
  // in the transcript.
  expect(COMPUTER_USE_DEFAULTS.inputPolicy).toBe("autonomous-in-scope");
  expect(COMPUTER_USE_DEFAULTS.capture).toBe("a11y-only");
  // The narrower policy stays expressible for when the card lands.
  expect(validateComputerUseSettings({ enabled: true, defaultInputPolicy: "confirm-each" })).toEqual({
    enabled: true,
    defaultInputPolicy: "confirm-each",
  });
});

it("computerUse settings keep an explicit model binding", () => {
  const value = validateComputerUseSettings({
    enabled: true,
    model: { providerId: "p1", modelId: "ui-model" },
    defaultInputPolicy: "autonomous-in-scope",
    defaultCapture: "a11y-and-pixels",
    denylist: ["com.apple.keychainaccess"],
    actionBudget: 10,
    idleExpiryMs: 60_000,
  });
  expect(value.model).toEqual({ providerId: "p1", modelId: "ui-model" });
  expect(value.defaultInputPolicy).toBe("autonomous-in-scope");
  expect(value.defaultCapture).toBe("a11y-and-pixels");
  expect(value.denylist).toEqual(["com.apple.keychainaccess"]);
});

it("computerUse model source defaults compatibly and accepts conversation mode", () => {
  expect(validateComputerUseSettings({ enabled: true }).modelSource).toBeUndefined();
  expect(validateComputerUseSettings({ enabled: true, modelSource: "dedicated" }).modelSource).toBe("dedicated");
  expect(validateComputerUseSettings({ enabled: true, modelSource: "conversation" }).modelSource).toBe("conversation");
  expect(() => validateComputerUseSettings({ enabled: true, modelSource: "fallback" })).toThrow(/invalid/);
});

it("model-source resolution follows the chosen model and never silently falls back", () => {
  const dedicated = { providerId: "dedicated-provider", modelId: "dedicated-model" };
  const conversation = { providerId: "chat-provider", modelId: "chat-model" };
  expect(computerUseModelBindingForSource({ model: dedicated })).toEqual(dedicated);
  expect(computerUseModelBindingForSource({ model: dedicated, modelSource: "dedicated" }, conversation)).toEqual(dedicated);
  expect(computerUseModelBindingForSource({ model: dedicated, modelSource: "conversation" }, conversation)).toEqual(conversation);
  expect(computerUseModelBindingForSource({ model: dedicated, modelSource: "conversation" }, null)).toBeNull();
  expect(computerUseModelBindingForSource({ model: null, modelSource: "conversation" })).toBeNull();
});

it("computerUse grant budgets have no product upper limit", () => {
  expect(validateComputerUseSettings({
    enabled: true,
    actionBudget: 10_000_000,
    idleExpiryMs: 24 * 60 * 60_000,
  })).toMatchObject({
    actionBudget: 10_000_000,
    idleExpiryMs: 24 * 60 * 60_000,
  });
});

it("computerUse settings distinguish an absent binding from a cleared one", () => {
  expect(validateComputerUseSettings({ enabled: true }).model).toBe(undefined);
  expect(validateComputerUseSettings({ enabled: true, model: null }).model).toBe(null);
});

it("computerUse settings reject unknown keys and bad values", () => {
  for (const value of [
    { enabled: true, somethingElse: 1 },
    { enabled: "yes" },
    { enabled: true, model: { providerId: "p1" } },
    { enabled: true, model: { providerId: "p1", modelId: "m", extra: 1 } },
    { enabled: true, model: { providerId: " p1", modelId: "m" } },
    { enabled: true, defaultInputPolicy: "whatever" },
    { enabled: true, defaultCapture: "pixels" },
    { enabled: true, denylist: "com.apple" },
    { enabled: true, actionBudget: 0 },
    { enabled: true, actionBudget: Number.MAX_SAFE_INTEGER + 1 },
    { enabled: true, actionBudget: 1.5 },
    { enabled: true, idleExpiryMs: 1_000 },
    { enabled: true, idleExpiryMs: Number.MAX_SAFE_INTEGER + 1 },
    [],
    null,
    "enabled",
  ]) {
    expect(() => validateComputerUseSettings(value), `accepted ${JSON.stringify(value)}`).toThrow(/invalid/);
  }
});

it("Computer tool args require an instruction and nothing else", () => {
  expect(validateComputerToolArgs({ instruction: "  open preferences  " })).toEqual({
    instruction: "open preferences",
  });
  expect(
    validateComputerToolArgs({ instruction: "read it", observeOnly: true, maxSteps: 3 }),
  ).toEqual({ instruction: "read it", maxSteps: 3, observeOnly: true });
});

it("Computer tool args refuse addressing, targets, and runaway step counts", () => {
  for (const value of [
    { instruction: "" },
    { instruction: "   " },
    { instruction: "x".repeat(4_001) },
    { instruction: "click it", uid: "node-3" },
    { instruction: "click it", point: { x: 1, y: 2 } },
    { instruction: "click it", targetId: "window-9" },
    { instruction: "click it", maxSteps: 0 },
    { instruction: "click it", maxSteps: COMPUTER_MAX_STEPS_LIMIT + 1 },
    { instruction: "click it", observeOnly: "yes" },
    "open preferences",
    null,
  ]) {
    expect(() => validateComputerToolArgs(value), `accepted ${JSON.stringify(value)}`).toThrow(/Computer/);
  }
});

it("OS permission requests are offered only for missing macOS Accessibility", () => {
  const capabilities: ComputerCapabilities = {
    platform: "darwin", backend: "macos-ax", fidelity: "full",
    accessibility: "not-requested", capture: "not-requested",
  };
  expect(needsAccessibilityRequest(capabilities)).toBe(true);
  expect(needsAccessibilityRequest({ ...capabilities, accessibility: "denied" })).toBe(true);
  expect(needsAccessibilityRequest({ ...capabilities, accessibility: "granted" })).toBe(false);
  expect(needsAccessibilityRequest({ ...capabilities, accessibility: "unsupported" })).toBe(false);
  expect(needsAccessibilityRequest({ ...capabilities, applicationAccessibility: "granted" })).toBe(false);
  expect(needsAccessibilityRequest({ ...capabilities, accessibility: "granted", applicationAccessibility: "not-requested" })).toBe(true);
  for (const platform of ["linux", "win32", "other"] as const) {
    expect(needsAccessibilityRequest({ ...capabilities, platform, backend: "unsupported" })).toBe(false);
  }
});

describe("computer RPC schema version", () => {
  // The Electron bundle and the host-core sidecar are versioned separately, so
  // an update can leave them out of step. A mismatch has to be caught before
  // an action runs, not halfway through one.
  it("accepts a version inside the supported range", () => {
    expect(isComputerRpcSchemaCompatible(COMPUTER_RPC_SCHEMA_MIN)).toBe(true);
    expect(isComputerRpcSchemaCompatible(COMPUTER_RPC_SCHEMA_MAX)).toBe(true);
  });

  it("rejects a version outside the supported range", () => {
    expect(isComputerRpcSchemaCompatible(COMPUTER_RPC_SCHEMA_MAX + 1)).toBe(false);
    expect(isComputerRpcSchemaCompatible(COMPUTER_RPC_SCHEMA_MIN - 1)).toBe(false);
    expect(isComputerRpcSchemaCompatible(0)).toBe(false);
    expect(isComputerRpcSchemaCompatible(9999)).toBe(false);
  });

  it("treats a missing or malformed version as incompatible", () => {
    // An older sidecar that predates the version field is exactly the case
    // this check exists to catch, so absence must not read as compatible.
    expect(isComputerRpcSchemaCompatible(undefined)).toBe(false);
    expect(isComputerRpcSchemaCompatible(null)).toBe(false);
    expect(isComputerRpcSchemaCompatible("1")).toBe(false);
    expect(isComputerRpcSchemaCompatible(1.5)).toBe(false);
    expect(isComputerRpcSchemaCompatible(NaN)).toBe(false);
  });

  it("names both versions and the fix in the mismatch message", () => {
    const message = computerRpcSchemaMismatchMessage(2, "0.99.0");
    expect(message).toContain("2");
    expect(message).toContain("0.99.0");
    expect(message).toContain(String(COMPUTER_RPC_SCHEMA_MIN));
    expect(message).toContain(String(COMPUTER_RPC_SCHEMA_MAX));
    expect(message).toContain("Update PI-Desktop");
  });

  it("still names the supported range when the host reported nothing", () => {
    const message = computerRpcSchemaMismatchMessage(undefined);
    expect(message).toContain("unknown");
    expect(message).toContain(String(COMPUTER_RPC_SCHEMA_MIN));
  });
});