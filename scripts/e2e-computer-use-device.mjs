#!/usr/bin/env node
/** Opt-in macOS Host acceptance against a disposable native AppKit fixture. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostBinary } from "./e2e/host.mjs";
import { withScenario } from "./e2e/fixture.mjs";

if (process.platform !== "darwin") {
  throw new Error("The Computer Use device fixture requires macOS.");
}
if (process.env.PI_DESKTOP_COMPUTER_USE_DEVICE !== "1") {
  throw new Error("Set PI_DESKTOP_COMPUTER_USE_DEVICE=1 to run the opt-in visible fixture.");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureSource = join(root, "scripts/e2e/computer-use-macos-fixture.swift");
const scratch = await mkdtemp(join(tmpdir(), "pi-computer-use-device-"));
const fixtureBinary = join(scratch, "computer-use-macos-fixture");
const statePath = join(scratch, "state.json");
const commandPath = join(scratch, "command.json");
const suffix = randomUUID().slice(0, 8);
const title = `PI-CU-Fixture-${suffix}`;
const otherTitle = `PI-CU-Other-${suffix}`;
const sessionId = `computer-use-device-${suffix}`;
let fixture;
let fixtureOutput = "";
let commandSequence = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function waitForState(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState();
    if (state && predicate(state)) return state;
    if (fixture?.exitCode !== null && fixture?.exitCode !== undefined) {
      throw new Error(`${label}: fixture exited (${fixture.exitCode}); ${fixtureOutput.slice(-1200)}`);
    }
    await sleep(80);
  }
  throw new Error(`${label}: fixture state timed out; ${fixtureOutput.slice(-1200)}`);
}

async function commandFixture(name) {
  const sequence = ++commandSequence;
  await writeFile(commandPath, JSON.stringify({ sequence, name }), "utf8");
  return waitForState((state) => state.commandSequence === sequence, `fixture command ${name}`);
}

function compileFixture() {
  const result = spawnSync("swiftc", [fixtureSource, "-O", "-o", fixtureBinary], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not compile the native fixture: ${result.error ?? result.stderr ?? result.stdout}`);
  }
}

function startFixture() {
  fixture = spawn(fixtureBinary, [
    "--state", statePath,
    "--command", commandPath,
    "--title", title,
    "--other-title", otherTitle,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [fixture.stdout, fixture.stderr]) {
    stream.on("data", (chunk) => { fixtureOutput += String(chunk); });
  }
  fixture.on("error", (error) => { fixtureOutput += String(error); });
}

async function inspect(host, grant) {
  return host.call("computer.inspect", {
    grantId: grant.grantId,
    sessionId,
  });
}

function nodeWithAction(inspection, label) {
  const node = inspection.nodes.find((candidate) => candidate.label === label);
  assert(node, `Host inspection omitted fixture control: ${label}`);
  assert(node.enabled, `${label} is not enabled`);
  return node;
}

async function perform(host, grant, inspection, node, kind, text, actionFields = {}) {
  return host.call("computer.act", {
    grantId: grant.grantId,
    sessionId,
    expectedRevision: inspection.revision,
    action: { kind, uid: node.uid, ...(text === undefined ? {} : { text }), ...actionFields },
  });
}

async function performKeys(host, grant, inspection, keys) {
  return host.call("computer.act", {
    grantId: grant.grantId,
    sessionId,
    expectedRevision: inspection.revision,
    action: { kind: "press_keys", keys },
  });
}

async function stopFixture() {
  if (!fixture || fixture.exitCode !== null) return;
  try { await commandFixture("stop"); } catch { /* kill below is the cleanup fallback */ }
  const exited = () => new Promise((resolve) => fixture.once("exit", resolve));
  await Promise.race([exited(), sleep(2_000)]);
  if (fixture.exitCode === null) {
    fixture.kill("SIGTERM");
    await Promise.race([exited(), sleep(2_000)]);
  }
  if (fixture.exitCode === null) {
    fixture.kill("SIGKILL");
    await Promise.race([exited(), sleep(2_000)]);
  }
  assert.notEqual(fixture.exitCode, null, "native fixture must exit before its temporary state is removed");
}

