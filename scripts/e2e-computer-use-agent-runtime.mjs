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
let computerImageBase64Chars = 0;
let mainCalls = 0;
let computerCalls = 0;
let noOpActionSentForCycle = false;
let clickSentForCycle = false;
const computerActions = [];
const computerDecisions = [];
let computerToolDeclarations = 0;
let fixtureStatePath;
let fixtureChild;
let fixtureTitle;
let fixtureTargetId;
let fixtureOutput = "";
const fixtureCapture = process.env.PI_COMPUTER_E2E_CAPTURE_MODE === "pixels"
  ? "a11y-and-pixels"
  : "a11y-only";
const apiStyle = process.env.PI_COMPUTER_E2E_API_STYLE ?? "chat_completions";
const supportedApiStyles = new Set(["chat_completions", "responses", "anthropic_messages", "google_generative_ai"]);
assert(supportedApiStyles.has(apiStyle), `unsupported Computer Use E2E apiStyle: ${apiStyle}`);
const testRoot = await mkdtemp(join(tmpdir(), "pi-computer-agent-runtime-"));
const computerRpcMethods = [];
let activeCycle = 1;
let windowScopedObservationChecks = 0;
function latestComputerObservationText(messages) {
  const text = textIn(messages);
  const start = text.lastIndexOf("Current window:");
  return start >= 0 ? text.slice(start) : text;
}
function describeComputerContext(messages) {
  return messages.slice(-6).map((message) => {
    const text = textIn(message) || String(message?.content ?? "");
    return `${message?.role ?? "?"}: ${text.slice(-1400)}`;
  }).join("\n---\n");
}

function requestItems(body) {
  if (apiStyle === "responses") return Array.isArray(body.input) ? body.input : [];
  if (apiStyle === "google_generative_ai") return Array.isArray(body.contents) ? body.contents : [];
  return Array.isArray(body.messages) ? body.messages : [];
}

function textIn(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textIn).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value;
  const ownText = typeof record.text === "string" ? record.text : "";
  const textKeys = new Set(["content", "parts", "input", "output", "arguments", "partial_json", "functionResponse", "functionCall", "delta"]);
  return [ownText, ...Object.entries(record)
    .filter(([key]) => textKeys.has(key))
    .map(([, child]) => textIn(child))].filter(Boolean).join("\n");
}

