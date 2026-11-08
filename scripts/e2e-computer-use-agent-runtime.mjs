#!/usr/bin/env node
/** Real Agent Sidecar -> Host gate -> Main Computer tool -> Windows UIA fixture.
 * The only mocked boundary is the local loopback model endpoint.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { register } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { DEEPSEEK_MODELS } from "../packages/agent-runtime/node_modules/@earendil-works/pi-ai/dist/providers/deepseek.models.js";
import { modelConfigFromPi } from "../packages/agent-runtime/dist/model-capabilities.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { withScenario } from "./e2e/fixture.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import { createSession, beginTurn, endTurn } from "./e2e/session.mjs";

if (process.platform !== "win32") {
  throw new Error("This opt-in fixture requires Windows UI Automation.");
}
if (process.env.PI_COMPUTER_E2E_ELECTRON !== "1") {
  const wrapperDir = await mkdtemp(join(tmpdir(), "pi-computer-e2e-electron-"));
  const wrapperPath = join(wrapperDir, "main.cjs");
  await writeFile(wrapperPath, `const { app } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  try { await import(${JSON.stringify(new URL(import.meta.url).href)}); app.exit(0); }
  catch (error) { console.error(error); app.exit(1); }
});`);
  const env = { ...process.env, PI_COMPUTER_E2E_ELECTRON: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary().electronBinary, [wrapperPath], {
    env,
    windowsHide: true,
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await rm(wrapperDir, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : typeof code === "number" ? code : 1);
}
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createComputerUseTool } = await import(
  "../apps/desktop/electron/main/computer-use/agent-tool.ts"
);

const requests = [];
const routedModels = { conversation: [], computer: [] };
let computerImageRequests = 0;
let mainCalls = 0;
let computerCalls = 0;
let computerToolDeclarations = 0;
let fixtureStatePath;
let fixtureChild;
let fixtureTitle;
let fixtureOutput = "";
const testRoot = await mkdtemp(join(tmpdir(), "pi-computer-agent-runtime-"));
const computerRpcMethods = [];
let activeCycle = 1;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests.push(body);
  if (requests.length > 18) {
    response.writeHead(500).end("fixture request ceiling exceeded");
    return;
  }
  const messages = body.messages ?? [];
  const isComputerDecision = JSON.stringify(messages.at(-1) ?? {}).includes("Observation:");
  routedModels[isComputerDecision ? "computer" : "conversation"].push(body.model);
  if (isComputerDecision && messages.some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"),
  )) computerImageRequests++;
  let delta;
  let finish;
  if (isComputerDecision) {
    computerCalls++;
    const transcript = JSON.stringify(messages);
    if (transcript.includes(`CU-RUNTIME-FIXTURE-CLICKED-${activeCycle}`)) {
      delta = { role: "assistant", content: JSON.stringify({ kind: "done", summary: "Verified fixture label changed." }) };
      finish = "stop";
    } else {
      const latestObservation = messages.map((message) => JSON.stringify(message)).join("\n");
      const markerIndex = latestObservation.lastIndexOf("CU-RUNTIME-FIXTURE-ACTION");
      const before = latestObservation.slice(0, markerIndex);
      const uid = [...before.matchAll(/uid=([^\s",]+)/g)].at(-1)?.[1];
      if (!uid) throw new Error("Computer observation did not include the fixture button UID");
      delta = { role: "assistant", content: JSON.stringify({ kind: "action", action: { kind: "click", uid } }) };
      finish = "stop";
    }
  } else {
    mainCalls++;
    const tool = (body.tools ?? []).find((candidate) => candidate.function?.name === "Computer");
    const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
    const currentTurnMessages = messages.slice(latestUserIndex + 1);
    const priorToolResult = currentTurnMessages.some((message) => message.role === "tool" || message.tool_call_id);
    if (tool && !priorToolResult) computerToolDeclarations++;
    if (tool && !priorToolResult) {
      delta = { role: "assistant", tool_calls: [{ index: 0, id: "computer-fixture-call", type: "function",
        function: { name: "Computer", arguments: JSON.stringify({ instruction: `Click the button in ${fixtureTitle}, then verify its status changed.` }) } }] };
      finish = "tool_calls";
    } else {
      delta = { role: "assistant", content: "Computer action was executed and verified." };
      finish = "stop";
    }
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ id: "computer-fixture", model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: "computer-fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n` +
    "data: [DONE]\n\n",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const model = Object.values(DEEPSEEK_MODELS).find((candidate) => candidate.id === "deepseek-v4-pro");
assert(model, "DeepSeek fixture model metadata missing");
const computerModel = Object.values(DEEPSEEK_MODELS).find((candidate) => candidate.id === "deepseek-flash");
assert(computerModel, "Distinct Computer fixture model metadata missing");
const runtimeProvider = {
  id: "computer-e2e-computer-model",
  name: "Computer E2E computer model",
  modelId: computerModel.id,
  baseUrl: endpoint,
  modelConfig: modelConfigFromPi(computerModel),
  apiKey: "fixture-only",
  authKind: "api_key",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};
try {
  await withScenario("E2E-computer-use-runtime", async ({ host, workspace, scenarioRoot }) => {
    fixtureTitle = `PI-CU-RUNTIME-${randomUUID()}`;
    fixtureStatePath = join(scenarioRoot, "fixture-state.txt");
    const fixtureScript = join(scenarioRoot, "fixture.ps1");
    await writeFile(fixtureScript, `
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = '${fixtureTitle}'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(460, 180)
$form.TopMost = $true
$label = New-Object System.Windows.Forms.Label
$label.Name = 'FixtureStatus'
$label.AccessibleName = 'CU-RUNTIME-FIXTURE-IDLE'
$label.Text = 'CU-RUNTIME-FIXTURE-IDLE'
$label.Location = New-Object System.Drawing.Point(20, 20)
$label.AutoSize = $true
$button = New-Object System.Windows.Forms.Button
$button.Name = 'FixtureAction'
$button.AccessibleName = 'CU-RUNTIME-FIXTURE-ACTION'
$button.Text = 'Change fixture status'
$button.Location = New-Object System.Drawing.Point(20, 60)
$script:clickCount = 0
$button.add_Click({ $script:clickCount++; $label.AccessibleName = "CU-RUNTIME-FIXTURE-CLICKED-$script:clickCount"; $label.Text = $label.AccessibleName; [System.IO.File]::WriteAllText('${fixtureStatePath.replaceAll("'", "''")}', $label.Text) })
$form.Controls.Add($label)
$form.Controls.Add($button)
$form.add_Shown({ $form.Activate() | Out-Null })
[System.Windows.Forms.Application]::Run($form)
`);
    fixtureChild = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", fixtureScript], { stdio: ["ignore", "pipe", "pipe"] });
    fixtureChild.stdout.on("data", (chunk) => { fixtureOutput += String(chunk); });
    fixtureChild.stderr.on("data", (chunk) => { fixtureOutput += String(chunk); });
    const providerRow = await host.call("providers.create", {
      name: "Computer E2E conversation model",
      type: "openai_compatible",
      protocol: "openai_compatible",
      authKind: "none",
      baseUrl: endpoint,
      defaultModelId: model.id,
      apiStyle: "chat_completions",
    });
    const computerProviderRow = await host.call("providers.create", {
      name: "Computer E2E computer model",
      type: "openai_compatible",
      protocol: "openai_compatible",
      authKind: "none",
      baseUrl: endpoint,
      defaultModelId: computerModel.id,
      apiStyle: "chat_completions",
    });
    const binding = { providerId: computerProviderRow.provider.id, modelId: computerModel.id };
    await host.call("settings.set", {
      defaultPermissionMode: "auto",
      computerUse: { enabled: true, model: binding, defaultInputPolicy: "autonomous-in-scope", defaultCapture: "a11y-and-pixels" },
    });
    const callHost = async (method, params) => {
      if (method.startsWith("computer.")) computerRpcMethods.push(method);
      return host.call(method, params);
    };
    const deadline = Date.now() + 15_000;
    let visibleTargets = [];
    while (Date.now() < deadline) {
      const { targets } = await callHost("computer.listTargets");
      visibleTargets = targets;
      if (targets.some((target) => target.title === fixtureTitle)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(visibleTargets.some((target) => target.title === fixtureTitle),
      `isolated fixture window must be visible to Host before the model turn; fixtureExit=${fixtureChild.exitCode}; output=${fixtureOutput}; targets=${JSON.stringify(visibleTargets)}`);
    const session = await createSession(host, workspace, "Computer runtime fixture");
    let stderr = "";
    const sidecar = new AgentSidecar({
      launch: {
        command: process.execPath,
        args: [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))],
        cwd: workspace,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PI_DESKTOP_COMPACTION_STRATEGY: "fresh_window" },
      },
      onStderr: (chunk) => { stderr += chunk; },
    });
    sidecar.setHost({ call: callHost, onNotification: () => () => {}, onExit: () => () => {} });
    const toolCalls = [];
    const turnErrors = [];
    let resolveTurn;
    let ended;
    sidecar.onNotification((method, envelope) => {
      if (method !== "agent.event") return;
      if (envelope.event.type === "tool_start") toolCalls.push(envelope.event.toolName);
      if (envelope.event.type === "error") turnErrors.push(envelope.event.error);
      if (envelope.event.type === "agent_end") resolveTurn();
    });
    const waitForTurn = async (turnEnded, cycle) => {
      let timeout;
      try {
        await Promise.race([
          turnEnded,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`cycle ${cycle} timed out: ${stderr}`)), 60_000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    };
    const computerTool = createComputerUseTool({
      getHost: () => ({ call: callHost }),
      resolveProvider: async (settings) => {
        assert.equal(settings.computerUse.model.providerId, computerProviderRow.provider.id);
        assert.equal(settings.computerUse.model.modelId, computerModel.id);
        return runtimeProvider;
      },
    });
    sidecar.setLocalTool("Computer", computerTool);
    try {
      for (let cycle = 1; cycle <= 3; cycle++) {
        activeCycle = cycle;
        ended = new Promise((resolve) => { resolveTurn = resolve; });
        const turnId = await beginTurn(host, session.id);
        const userMessageId = randomUUID();
        const content = `Click the test button in ${fixtureTitle} once, then verify its status changed for cycle ${cycle}.`;
        await host.call("session.appendMessage", { sessionId: session.id, turnId,
          message: { id: userMessageId, role: "user", content, createdAt: new Date().toISOString() } });
        await sidecar.call("agent.prompt", {
          sessionId: session.id,
          turnId,
          userMessageId,
          mode: "agent",
          provider: {
            ...runtimeProvider,
            id: providerRow.provider.id,
            modelId: model.id,
            modelConfig: modelConfigFromPi(model),
          },
          thinkingLevel: "off",
          computerUseEnabled: true,
          commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
          projectPath: workspace,
          content,
        });
        await waitForTurn(ended, cycle);
        assert.equal(await readFile(fixtureStatePath, "utf8"), `CU-RUNTIME-FIXTURE-CLICKED-${cycle}`,
          `cycle ${cycle} must verify the native UIA post-action state; mainCalls=${mainCalls}; computerCalls=${computerCalls}; toolCalls=${JSON.stringify(toolCalls)}; rpc=${JSON.stringify(computerRpcMethods)}`);
        await endTurn(host, turnId, "completed");
      }
      assert.deepEqual(turnErrors, [], JSON.stringify(turnErrors));
      assert.deepEqual(toolCalls, ["Computer", "Computer", "Computer"], "the real Agent Runtime must dispatch Computer on each fresh turn");
      assert.equal(computerToolDeclarations, 3, "each fresh turn's first model request must declare Computer");
      assert.equal(mainCalls, 6, "each conversation turn should call Computer then provide a final response");
      assert.equal(computerCalls, 6, "each Computer run must act, re-observe, then verify exactly once");
      assert.deepEqual(routedModels.conversation, Array(6).fill(model.id), "conversation requests must use the selected chat model");
      assert.deepEqual(routedModels.computer, Array(6).fill(computerModel.id), "Computer decisions must use the separately selected Computer model");
      assert.equal(computerImageRequests, 6, "each Computer decision must receive the exact granted-window image alongside the UIA observation");
      assert.equal(await readFile(fixtureStatePath, "utf8"), "CU-RUNTIME-FIXTURE-CLICKED-3");
      assert.equal(computerRpcMethods.filter((method) => method === "computer.grantCreate").length, 3);
      assert.equal(computerRpcMethods.filter((method) => method === "computer.inspect").length, 6);
      assert.equal(computerRpcMethods.filter((method) => method === "computer.act").length, 3);
      assert.equal(computerRpcMethods.filter((method) => method === "computer.grantRevoke").length, 3);
      assert.deepEqual(
        computerRpcMethods.filter((method) => ["computer.grantCreate", "computer.act", "computer.grantRevoke"].includes(method)),
        ["computer.grantCreate", "computer.act", "computer.grantRevoke", "computer.grantCreate", "computer.act", "computer.grantRevoke", "computer.grantCreate", "computer.act", "computer.grantRevoke"],
        "each grant must be revoked before the next cycle creates one",
      );
      console.log(JSON.stringify({ ok: true, toolCalls, mainModelRequests: mainCalls, computerModelRequests: computerCalls,
        routedModels,
        computerImageRequests,
        hostComputerRpcMethods: [...new Set(computerRpcMethods)],
        fixtureState: "CU-RUNTIME-FIXTURE-CLICKED-3", freshGrantCycles: 3 }));
    } finally {
      await sidecar.dispose();
    }
  }, resolveHostBinary(), testRoot, PROTOCOL_VERSION);
} finally {
  if (fixtureChild && fixtureChild.exitCode === null && fixtureChild.signalCode === null) {
    fixtureChild.kill();
    await new Promise((resolve) => fixtureChild.once("close", resolve));
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(testRoot, { recursive: true, force: true });
}