try {
  compileFixture();
  startFixture();
  await waitForState((state) => state.ready === true, "native fixture startup");
  console.log("Visible native test windows are open. Grant Accessibility to pi-desktop-host-core if macOS asks.");

  await withScenario("computer-use-device-macos", async ({ host }) => {
    let capabilities = await host.call("computer.requestPermission");
    if (capabilities.accessibility !== "granted") {
      console.log("Approve Accessibility for pi-desktop-host-core in System Settings; waiting up to 90 seconds.");
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && capabilities.accessibility !== "granted") {
        await sleep(1_000);
        capabilities = await host.call("computer.capabilities");
      }
    }
    assert.equal(capabilities.accessibility, "granted", "macOS Accessibility permission is required");
    await host.call("settings.set", {
      computerUse: { enabled: true, defaultInputPolicy: "autonomous-in-scope", defaultCapture: "a11y-only" },
    });

    const { targets } = await host.call("computer.listTargets");
    const exactTargets = targets.filter((target) => target.title === title);
    assert.equal(exactTargets.length, 1, "Host must enumerate exactly one isolated target window");
    const target = exactTargets[0];
    assert(target.targetId, "Host must mint an opaque target ID");
    const grant = await host.call("computer.grantCreate", {
      sessionId,
      origin: "user",
      targetId: target.targetId,
      inputPolicy: "autonomous-in-scope",
      capture: "a11y-only",
      actionBudget: 20,
      idleExpiryMs: 60_000,
    });
    const grantId = grant.grantId;
    assert.equal(grant.scope, "window", "grant must stay pinned to the exact fixture window");
    assert.equal(grant.targetId, target.targetId, "grant must preserve the Host-issued target ID");

    let observation = await inspect(host, grant);
    const normalLabel = "CU normal text field";
    const secureLabel = "CU secure text field";
    let normal = nodeWithAction(observation, normalLabel);
    let secure = nodeWithAction(observation, secureLabel);
    assert(normal.actions.includes("type_text"), "ordinary editable text field must advertise type_text");
    assert(!secure.actions.includes("type_text"), "secure text field must not advertise type_text");
    assert(!secure.actions.includes("set_value"), "secure text field must not advertise set_value");

    const pointerLabel = "CU pointer probe";
    let pointer = nodeWithAction(observation, pointerLabel);
    assert(pointer.bounds, "pointer fixture control must have native screen bounds");
    assert(pointer.actions.includes("hover"), "bounded native control must advertise hover");
    assert(pointer.actions.includes("drag"), "bounded native control must advertise drag");
    await perform(host, grant, observation, normal, "hover");
    await commandFixture("reset_pointer");
    observation = await inspect(host, grant);
    pointer = nodeWithAction(observation, pointerLabel);
    await perform(host, grant, observation, pointer, "hover");
    await waitForState((state) => state.pointerEntered, "native pointer-enter callback");

    await commandFixture("reset_pointer");
    observation = await inspect(host, grant);
    pointer = nodeWithAction(observation, pointerLabel);
    const relative = (fraction) => ({
      x: pointer.bounds.x - observation.bounds.x + pointer.bounds.width * fraction,
      y: pointer.bounds.y - observation.bounds.y + pointer.bounds.height / 2,
    });
    const drag = await perform(host, grant, observation, pointer, "drag", undefined, {
      point: relative(0.2),
      to: relative(0.8),
      basis: { revision: observation.revision, bounds: observation.bounds },
    });
    assert.equal(drag.dispatched, "window_event", "drag must be reported as dispatched, not verified");
    await waitForState(
      (state) => state.dragStarted && state.dragMoved && state.dragEnded,
      "native drag callbacks",
    );

    const inputs = [
      "PI Computer Use ASCII 42",
      "电脑操控测试",
      "🦢🧪",
      "ASCII / 混合 文本 🦢 with a longer UTF-16 sequence 0123456789",
    ];
    for (const input of inputs) {
      await commandFixture("focus_target");
      observation = await inspect(host, grant);
      normal = nodeWithAction(observation, normalLabel);
      await perform(host, grant, observation, normal, "set_value", "");
      observation = await inspect(host, grant);
      normal = nodeWithAction(observation, normalLabel);
      const result = await perform(host, grant, observation, normal, "type_text", input);
      assert.equal(result.dispatched, "window_event", "text must be reported as dispatched, not verified");
      observation = await inspect(host, grant);
      assert(observation.nodes.some((candidate) => candidate.uid === normal.uid), "fresh Host observation must still resolve the text control");
      const state = await waitForState((value) => value.normalHash === digest(input), "fixture text readback");
      assert.equal(state.normalHash, digest(input), "native control must contain the exact typed text");
    }

    await commandFixture("focus_target");
    observation = await inspect(host, grant);
    normal = nodeWithAction(observation, normalLabel);
    await perform(host, grant, observation, normal, "set_value", "");
    observation = await inspect(host, grant);
    normal = nodeWithAction(observation, normalLabel);
    const shortcutText = "select and clear through native key events";
    await perform(host, grant, observation, normal, "type_text", shortcutText);
    await waitForState((state) => state.normalHash === digest(shortcutText), "pre-shortcut text readback");
    observation = await inspect(host, grant);
    const keysResult = await performKeys(host, grant, observation, ["cmd+a", "backspace"]);
    assert.equal(keysResult.dispatched, "window_event", "key chords must be reported as dispatched, not verified");
    await inspect(host, grant);
    const clearedByKeys = await waitForState((state) => state.normalHash === digest(""), "native key chord readback");
    assert.equal(clearedByKeys.normalHash, digest(""), "cmd+a and backspace must clear selected fixture text");

    const beforeFocusRefusal = await readState();
    await commandFixture("focus_other");
    const otherState = await waitForState((state) => state.activeWindow === "other", "focus mismatch setup");
    observation = await inspect(host, grant);
    normal = nodeWithAction(observation, normalLabel);
    await assert.rejects(
      perform(host, grant, observation, normal, "type_text", "MUST_NOT_BE_TYPED"),
      (error) => error.errorCode === "COMPUTER_ELEMENT_NOT_ACTIONABLE",
      "typing must refuse when another window of the same app is active",
    );
    const afterFocusRefusal = await readState();
    assert.equal(afterFocusRefusal.normalHash, beforeFocusRefusal.normalHash, "focus refusal must not alter the target field");
    assert.equal(otherState.activeWindow, "other");

    await commandFixture("focus_target");
    await waitForState((state) => state.activeWindow === "target", "focus recovery");
    observation = await inspect(host, grant);
    normal = nodeWithAction(observation, normalLabel);
    await perform(host, grant, observation, normal, "set_value", "");
    observation = await inspect(host, grant);
    normal = nodeWithAction(observation, normalLabel);
    const recoveryText = "recovered after focus refusal";
    await perform(host, grant, observation, normal, "type_text", recoveryText);
    observation = await inspect(host, grant);
    const recovered = await waitForState((state) => state.normalHash === digest(recoveryText), "input recovery readback");
    assert.equal(recovered.normalHash, digest(recoveryText), "normal input must recover after focus is restored");

    await commandFixture("focus_secure");
    await waitForState(
      (state) => state.activeWindow === "target" && state.secureFocused === true,
      "secure field focus",
    );
    observation = await inspect(host, grant);
    secure = nodeWithAction(observation, secureLabel);
    assert(!secure.actions.includes("type_text"), "secure text field must not advertise type_text");
    assert(!secure.actions.includes("set_value"), "secure text field must not advertise set_value");
    await assert.rejects(
      perform(host, grant, observation, secure, "type_text", "MUST_NOT_BE_TYPED"),
      (error) => ["COMPUTER_SECURE_INPUT_REFUSED", "COMPUTER_ELEMENT_NOT_ACTIONABLE"].includes(error.errorCode),
      "secure input must be refused by the Host",
    );
    const finalState = await readState();
    assert.equal(finalState.secureNonEmpty, false, "secure field must remain empty");

    await host.call("computer.grantRevoke", { reason: "test" });
    console.log(JSON.stringify({
      suite: "macos-computer-use-device",
      exactTargetBinding: true,
      nativeHoverVerified: true,
      nativeDragVerified: true,
      pressKeysVerified: true,
      unicodeInputsVerified: inputs.length,
      focusMismatchRefused: true,
      recoveryAfterRefusal: true,
      secureInputRefused: true,
      screenshotSaved: false,
    }));
  }, resolveHostBinary(), scratch);
} catch (error) {
  console.error(`macOS Computer Use device acceptance failed: ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await stopFixture();
  await rm(scratch, { recursive: true, force: true });
}