function requestModelId(body, requestUrl) {
  if (typeof body.model === "string") return body.model;
  if (apiStyle === "google_generative_ai") {
    const match = new URL(requestUrl, "http://127.0.0.1").pathname.match(/\/models\/([^:]+):/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }
  return "";
}

function declaresComputerTool(body) {
  if (apiStyle === "google_generative_ai") {
    return (body.tools ?? []).some((tool) => (tool.functionDeclarations ?? []).some((entry) => entry.name === "Computer"));
  }
  return (body.tools ?? []).some((tool) => tool.name === "Computer" || tool.function?.name === "Computer");
}

function isToolResult(item) {
  if (apiStyle === "responses") return item.type === "function_call_output" && Boolean(item.call_id);
  if (apiStyle === "anthropic_messages") return Array.isArray(item.content) && item.content.some((part) => part.type === "tool_result");
  if (apiStyle === "google_generative_ai") return Array.isArray(item.parts) && item.parts.some((part) => part.functionResponse?.name === "Computer");
  return item.role === "tool" || Boolean(item.tool_call_id);
}

function respondToProvider(response, modelId, payload) {
  if (apiStyle === "chat_completions") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = payload.kind === "tool"
      ? { role: "assistant", tool_calls: [{ index: 0, id: "computer-fixture-call", type: "function",
          function: { name: "Computer", arguments: JSON.stringify(payload.arguments) } }] }
      : { role: "assistant", content: payload.text };
    const finish = payload.kind === "tool" ? "tool_calls" : "stop";
    response.end(
      `data: ${JSON.stringify({ id: "computer-fixture", model: modelId, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: "computer-fixture", model: modelId, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n` +
      "data: [DONE]\n\n",
    );
    return;
  }

  if (apiStyle === "responses") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: "response.created", response: { id: "resp_computer_fixture" } });
    if (payload.kind === "tool") {
      const args = JSON.stringify(payload.arguments);
      const item = { id: "fc_computer_fixture", type: "function_call", call_id: "call_computer_fixture",
        name: "Computer", arguments: args, status: "completed" };
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
      send({ type: "response.function_call_arguments.delta", output_index: 0, delta: args });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.completed", response: { id: "resp_computer_fixture", status: "completed", output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
    } else {
      const item = { id: "msg_computer_fixture", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: payload.text, annotations: [] }] };
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: payload.text });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.completed", response: { id: "resp_computer_fixture", status: "completed", output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
    }
    response.end();
    return;
  }

  if (apiStyle === "anthropic_messages") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const tool = payload.kind === "tool";
    send({ type: "message_start", message: { id: "msg_computer_fixture", type: "message", role: "assistant",
      model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    send({ type: "content_block_start", index: 0, content_block: tool
      ? { type: "tool_use", id: "toolu_computer_fixture", name: "Computer", input: {} }
      : { type: "text", text: "" } });
    send({ type: "content_block_delta", index: 0, delta: tool
      ? { type: "input_json_delta", partial_json: JSON.stringify(payload.arguments) }
      : { type: "text_delta", text: payload.text } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
    send({ type: "message_stop" });
    response.end();
    return;
  }

  response.writeHead(200, { "content-type": "text/event-stream" });
  const part = payload.kind === "tool"
    ? { functionCall: { id: "call_computer_fixture", name: "Computer", args: payload.arguments } }
    : { text: payload.text };
  response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } })}\n\n`);
}

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const modelId = requestModelId(body, request.url ?? "/");
  const messages = requestItems(body);
  const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const validPath = apiStyle === "chat_completions" ? requestPath === "/v1/chat/completions"
    : apiStyle === "responses" ? requestPath === "/v1/responses"
      : apiStyle === "anthropic_messages" ? requestPath === "/v1/messages"
        : requestPath.startsWith("/v1beta/models/") && requestPath.endsWith(":streamGenerateContent");
  if (!validPath) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      .end(`unexpected ${apiStyle} endpoint path: ${requestPath}`);
    return;
  }
  requests.push({ apiStyle, url: request.url, model: modelId, hasComputerDeclaration: declaresComputerTool(body) });
  if (requests.length > 18) {
    response.writeHead(500).end("fixture request ceiling exceeded");
    return;
  }
  const isComputerDecision = modelId === "deepseek-flash";
  routedModels[isComputerDecision ? "computer" : "conversation"].push(modelId);
  if (isComputerDecision) {
    computerCalls++;
    const allText = textIn(messages);
    const observationStart = allText.lastIndexOf("Current window:");
    const currentObservation = observationStart >= 0 ? allText.slice(observationStart) : allText;
    const visibleWindowLines = currentObservation.match(/^window_id=/gm) ?? [];
    if (visibleWindowLines.length !== 1 || !currentObservation.includes(fixtureTitle)) {
      const detail = `pinned-window observation mismatch: apiStyle=${apiStyle}; model=${modelId}; listedWindowCount=${visibleWindowLines.length}; fixtureTitlePresent=${currentObservation.includes(fixtureTitle)}; observationTail=${currentObservation.slice(-900)}`;
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(detail);
      console.error(detail);
      return;
    }
    windowScopedObservationChecks++;
    // Count only the newest decision's observation, not images retained in
    // older conversation messages; otherwise one early image could make later
    // failed captures look successful.
    const latestContent = messages.at(-1)?.content ?? messages.at(-1)?.parts;
    const imageParts = Array.isArray(latestContent)
      ? latestContent.filter((part) => part?.type === "image_url")
      : [];
    if (imageParts.length > 0) computerImageRequests++;
    for (const part of imageParts) {
      const url = part.image_url?.url;
      if (typeof url === "string" && url.startsWith("data:image/png;base64,")) {
        computerImageBase64Chars += url.slice("data:image/png;base64,".length).length;
      }
    }
  }
  let payload;
  if (isComputerDecision) {
    const transcript = textIn(messages);
    const clickedMarkerPresent = transcript.includes(`CU-RUNTIME-FIXTURE-CLICKED-${activeCycle}`);
    computerDecisions.push({
      cycle: activeCycle,
      noOpSent: noOpActionSentForCycle,
      clickSent: clickSentForCycle,
      clickedMarkerPresent,
    });
    if (clickSentForCycle && clickedMarkerPresent) {
      const latestObservation = latestComputerObservationText(messages);
      const nodeLine = latestObservation.split(/\r?\n/).findLast((line) =>
        line.includes(`"CU-RUNTIME-FIXTURE-CLICKED-${activeCycle}"`) && line.includes("uid="),
      );
      const evidenceUid = nodeLine?.match(/\buid=([^\s·]+)/)?.[1];
      if (!evidenceUid) throw new Error("Final Computer observation did not include the changed fixture label UID");
      computerDecisions.at(-1).evidenceUid = evidenceUid;
      payload = { kind: "text", text: JSON.stringify({ kind: "done", summary: "Verified fixture label changed.", evidence: [evidenceUid] }) };
    } else {
      const latestObservation = latestComputerObservationText(messages);
      const nodeLine = latestObservation.split(/\r?\n/).findLast((line) =>
        line.includes('"CU-RUNTIME-FIXTURE-ACTION"') && line.includes("uid="),
      );
      const uid = nodeLine?.match(/\buid=([^\s·]+)/)?.[1];
      if (!uid) {
        const details = `Computer observation did not include the fixture button UID. Latest parsed observation:\n${latestObservation.slice(-3000)}\nRecent messages:\n${describeComputerContext(messages)}`;
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(details);
        console.error(details);
        return;
      }
      // Inject one valid but intentionally non-mutating action per fresh
      // grant. The next model decision must be based on a new Host
      // observation, then choose the state-changing click.
      const kind = noOpActionSentForCycle ? "click" : "hover";
      computerDecisions.at(-1).uid = uid;
      computerDecisions.at(-1).action = kind;
      if (kind === "hover") noOpActionSentForCycle = true;
      else clickSentForCycle = true;
      payload = { kind: "text", text: JSON.stringify({ kind: "action", action: { kind, uid } }) };
    }
  } else {
    mainCalls++;
    const hasTool = declaresComputerTool(body);
    const promptIndex = messages.findLastIndex((message) => textIn(message).includes(`cycle ${activeCycle}`));
    const currentTurnMessages = messages.slice(promptIndex + 1);
    const priorToolResult = currentTurnMessages.some(isToolResult);
    if (hasTool && !priorToolResult) computerToolDeclarations++;
    if (hasTool && !priorToolResult) {
      payload = { kind: "tool", arguments: { instruction: `Click the test button in ${fixtureTitle} once, then verify its status changed for cycle ${activeCycle}.` } };
    } else {
      payload = { kind: "text", text: "Computer action was executed and verified." };
    }
  }
  respondToProvider(response, modelId, payload);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const providerEndpoint = apiStyle === "google_generative_ai" ? endpoint.replace(/\/v1$/, "/v1beta") : endpoint;
const model = Object.values(DEEPSEEK_MODELS).find((candidate) => candidate.id === "deepseek-v4-pro");
assert(model, "DeepSeek fixture model metadata missing");
const computerModel = Object.values(DEEPSEEK_MODELS).find((candidate) => candidate.id === "deepseek-flash");
assert(computerModel, "Distinct Computer fixture model metadata missing");
const runtimeProvider = {
  id: "computer-e2e-computer-model",
  name: "Computer E2E computer model",
  vendorKey: "custom",
  modelId: computerModel.id,
  baseUrl: providerEndpoint,
  apiStyle,
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
      baseUrl: providerEndpoint,
      defaultModelId: model.id,
      apiStyle,
    });
    const computerProviderRow = await host.call("providers.create", {
      name: "Computer E2E computer model",
      type: "openai_compatible",
      protocol: "openai_compatible",
      authKind: "none",
      baseUrl: providerEndpoint,
      defaultModelId: computerModel.id,
      apiStyle,
    });
    const binding = { providerId: computerProviderRow.provider.id, modelId: computerModel.id };
    await host.call("settings.set", {
      defaultPermissionMode: "auto",
      // Keep UIA evidence acceptance independent from WGC by default. The opt-in
      // pixel mode runs the same fixture/model path to validate real capture.
      computerUse: { enabled: true, model: binding, defaultInputPolicy: "autonomous-in-scope", defaultCapture: fixtureCapture },
    });
    const callHost = async (method, params) => {
      if (method.startsWith("computer.")) computerRpcMethods.push(method);
      if (method === "computer.act") computerActions.push(params.action?.kind);
      // Pin this acceptance run to its own disposable window. This models a
      // user-selected Host target and prevents reading/capturing the daily
      // desktop if foreground focus changes between grant cycles.
      const targetParams = method === "computer.grantCreate" && params?.origin === "agent"
        ? { ...params, targetId: fixtureTargetId }
        : params;
      const result = await host.call(method, targetParams);
      if (method === "computer.grantCreate" && params?.origin === "agent") {
        assert.equal(result.targetId, fixtureTargetId, "Host grant must remain pinned to the exact isolated fixture window");
        assert.equal(result.scope, "window", "Host must make an exact-target request a window-scoped grant");
      }
      return result;
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
    fixtureTargetId = visibleTargets.find((target) => target.title === fixtureTitle)?.targetId;
    assert(fixtureTargetId, "fixture target must have a Host-issued target id before the model turn");
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
        noOpActionSentForCycle = false;
        clickSentForCycle = false;
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
        const observedFixtureState = await readFile(fixtureStatePath, "utf8").catch((error) => `<${error.code}>`);
        assert.equal(
          observedFixtureState,
          `CU-RUNTIME-FIXTURE-CLICKED-${cycle}`,
          `cycle ${cycle} must verify the native UIA post-action state; state=${observedFixtureState}; mainCalls=${mainCalls}; computerCalls=${computerCalls}; computerActions=${JSON.stringify(computerActions)}; computerDecisions=${JSON.stringify(computerDecisions)}; toolCalls=${JSON.stringify(toolCalls)}; turnErrors=${JSON.stringify(turnErrors)}; rpc=${JSON.stringify(computerRpcMethods)}`,
        );
        await endTurn(host, turnId, "completed");
      }
      assert.deepEqual(turnErrors, [], JSON.stringify(turnErrors));
      assert.deepEqual(toolCalls, ["Computer", "Computer", "Computer"], "the real Agent Runtime must dispatch Computer on each fresh turn");
      assert.equal(computerToolDeclarations, 3, "each fresh turn's first model request must declare Computer");
      const conversationRequests = requests.filter((request) => request.model === model.id);
      assert.equal(conversationRequests.length, 6, "each API protocol must service the conversation model's tool and follow-up requests");
      assert(conversationRequests.every((request) => request.hasComputerDeclaration),
        `Computer must remain declared on every conversation request using ${apiStyle}`);
      assert(requests.every((request) => request.apiStyle === apiStyle), "all provider requests must use the selected API protocol");
      assert.equal(mainCalls, 6, "each conversation turn should call Computer then provide a final response");
      assert.equal(computerCalls, 9, "each Computer run must re-observe after a non-mutating action, recover with a click, then verify");
      assert.equal(computerDecisions.filter((decision) => decision.clickedMarkerPresent).length, 3);
      assert.ok(computerDecisions.filter((decision) => decision.clickedMarkerPresent).every((decision) => typeof decision.evidenceUid === "string"),
        "each completion answer must cite a UID from its latest Host observation");
      assert.deepEqual(computerActions, ["hover", "click", "hover", "click", "hover", "click"],
        "each fresh grant must recover from a valid no-op action using a fresh observation before clicking");
      assert.deepEqual(routedModels.conversation, Array(6).fill(model.id), "conversation requests must use the selected chat model");
      assert.deepEqual(routedModels.computer, Array(9).fill(computerModel.id), "Computer decisions must use the separately selected Computer model");
      const expectedImageRequests = fixtureCapture === "a11y-and-pixels" ? 9 : 0;
      assert.equal(computerImageRequests, expectedImageRequests,
        fixtureCapture === "a11y-and-pixels"
          ? "each Computer decision must receive a non-empty exact granted-window image"
          : "the UIA verification suite must not depend on Windows Graphics Capture");
      if (fixtureCapture === "a11y-and-pixels") {
        assert.ok(computerImageBase64Chars > 0, "pixel mode must deliver actual PNG bytes to the loopback vision model");
      }
      assert.equal(windowScopedObservationChecks, 9,
        "every Computer-model turn must receive exactly the pinned target window, not peer desktop windows");
      assert.equal(await readFile(fixtureStatePath, "utf8"), "CU-RUNTIME-FIXTURE-CLICKED-3");
      assert.equal(computerRpcMethods.filter((method) => method === "computer.grantCreate").length, 3);
      assert.equal(computerRpcMethods.filter((method) => method === "computer.inspect").length, 12,
        "each action is re-observed and each completion citation is checked against a fresh Host observation");
      assert.equal(computerRpcMethods.filter((method) => method === "computer.act").length, 6);
      assert.equal(computerRpcMethods.filter((method) => method === "computer.grantRevoke").length, 3);
      assert.deepEqual(
        computerRpcMethods.filter((method) => ["computer.grantCreate", "computer.act", "computer.grantRevoke"].includes(method)),
        ["computer.grantCreate", "computer.act", "computer.act", "computer.grantRevoke", "computer.grantCreate", "computer.act", "computer.act", "computer.grantRevoke", "computer.grantCreate", "computer.act", "computer.act", "computer.grantRevoke"],
        "each grant must be revoked before the next cycle creates one",
      );
      console.log(JSON.stringify({ ok: true, apiStyle, toolCalls, mainModelRequests: mainCalls, computerModelRequests: computerCalls,
        routedModels,
        requests: requests.map(({ apiStyle: style, url, model: requestModel, hasComputerDeclaration }) => ({ style, url, model: requestModel, hasComputerDeclaration })),
        computerImageRequests,
        computerImageBase64Chars,
        captureMode: fixtureCapture,
        windowScopedObservationChecks,
        computerActions,
        computerDecisions,
        hostComputerInspectionCount: computerRpcMethods.filter((method) => method === "computer.inspect").length,
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
