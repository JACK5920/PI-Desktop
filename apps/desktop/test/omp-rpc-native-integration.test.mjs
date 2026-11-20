import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import ts from "typescript";
import { normalizeOmpTranscriptSnapshot, persistOmpForkTranscriptSnapshots } from "../src/lib/omp-transcript-sync.mjs";
import { hasOmpTodoSnapshot, mergeOmpTodoMetadata } from "../src/components/omp-todo-edit.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

async function removeTestDirectoryWithRetries(directory) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = process.platform === "win32" && ["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code);
      if (!retryable || attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function loadOmpModelRecoveryModule(transcriptMapperUrl) {
  const modelRecovery = await read("../electron/main/omp/session-model-recovery.ts");
  const recoveryTranscriptImport = /import \{ normalizeOmpTranscriptSnapshot \} from "[^"]*omp-transcript-sync\.mjs";/;
  assert.match(modelRecovery, recoveryTranscriptImport, "expected the model-recovery transcript mapper import");
  const modelRecoveryWithTranscriptMapper = modelRecovery.replace(
    recoveryTranscriptImport,
    `const { normalizeOmpTranscriptSnapshot } = await import("${transcriptMapperUrl}");`,
  );
  const modelRecoveryJavascript = ts.transpileModule(modelRecoveryWithTranscriptMapper, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(modelRecoveryJavascript).toString("base64")}`;
}

function createEventCollector() {
  const events = [];
  const waiters = new Set();
  return {
    events,
    emit(event) {
      events.push(event);
      for (const waiter of waiters) {
        if (!waiter.predicate(event)) continue;
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    },
    waitFor(predicate, timeoutMs = 5_000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve: (event) => { clearTimeout(timer); resolve(event); } };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for OMP event after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
  };
}

function isOmpVersionAtLeast(version, minimum) {
  const actualParts = String(version).match(/(\d+)\.(\d+)\.(\d+)/);
  const minimumParts = String(minimum).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!actualParts || !minimumParts) return false;
  for (let index = 1; index <= 3; index += 1) {
    const actual = Number(actualParts[index]);
    const required = Number(minimumParts[index]);
    if (actual > required) return true;
    if (actual < required) return false;
  }
  return true;
}

function entriesInTree(tree, output = []) {
  for (const node of Array.isArray(tree) ? tree : []) {
    if (node?.entry && typeof node.entry === "object") output.push(node.entry);
    entriesInTree(node?.children, output);
  }
  return output;
}

async function loadOmpRpcRuntime() {
  let source = await read("../electron/main/omp/rpc-runtime.ts");
  // This isolated test imports the TypeScript class through a data URL so Node
  // built-ins resolve normally. Replace the only relative Electron-main import
  // with a test no-op; proxy behavior has its own tests.
  const dependency = /import \{ applyProxyToChildEnv \} from "\.\.\/network-proxy";/;
  assert.match(source, dependency, "expected the runtime's proxy helper import");
  source = source.replace(dependency, "const applyProxyToChildEnv = (env) => env;");
  const hostBridgeImport = /import \{ normalizeOmpHostToolRequest, workspacePathFromOmpUri \} from "\.\/host-bridge\.mjs";/;
  assert.match(source, hostBridgeImport, "expected the bounded OMP host bridge helper import");
  const hostBridge = await read("../electron/main/omp/host-bridge.mjs");
  const hostBridgeUrl = `data:text/javascript;base64,${Buffer.from(hostBridge).toString("base64")}`;
  source = source.replace(hostBridgeImport, `const { normalizeOmpHostToolRequest, workspacePathFromOmpUri } = await import("${hostBridgeUrl}");`);
  const transcriptImport = /import \{ normalizeOmpTranscriptSnapshot \} from "[^\"]*omp-transcript-sync\.mjs";/;
  assert.match(source, transcriptImport, "expected the safe OMP transcript snapshot mapper import");
  const transcriptMapper = await read("../src/lib/omp-transcript-sync.mjs");
  const transcriptMapperUrl = `data:text/javascript;base64,${Buffer.from(transcriptMapper).toString("base64")}`;
  source = source.replace(transcriptImport, `const { normalizeOmpTranscriptSnapshot } = await import("${transcriptMapperUrl}");`);
  const historyEntryImport = /import \{ describeOmpNativeLegacyLookup, describeOmpNativePromptMappingSkip, findNewOmpNativeUserEntryId, findOmpNativeTreeEntry, resolveOmpNativeMessageEntryId \} from "\.\/history-entry\.mjs";/;
  assert.match(source, historyEntryImport, "expected the native OMP history entry resolver import");
  const historyEntryModule = await read("../electron/main/omp/history-entry.mjs");
  const historyEntryUrl = `data:text/javascript;base64,${Buffer.from(historyEntryModule).toString("base64")}`;
  source = source.replace(historyEntryImport, `const { describeOmpNativeLegacyLookup, describeOmpNativePromptMappingSkip, findNewOmpNativeUserEntryId, findOmpNativeTreeEntry, resolveOmpNativeMessageEntryId } = await import("${historyEntryUrl}");`);
  const guardImport = /import \{ OMP_TASK_TOOLS_GUARD_EXTENSION \} from "\.\/task-tools-guard\.mjs";/;
  assert.match(source, guardImport, "expected the managed Task tools guard extension import");
  const guardModule = await read("../electron/main/omp/task-tools-guard.mjs");
  const guardModuleUrl = `data:text/javascript;base64,${Buffer.from(guardModule).toString("base64")}`;
  source = source.replace(guardImport, `const { OMP_TASK_TOOLS_GUARD_EXTENSION } = await import("${guardModuleUrl}");`);
  const profileSettingsImport = /import \{ readOmpProfileSettings \} from "\.\/profile-settings\.mjs";/;
  assert.match(source, profileSettingsImport, "expected the app-managed OMP profile settings import");
  const profileSettings = await read("../electron/main/omp/profile-settings.mjs");
  const profileSettingsUrl = `data:text/javascript;base64,${Buffer.from(profileSettings).toString("base64")}`;
  source = source.replace(profileSettingsImport, `const { readOmpProfileSettings } = await import("${profileSettingsUrl}");`);
  const localSpillImport = /import \{\s*parseOmpLocalSpillRef,\s*readOmpNativeSessionId,\s*resolveOmpLocalSpillFile,\s*resolveOmpLocalSpillRoot,\s*\} from "\.\/local-spill-ref\.mjs";/;
  assert.match(source, localSpillImport, "expected the session-scoped OMP local spill resolver import");
  const localSpillModule = await read("../electron/main/omp/local-spill-ref.mjs");
  const localSpillUrl = `data:text/javascript;base64,${Buffer.from(localSpillModule).toString("base64")}`;
  source = source.replace(localSpillImport, `const {
    parseOmpLocalSpillRef,
    readOmpNativeSessionId,
    resolveOmpLocalSpillFile,
    resolveOmpLocalSpillRoot,
  } = await import("${localSpillUrl}");`);
  const modelRecoveryImport = /import \{\s*buildModelUnavailableError,\s*buildProviderUnavailableError,\s*catalogProviders,\s*extractRestoreModelFailure,\s*isRestoreModelFailure,\s*restoreMappedSessionFile,\s*selectModelCandidates,\s*type OmpModelRef,\s*\} from "\.\/session-model-recovery";/;
  assert.match(source, modelRecoveryImport, "expected the model-recovery helper import");
  const modelRecoveryUrl = await loadOmpModelRecoveryModule(transcriptMapperUrl);
  source = source.replace(modelRecoveryImport, `const {
    buildModelUnavailableError,
    buildProviderUnavailableError,
    catalogProviders,
    extractRestoreModelFailure,
    isRestoreModelFailure,
    restoreMappedSessionFile,
    selectModelCandidates,
  } = await import("${modelRecoveryUrl}");`);
  assert.doesNotMatch(source, /from "\.\/session-model-recovery";/, "the model-recovery dependency must be replaced before data-URL import");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { OmpRpcRuntime } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  return OmpRpcRuntime;
}

test("OMP prompt admission serializes per chat and releases the next operation", async () => {
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const runtime = new OmpRpcRuntime({ rootDir: tmpdir(), manager: { getExecutablePath: async () => null }, emit() {} });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const order = [];
  const first = runtime.withPromptAdmission("same-chat", async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const second = runtime.withPromptAdmission("same-chat", async () => { order.push("second"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"], "second request must not capture the same native tree baseline concurrently");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("OMP tree navigation and fork refuse to overlap native message identity capture", async () => {
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "omp-native-identity-lock-"));
  try {
    const runtime = new OmpRpcRuntime({ rootDir, manager: { getExecutablePath: async () => null }, emit() {} });
    runtime.sessions.set("chat", {
      sessionId: "chat",
      runId: "run",
      child: {},
      stderrBuffer: "",
      bootstrapModelAttempt: false,
      bootstrapFallbackRequested: false,
      decoder: null,
      stdoutBuffer: "",
      pending: new Map(),
      ready: Promise.resolve(),
      resolveReady() {},
      rejectReady() {},
      nextId: 1,
      chunks: null,
      closing: false,
      cwd: rootDir,
      workspaceRoot: null,
      busy: false,
      forking: false,
      mappingPrompt: true,
      supportsBashExcludeFromContext: false,
      cancelledHostRequestIds: new Set(),
      hostRequestControllers: new Map(),
    });
    await assert.rejects(runtime.navigateTreeAndSync({ sessionId: "chat", entryId: "node", replaceTranscript: async () => {} }), /另一项原生历史操作/);
    await assert.rejects(runtime.forkToSession({ sessionId: "chat", targetSessionId: "child", cwd: rootDir, entryId: "node" }), /正在同步新消息的原生关联/);
  } finally {
    await removeTestDirectoryWithRetries(rootDir);
  }
});

test("OMP native user message mappings are one-to-one and cannot point two Host UUIDs at one node", async () => {
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "omp-native-identity-unique-"));
  try {
    const runtime = new OmpRpcRuntime({ rootDir, manager: { getExecutablePath: async () => null }, emit() {} });
    await runtime.updateNativeMessageEntryId("chat", "b5f9407f-cdb2-48f8-8afc-e221c493ac58", "native-entry-1");
    await assert.rejects(
      runtime.updateNativeMessageEntryId("chat", "d17e7335-0704-4d4c-b603-a0f5717b7496", "native-entry-1"),
      /mapping must be one-to-one/,
    );
    const mappings = JSON.parse(await readFile(join(rootDir, "runtime", "native-message-mappings.json"), "utf8"));
    assert.deepEqual(Object.values(mappings.sessions), [{ "b5f9407f-cdb2-48f8-8afc-e221c493ac58": "native-entry-1" }]);
  } finally {
    await removeTestDirectoryWithRetries(rootDir);
  }
});

async function loadOmpEventAdapter() {
  let source = await read("../electron/main/omp/rpc-event-adapter.ts");
  const modelRecoveryImport = /import \{ classifyOmpFailure \} from "\.\/session-model-recovery";/;
  assert.match(source, modelRecoveryImport, "expected the native RPC event adapter model-recovery import");
  const transcriptMapper = await read("../src/lib/omp-transcript-sync.mjs");
  const transcriptMapperUrl = `data:text/javascript;base64,${Buffer.from(transcriptMapper).toString("base64")}`;
  const modelRecoveryUrl = await loadOmpModelRecoveryModule(transcriptMapperUrl);
  source = source.replace(modelRecoveryImport, `const { classifyOmpFailure } = await import("${modelRecoveryUrl}");`);
  assert.doesNotMatch(source, /from "\.\/session-model-recovery";/, "the event adapter model-recovery dependency must be replaced before data-URL import");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  assert.doesNotMatch(javascript, /session-model-recovery/, "the transpiled event adapter must not retain a relative module reference");
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("OMP fork transcript synchronization is a durable, idempotent recovery journal", async () => {
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "omp-fork-sync-journal-"));
  try {
    const options = { rootDir, manager: { getExecutablePath: async () => null }, emit() {} };
    const runtime = new OmpRpcRuntime(options);
    await runtime.beginForkTranscriptSync("parent-session", "child-session");
    assert.deepEqual(await runtime.pendingForkTranscriptSync("parent-session"), {
      parentSessionId: "parent-session",
      childSessionId: "child-session",
      createdAt: (await runtime.pendingForkTranscriptSync("child-session")).createdAt,
    });
    const restartedRuntime = new OmpRpcRuntime(options);
    assert.equal((await restartedRuntime.pendingForkTranscriptSync("child-session")).parentSessionId, "parent-session");
    await restartedRuntime.completeForkTranscriptSync("parent-session", "child-session");
    assert.equal(await runtime.pendingForkTranscriptSync("parent-session"), null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("OMP fork recovery records and restores the exact parent file if pair mapping never commits", async () => {
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "omp-fork-parent-map-recovery-"));
  try {
    const parentDir = join(rootDir, "runtime", "sessions", "parent-native");
    const parentFile = join(parentDir, "parent.jsonl");
    await mkdir(parentDir, { recursive: true });
    await writeFile(parentFile, "{}\n", "utf8");
    const options = { rootDir, manager: { getExecutablePath: async () => null }, emit() {} };
    const runtime = new OmpRpcRuntime(options);
    await runtime.beginForkTranscriptSync("parent-session", "child-session", parentFile);
    assert.equal((await runtime.pendingForkTranscriptSync("child-session")).parentSessionFile, parentFile);
    assert.equal(await runtime.hasMappedSession("parent-session"), false);
    await runtime.restoreForkParentMapping("parent-session", parentFile);
    assert.equal(await runtime.hasMappedSession("parent-session"), true);
    assert.equal((await runtime.pendingForkTranscriptSync("parent-session")).parentSessionFile, parentFile);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("OMP session mappings accept native profile branches but reject files outside the isolated runtime", async () => {
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "omp-managed-session-roots-"));
  try {
    const options = { rootDir, manager: { getExecutablePath: async () => null }, emit() {} };
    const runtime = new OmpRpcRuntime(options);
    const nativeProfileSession = join(rootDir, "runtime", "profile", "sessions", "branch.jsonl");
    await mkdir(join(rootDir, "runtime", "profile", "sessions"), { recursive: true });
    await writeFile(nativeProfileSession, "{}\n", "utf8");
    await runtime.restoreForkParentMapping("profile-branch", nativeProfileSession);
    assert.equal(await runtime.hasMappedSession("profile-branch"), true);

    const outsideSession = join(rootDir, "outside.jsonl");
    await writeFile(outsideSession, "{}\n", "utf8");
    await assert.rejects(runtime.restoreForkParentMapping("outside-branch", outsideSession), /escaped its managed session store/);
    assert.equal(await runtime.hasMappedSession("outside-branch"), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("a partial PI mirror write keeps the OMP fork journal replayable until both sides persist", async () => {
  const writes = [];
  let childWriteFailsOnce = true;
  let journalPending = true;
  const input = {
    parentSessionId: "parent",
    childSessionId: "child",
    parentMessages: [{ id: "p", role: "assistant" }],
    childMessages: [{ id: "c", role: "assistant" }],
    replaceMessages: async (sessionId, messages) => {
      writes.push(sessionId);
      if (sessionId === "child" && childWriteFailsOnce) {
        childWriteFailsOnce = false;
        throw new Error("injected PI child transcript write failure");
      }
      assert.ok(Array.isArray(messages));
    },
    complete: async (parentSessionId, childSessionId) => {
      assert.equal(parentSessionId, "parent");
      assert.equal(childSessionId, "child");
      journalPending = false;
    },
  };
  await assert.rejects(persistOmpForkTranscriptSnapshots(input), /injected PI child transcript write failure/);
  assert.equal(journalPending, true, "a failed second side must not retire the recovery intent");
  assert.deepEqual(writes, ["parent", "child"]);

  await persistOmpForkTranscriptSnapshots(input);
  assert.equal(journalPending, false);
  assert.deepEqual(writes, ["parent", "child", "parent", "child"], "replay replaces both canonical snapshots idempotently");
});

test("OMP assistant snapshots feed the reply footer with model, usage, timing and engine", async () => {
  const { ompMessageToUiMessage } = await loadOmpEventAdapter();
  const message = ompMessageToUiMessage({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    provider: "openai-codex",
    model: "gpt-6-luna",
    usage: {
      input: 7530,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 7542,
      cost: { input: 0.0004, output: 0.0003, cacheRead: 0, cacheWrite: 0, total: 0.0007 },
    },
    duration: 5172.39,
    ttft: 5011.84,
    timestamp: 1794535378129,
  }, "omp:run:msg-1", "complete");

  assert.equal(message.modelId, "gpt-6-luna");
  assert.equal(message.responseModelId, "gpt-6-luna");
  assert.equal(message.providerId, "openai-codex");
  assert.equal(message.engineOrigin, "omp");
  assert.deepEqual(message.usage, {
    inputTokens: 7530,
    outputTokens: 12,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 7542,
    cost: { input: 0.0004, output: 0.0003, cacheRead: 0, cacheWrite: 0, total: 0.0007 },
    costStatus: "reported",
  });
  assert.equal(message.responseDurationMs, 5172);
  assert.equal(message.providerWaitMs, 5011);
  // Both timings are floored to integer ms before the difference is taken.
  assert.equal(message.modelStreamDurationMs, 161);
});

test("OMP usage that cannot be trusted is dropped instead of rendered as zero", async () => {
  const { ompMessageToUiMessage } = await loadOmpEventAdapter();
  const message = ompMessageToUiMessage({
    role: "assistant",
    content: "hi",
    model: "m",
    usage: { input: "7530", output: -1 },
  }, "omp:run:msg-2", "complete");
  assert.equal(message.usage, undefined);
  assert.equal(message.modelId, "m");

  const user = ompMessageToUiMessage({ role: "user", content: "hey" }, "omp:run:user-1", "complete");
  assert.equal(user.engineOrigin, undefined);
});

test("OMP branch snapshots map complete user, assistant, image and tool history or fail closed", async () => {
  const png = Buffer.from("small image").toString("base64");
  const snapshot = normalizeOmpTranscriptSnapshot([
    { role: "user", content: [{ type: "text", text: "inspect this" }, { type: "image", mimeType: "image/png", data: png }], timestamp: 1_794_701_830_360 },
    { role: "assistant", content: [{ type: "thinking", thinking: "checking" }, { type: "text", text: "I will inspect it." }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }], timestamp: 1_794_701_830_370 },
    { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "file contents" }], timestamp: 1_794_701_830_380 },
    { role: "assistant", content: [{ type: "text", text: "Done." }], model: "m", provider: "p", timestamp: 1_794_701_830_390 },
  ]);
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(snapshot.messages[0].inlineImages[0].mimeType, "image/png");
  assert.deepEqual(snapshot.messages[0].inlineContent.map((block) => block.type), ["text", "image"]);
  assert.equal(snapshot.messages[0].inlineContent[0].text, "inspect this");
  assert.equal(snapshot.messages[1].thinking, "checking");
  assert.equal(snapshot.messages[2].toolName, "read");
  assert.deepEqual(snapshot.messages[2].toolArgs, { path: "a.txt" });
  assert.equal(snapshot.messages[2].toolResult, "file contents");
  assert.equal(snapshot.messages[3].engineOrigin, "omp");
  assert.equal(normalizeOmpTranscriptSnapshot([{ role: "system", content: "unsupported" }]).ok, false);
  assert.equal(normalizeOmpTranscriptSnapshot([{ role: "assistant", content: [{ type: "toolCall", id: "dangling", name: "read" }] }]).reason, "unmatched_tool_call");
  assert.equal(normalizeOmpTranscriptSnapshot([{ role: "user", content: [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }] }]).reason, "unsupported_image");
});

test("OMP restored Bash tool rows retain only the structured fork outcome needed by the GUI", () => {
  const snapshot = normalizeOmpTranscriptSnapshot([
    { role: "assistant", content: [{ type: "toolCall", id: "bash-call", name: "Bash", arguments: { command: "sleep 2 &" } }], timestamp: 1_794_701_830_370 },
    { role: "toolResult", toolCallId: "bash-call", content: [{ type: "text", text: "job started" }], details: {
      output: "job started", exitCode: 0, fork: { carried: false, jobs: true },
      unrelatedInternalData: { mayBeSensitive: "must not be copied wholesale" },
    }, timestamp: 1_794_701_830_380 },
  ]);
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.messages[1].toolResult, {
    details: { exitCode: 0, fork: { carried: false, jobs: true } },
  });
  assert.equal(snapshot.messages[1].content, "job started");
});

test("OMP transcript sync never retains Bash details for a different tool or unknown fields", () => {
  const snapshot = normalizeOmpTranscriptSnapshot([
    { role: "assistant", content: [{ type: "toolCall", id: "read-call", name: "Read", arguments: { path: "notes.txt" } }] },
    { role: "toolResult", toolCallId: "read-call", content: [{ type: "text", text: "contents" }], details: { exitCode: 0, fork: { carried: true, jobs: false } } },
  ]);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.messages[1].toolResult, "contents");
});

test("OMP session tree keeps browsing non-destructive and forks selected entries into separate PI chats", async () => {
  const controls = await read("../src/components/OmpSessionControls.tsx");
  const sessionSlice = await read("../src/stores/slices/session-slice.ts");
  const runtime = await read("../electron/main/omp/rpc-runtime.ts");
  const ipc = await read("../electron/main/ipc/register.ts");
  assert.match(controls, /api\.forkOmpSession\(\{ sessionId, entryId: selectedTreeEntry \}\)/);
  assert.match(controls, /syncNativeSessionTranscript\(sessionId, result\.parentMessages\)/);
  assert.match(controls, /selectSession\(result\.session\.id\)/);
  assert.match(ipc, /persistOmpForkTranscriptSnapshots\(/);
  assert.match(ipc, /recoverOmpForkTranscriptSync\(context\.sessionId\)/);
  assert.match(ipc, /恢复记录已保留/);
  assert.match(ipc, /restoreForkParentMapping\(pending\.parentSessionId, pending\.parentSessionFile\)/);
  assert.doesNotMatch(controls, /command: "navigate_tree"/);
  assert.doesNotMatch(controls, /replaceSessionMessages\(sessionId/);
  assert.match(runtime, /if \(source\.mappingPrompt\) throw new Error\("OMP 正在同步新消息的原生关联，暂不能分叉"\)/);
  assert.match(runtime, /if \(session\.forking \|\| session\.mappingPrompt\) throw new Error\("OMP 会话正在执行另一项原生历史操作"\)/);
  assert.match(runtime, /session\.forking && !internalForkCommand && !READ_ONLY_DURING_FORK\.has\(type\)/);
  assert.match(runtime, /finally \{\s*if \(ownsHistoryLock\) source\.forking = false;/);
  assert.match(runtime, /if \(forkAttempted && originalFile && sourceSessionDir/);
  assert.match(ipc, /const selectedEntry = findEntry\(treeData\?\.tree\);[\s\S]*?if \(!selectedEntry \|\| !\["user", "assistant"\]/);
  assert.ok(ipc.indexOf("const selectedEntry = findEntry(treeData?.tree)") < ipc.indexOf("const created = await host.call", ipc.indexOf("ompRpcForkSession")), "IPC must validate the OMP tree entry before creating the child PI chat");
  assert.match(sessionSlice, /syncNativeSessionTranscript: \(sessionId, messages\)[\s\S]*?runtime\.cacheSessionTranscript\(sessionId, messages, window\)/);
});

test("OMP assistant image blocks are rendered only when mime, base64, and preview budgets are valid", async () => {
  const { ompMessageToUiMessage } = await loadOmpEventAdapter();
  const image = (mimeType, data) => ({ type: "image", mimeType, data });
  const validPng = Buffer.from("png-fixture").toString("base64");
  const message = ompMessageToUiMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Here is the result." },
      image("image/png", validPng),
      image("image/svg+xml", "PHN2Zz4="),
      image("image/jpeg", "not-base64!"),
    ],
  }, "omp:run:image", "complete");
  assert.equal(message.content, "Here is the result.");
  assert.deepEqual(message.inlineImages, [{ dataUrl: `data:image/png;base64,${validPng}`, mimeType: "image/png" }]);
  assert.deepEqual(message.inlineContent.map((block) => block.type), ["text", "image"]);
  assert.equal(message.inlineContent[0].text, "Here is the result.");
  assert.equal(message.inlineContent[1].dataUrl, `data:image/png;base64,${validPng}`);
  const oversized = "A".repeat(2 * 1024 * 1024 + 4);
  const bounded = ompMessageToUiMessage({ role: "assistant", content: [image("image/png", oversized)] }, "omp:run:large-image", "complete");
  assert.equal(bounded.inlineImages, undefined);
  const { readFile: readSource } = await import("node:fs/promises");
  const messageRow = await readSource(new URL("../src/features/chat/transcript/MessageRow.tsx", import.meta.url), "utf8");
  assert.match(messageRow, /message\.inlineImages\?\.length/);
  assert.match(messageRow, /className="omp-inline-images"/);
  const assistantParts = await readSource(new URL("../src/features/chat/transcript/AssistantTurnParts.tsx", import.meta.url), "utf8");
  assert.match(assistantParts, /hasOrderedImages[\s\S]*?displayContent\.slice[\s\S]*?omp-inline-image-block/);
  assert.match(messageRow, /message\.inlineContent\?\.length/);
});

test("OMP GUI is backed by isolated native RPC sessions, not an embedded terminal", async () => {
  const runtime = await read("../electron/main/omp/rpc-runtime.ts");
  const protocol = await read("../../../packages/shared/src/protocol.ts");
  const desktop = await read("../package.json");
  assert.match(runtime, /--mode", "rpc-ui"/);
  assert.match(runtime, /--extension", taskToolsGuardPath/);
  assert.match(runtime, /pi-desktop-extensions/);
  assert.match(runtime, /PI_CODING_AGENT_DIR: profileDir/);
  assert.match(runtime, /createHash\("sha256"\).*sessionId/s);
  assert.match(runtime, /negotiate_protocol/);
  assert.match(runtime, /command\(input\.sessionId, "set_ask_dialog", \{ enabled: true \}\)/);
  assert.match(runtime, /this\.starting\.get\(input\.sessionId\)/);
  assert.match(runtime, /type: "host_tool_result"/);
  assert.match(runtime, /type: "host_uri_result"/);
  assert.match(protocol, /ompRpcAttach/);
  assert.match(protocol, /ompRpcEvent/);
  assert.doesNotMatch(desktop, /@xterm\/xterm|after-pack-omp-tui/);
});

test("restored OMP sessions use Host's canonical project context before the window cache is hydrated", async () => {
  const ipc = await read("../electron/main/ipc/register.ts");
  const start = ipc.indexOf("const resolveOmpSessionContext = async");
  const end = ipc.indexOf("const captureOmpSubagents", start);
  const context = ipc.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(context, /!sessionProjects\.has\(sessionId\)/);
  assert.match(context, /session\.get[\s\S]*?detail\.session\.agentEngine !== "omp"/);
  assert.match(context, /detail\.session\.projectPath \?\? sessionProjects\.get\(sessionId\)/);
});

test("OMP provider settings use a dedicated non-chat RPC session with a narrow command surface", async () => {
  const ipc = await read("../electron/main/ipc/register.ts");
  const runtime = await read("../electron/main/omp/rpc-runtime.ts");
  const settings = await read("../src/components/settings/OmpProviderManager.tsx");
  assert.match(ipc, /if \(sessionId === OMP_SETTINGS_RPC_SESSION_ID\)[\s\S]*?app\.getPath\("home"\)/);
  assert.match(ipc, /managementCommands = new Set\(\["get_state", "get_available_models", "get_available_thinking_levels", "get_login_providers", "get_logout_accounts", "login", "logout", "set_model"\]\)/);
  assert.match(ipc, /event\.sessionId === OMP_SETTINGS_RPC_SESSION_ID\) return/);
  assert.match(runtime, /input\.sessionId === this\.options\.settingsSessionId/);
  assert.match(settings, /OMP_SETTINGS_RPC_SESSION_ID/);
  assert.match(settings, /get_login_providers/);
  assert.match(settings, /getOmpHiddenModels/);
});

test("OMP retries first-run RPC startup when a non-empty profile has no default model", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to run the isolated native-engine integration check."); return; }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-profile-retry-"));
  const profileDir = join(rootDir, "runtime", "profile");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "existing-profile-marker"), "profile is not empty");
  const events = [];
  const runtime = new OmpRpcRuntime({
    rootDir,
    manager: { getExecutablePath: async () => binary },
    emit: (event) => events.push(event),
  });
  try {
    const attached = await runtime.attach({ sessionId: "non-empty-profile", cwd: rootDir });
    assert.equal(attached.state?.model?.provider, "openai");
    assert.equal(attached.state?.model?.id, "gpt-5.2");
    const login = await runtime.command("non-empty-profile", "get_login_providers");
    assert.ok(Array.isArray(login.data?.providers));
    assert.ok(login.data.providers.length > 0);
    const guardPath = join(profileDir, "pi-desktop-extensions", "task-tools-guard.mjs");
    assert.match(await readFile(guardPath, "utf8"), /pi\.on\("tool_call"/);
    assert.doesNotMatch(events.map((event) => event.frame.type).join(","), /process_exit|runtime_error|extension_error/);
  } finally {
    await runtime.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("OMP 18.22.2 Kiro provider is discovered by native RPC and the settings list stays data-driven", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to verify the latest native provider catalog."); return; }
  const { stdout } = await new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => execFile(binary, ["--version"], { windowsHide: true }, (error, out) => error ? reject(error) : resolve({ stdout: out })));
  });
  const version = String(stdout).match(/(\d+)\.(\d+)\.(\d+)/);
  const isKiroRelease = version && (
    Number(version[1]) > 18 ||
    (Number(version[1]) === 18 && Number(version[2]) > 22) ||
    (Number(version[1]) === 18 && Number(version[2]) === 22 && Number(version[3]) >= 2)
  );
  if (!isKiroRelease) { t.skip("Kiro is included in OMP 18.22.2 and newer."); return; }

  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-kiro-catalog-"));
  const runtime = new OmpRpcRuntime({ rootDir, manager: { getExecutablePath: async () => binary }, emit() {} });
  try {
    await runtime.attach({ sessionId: "isolated-kiro-catalog", cwd: rootDir }, { includeMessages: false });
    const response = await runtime.command("isolated-kiro-catalog", "get_login_providers");
    const providers = response.data?.providers;
    assert.ok(Array.isArray(providers));
    const kiro = providers.find((provider) => provider.id === "kiro");
    assert.ok(kiro, "OMP's native Kiro provider must be present in its login catalog");
    assert.equal(typeof kiro.name, "string");
    assert.equal(typeof kiro.available, "boolean");
    assert.equal(typeof kiro.authenticated, "boolean");

    const managerUi = await read("../src/components/settings/OmpProviderManager.tsx");
    assert.match(managerUi, /setProviders\(Array\.isArray\(auth\.data\?\.providers\) \? auth\.data\.providers : \[\]\)/);
    assert.match(managerUi, /providers\.filter\(\(provider\) => `\$\{provider\.name\} \$\{provider\.id\}`/);
    assert.doesNotMatch(managerUi, /PROVIDER_IDS|SUPPORTED_PROVIDERS|providerId === "kiro"/);
  } finally {
    await runtime.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("native OMP discovers a desktop-managed compatible model using the isolated key environment", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to validate native models.json loading."); return; }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-custom-model-"));
  const profileDir = join(rootDir, "runtime", "profile");
  await mkdir(profileDir, { recursive: true });
  let observedAuthorization = null;
  const apiServer = createServer((request, response) => {
    observedAuthorization = request.headers.authorization ?? null;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "custom provider works" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => apiServer.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = apiServer.address();
  assert.ok(address && typeof address === "object");
  await writeFile(join(profileDir, "models.json"), JSON.stringify({ providers: {
    pi_custom_compatible: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "PI_OMP_CUSTOM_MODEL_API_KEY", authHeader: true,
      models: [{ id: "acceptance-model", name: "Acceptance model", contextWindow: 32000, maxTokens: 4096, input: ["text", "image"], reasoning: false }],
    },
  } }));
  const events = [];
  const runtime = new OmpRpcRuntime({
    rootDir,
    manager: { getExecutablePath: async () => binary },
    emit: (event) => events.push(event),
    getCustomModelApiKeys: async () => ({ PI_OMP_CUSTOM_MODEL_API_KEY: "isolated-test-key-not-for-network-use" }),
  });
  try {
    await runtime.attach({ sessionId: "custom-model-session", cwd: rootDir });
    const response = await runtime.command("custom-model-session", "get_available_models");
    const models = response.data?.models ?? [];
    assert.ok(models.some((model) => model.provider === "pi_custom_compatible" && model.id === "acceptance-model"));
    await runtime.command("custom-model-session", "set_model", { provider: "pi_custom_compatible", modelId: "acceptance-model" });
    await runtime.prompt({ sessionId: "custom-model-session", cwd: rootDir, message: "Say a short hello." });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !events.some((event) => event.frame.type === "prompt_result" || event.frame.type === "runtime_error")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(observedAuthorization, "Bearer isolated-test-key-not-for-network-use");
    const reply = events.find((event) => event.frame.type === "message_end" && event.frame.message?.role === "assistant");
    assert.ok(reply, `expected an assistant message; received frames: ${events.map((event) => event.frame.type).join(", ")}`);
    assert.match(JSON.stringify(reply.frame.message), /custom provider works/);
    assert.ok(events.some((event) => event.frame.type === "prompt_result" && event.frame.status === "completed"));
  } finally {
    await runtime.stopAll();
    await new Promise((resolve) => apiServer.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("native OMP provider settings attach despite a stale remembered chat model", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to validate the OMP settings RPC session."); return; }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-settings-session-"));
  const profileDir = join(rootDir, "runtime", "profile");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "pi-selected-model.json"), JSON.stringify({ provider: "stale-provider", modelId: "missing-model" }));
  const sessionId = "pi-desktop-omp-provider-settings";
  const events = [];
  const runtime = new OmpRpcRuntime({
    rootDir, manager: { getExecutablePath: async () => binary }, emit: (event) => events.push(event), settingsSessionId: sessionId,
  });
  try {
    const attached = await runtime.attach({ sessionId, cwd: rootDir });
    assert.equal(attached.state?.model?.provider, "openai");
    assert.equal(attached.state?.model?.id, "gpt-5.2");
    const [providers, models] = await Promise.all([
      runtime.command(sessionId, "get_login_providers"),
      runtime.command(sessionId, "get_available_models"),
    ]);
    assert.ok(Array.isArray(providers.data?.providers));
    assert.ok(Array.isArray(models.data?.models));
    if (process.env.PI_OMP_EXPECTS_ANTIGRAVITY === "1") {
      assert.match(JSON.stringify(providers.data), /antigravity-cli/, "latest OMP login provider catalog should expose the native Antigravity CLI flow");
    }
    assert.ok(events.every((event) => event.sessionId === sessionId));
  } finally {
    await runtime.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("native OMP 18.22.1+ risk warning is a cancellable pre-auth RPC input", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to verify the isolated native OMP login prompt."); return; }
  const { stdout } = await new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => execFile(binary, ["--version"], { windowsHide: true }, (error, out) => error ? reject(error) : resolve({ stdout: out })));
  });
  const version = String(stdout).match(/\d+\.\d+\.\d+/)?.[0];
  if (!isOmpVersionAtLeast(version, "18.22.1")) { t.skip("The RPC risk acknowledgement requires native OMP 18.22.1 or newer."); return; }

  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-risk-acknowledgement-"));
  const sessionId = "pi-desktop-omp-risk-confirmation";
  const collector = createEventCollector();
  const runtime = new OmpRpcRuntime({
    rootDir,
    manager: { getExecutablePath: async () => binary },
    settingsSessionId: sessionId,
    emit: (event) => collector.emit(event),
  });
  try {
    await runtime.attach({ sessionId, cwd: rootDir }, { includeMessages: false });
    const providers = await runtime.command(sessionId, "get_login_providers");
    assert.ok(providers.data?.providers?.some((provider) => provider.id === "antigravity-cli"));

    const login = runtime.command(sessionId, "login", { providerId: "antigravity-cli" });
    const warning = await collector.waitFor((event) => event.sessionId === sessionId && event.frame.type === "extension_ui_request" && event.frame.method === "input");
    assert.equal(warning.frame.placeholder, "yes");
    assert.match(warning.frame.title ?? warning.frame.message ?? "", /at your own risk|risk/i);
    runtime.respondExtensionUi(sessionId, { type: "extension_ui_response", id: warning.frame.id, value: "no" });
    await assert.rejects(login, /Login cancelled/i);
    assert.equal(collector.events.some((event) => event.frame.type === "auth_url" || event.frame.method === "open_url"), false, "rejecting the warning must not open or emit an authorization URL");
  } finally {
    await runtime.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("native OMP 18.22.1+ only reveals the provider authorization URL after explicit risk acceptance", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to verify the isolated native OMP login prompt."); return; }
  const { stdout } = await new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => execFile(binary, ["--version"], { windowsHide: true }, (error, out) => error ? reject(error) : resolve({ stdout: out })));
  });
  const version = String(stdout).match(/\d+\.\d+\.\d+/)?.[0];
  if (!isOmpVersionAtLeast(version, "18.22.1")) { t.skip("The RPC risk acknowledgement requires native OMP 18.22.1 or newer."); return; }

  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-risk-acceptance-"));
  const sessionId = "pi-desktop-omp-risk-acceptance";
  const collector = createEventCollector();
  const runtime = new OmpRpcRuntime({
    rootDir,
    manager: { getExecutablePath: async () => binary },
    settingsSessionId: sessionId,
    emit: (event) => collector.emit(event),
  });
  try {
    await runtime.attach({ sessionId, cwd: rootDir }, { includeMessages: false });
    const login = runtime.command(sessionId, "login", { providerId: "antigravity-cli" });
    const warning = await collector.waitFor((event) => event.sessionId === sessionId && event.frame.type === "extension_ui_request" && event.frame.method === "input");
    assert.equal(warning.frame.placeholder, "yes");
    runtime.respondExtensionUi(sessionId, { type: "extension_ui_response", id: warning.frame.id, value: "yes" });

    const authorization = await collector.waitFor((event) => event.sessionId === sessionId && (
      event.frame.type === "auth_url" ||
      (event.frame.type === "extension_ui_request" && event.frame.method === "open_url")
    ));
    assert.ok(typeof authorization.frame.url === "string" || typeof authorization.frame.launchUrl === "string");
    assert.ok(collector.events.indexOf(warning) < collector.events.indexOf(authorization), "the authorization URL must follow explicit risk acceptance");
    await assert.rejects(login, /sign-in failed|Login cancelled/i, "the isolated test intentionally does not complete the browser OAuth callback");
  } finally {
    await runtime.stopAll().catch((error) => {
      assert.match(String(error), /OMP RPC session closed/, "only tolerate the expected process-close response after the no-browser sign-in test");
    });
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("native OMP exposes command catalog, BTW history and subagent snapshots in isolated RPC", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to run the native capability smoke check."); return; }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-capability-smoke-"));
  const runtime = new OmpRpcRuntime({ rootDir, manager: { getExecutablePath: async () => binary }, emit() {} });
  try {
    await runtime.attach({ sessionId: "native-capability-smoke", cwd: rootDir }, { includeMessages: false });
    await runtime.command("native-capability-smoke", "set_subagent_subscription", { level: "events" });
    const [commands, btw, agents, state] = await Promise.all([
      runtime.command("native-capability-smoke", "get_available_commands"),
      runtime.command("native-capability-smoke", "get_btw_history"),
      runtime.command("native-capability-smoke", "get_subagents"),
      runtime.command("native-capability-smoke", "get_state"),
    ]);
    assert.ok(Array.isArray(commands.data?.commands));
    assert.ok(Array.isArray(btw.data?.records));
    assert.ok(Array.isArray(agents.data?.subagents));
    assert.equal(typeof state.data?.desktopRpcCapabilities?.supportsBashExcludeFromContext, "boolean");
    if (state.data.desktopRpcCapabilities.supportsBashExcludeFromContext) {
      const bash = await runtime.command("native-capability-smoke", "bash", { command: "echo PI_OMP_CONTEXT_EXCLUSION_SMOKE", excludeFromContext: true });
      assert.equal(bash.success, true);
      assert.match(bash.data?.output ?? "", /PI_OMP_CONTEXT_EXCLUSION_SMOKE/);
    }
    const lease = await runtime.command("native-capability-smoke", "get_session_lease", { sessionIds: [state.data.sessionId] });
    assert.ok(Array.isArray(lease.data?.held));
    assert.ok(Array.isArray(lease.data?.unknown));
    const askDialog = await runtime.command("native-capability-smoke", "set_ask_dialog", { enabled: true });
    assert.equal(askDialog.data?.enabled, true);
    const simpleTodoFixture = [{ name: "Lossless simple todo", tasks: [{ content: "Preserve the supported task fields", status: "pending" }] }];
    const simpleTodoSaved = await runtime.command("native-capability-smoke", "set_todos", { phases: simpleTodoFixture });
    assert.deepEqual(simpleTodoSaved.data?.todoPhases, simpleTodoFixture, "simple OMP todo fields round-trip without data loss");
    const todoFixture = [{ name: "Isolated todo round trip", tasks: [{ content: "Observe native normalization", status: "pending", details: "must remain visible to this test", notes: ["fixture note"] }] }];
    const todoSaved = await runtime.command("native-capability-smoke", "set_todos", { phases: todoFixture });
    assert.deepEqual(todoSaved.data?.todoPhases, [{ name: "Isolated todo round trip", tasks: [{ content: "Observe native normalization", status: "pending" }] }]);
    assert.equal(todoSaved.data.todoPhases[0].tasks[0].details, undefined, "OMP's live TodoTracker snapshot omits extension fields");
    assert.equal(todoSaved.data.todoPhases[0].tasks[0].notes, undefined, "OMP's live TodoTracker snapshot omits extension fields");
    const todoState = await runtime.command("native-capability-smoke", "get_state");
    assert.deepEqual(todoState.data?.todoPhases, todoSaved.data.todoPhases);
    const todoTree = await runtime.command("native-capability-smoke", "get_tree");
    const persistedEdit = entriesInTree(todoTree.data?.tree).findLast((entry) => entry.type === "custom" && entry.customType === "user_todo_edit");
    assert.deepEqual(persistedEdit?.data?.phases, todoFixture, "OMP's own durable session tree retains every extended field submitted through set_todos");
    assert.deepEqual(
      mergeOmpTodoMetadata(todoState.data?.todoPhases, todoTree.data?.tree, todoTree.data?.leafId),
      todoFixture,
      "the GUI rehydrates the exact extended metadata from the active native OMP branch",
    );
    assert.equal(hasOmpTodoSnapshot(todoTree.data?.tree, todoTree.data?.leafId, todoFixture), true);
    await assert.rejects(runtime.command("native-capability-smoke", "live_connect", { sdpOffer: "" }), /live_connect requires a non-empty sdpOffer/i);
  } finally { await runtime.stopAll(); await rm(rootDir, { recursive: true, force: true }); }
});

test("native OMP 18.20.2+ supports per-session cache warming controls", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to verify native cache warming controls."); return; }
  const { stdout } = await new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => execFile(binary, ["--version"], { windowsHide: true }, (error, out) => error ? reject(error) : resolve({ stdout: out })));
  });
  const version = String(stdout).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 18 || (Number(version[1]) === 18 && Number(version[2]) < 20) || (Number(version[1]) === 18 && Number(version[2]) === 20 && Number(version[3]) < 2)) {
    t.skip("Cache warming RPC is only documented and verified in OMP 18.20.2 or newer.");
    return;
  }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-cache-warming-"));
  const runtime = new OmpRpcRuntime({ rootDir, manager: { getExecutablePath: async () => binary }, emit() {} });
  try {
    await runtime.attach({ sessionId: "cache-warming-smoke", cwd: rootDir }, { includeMessages: false });
    const state = await runtime.command("cache-warming-smoke", "get_state");
    assert.equal(state.data?.desktopRpcCapabilities?.supportsBashExcludeFromContext, true, "OMP 18.20.2 or newer advertises context-excluded native bash");
    const bash = await runtime.command("cache-warming-smoke", "bash", { command: "echo PI_OMP_CONTEXT_EXCLUSION_SMOKE", excludeFromContext: true });
    assert.equal(bash.success, true);
    assert.match(bash.data?.output ?? "", /PI_OMP_CONTEXT_EXCLUSION_SMOKE/);
    for (const mode of ["streaming", "idle", "off"]) {
      const response = await runtime.command("cache-warming-smoke", "set_cache_warming", { mode });
      assert.equal(response.success, true, `OMP should accept cache warming mode ${mode}`);
      assert.equal(response.data?.mode, mode);
    }
  } finally { await runtime.stopAll(); await rm(rootDir, { recursive: true, force: true }); }
});

test("native OMP 18.22.0 loads the managed force worktree policy without touching a worktree", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to verify the managed profile against native OMP 18.22.0."); return; }
  const { stdout } = await new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => execFile(binary, ["--version"], { windowsHide: true }, (error, out) => error ? reject(error) : resolve({ stdout: out })));
  });
  const version = String(stdout).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 18 || (Number(version[1]) === 18 && Number(version[2]) < 22)) {
    t.skip("The worktree force policy is only available in OMP 18.22.0 or newer.");
    return;
  }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-managed-profile-"));
  const profileDir = join(rootDir, "runtime", "profile");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "pi-desktop-managed.yml"), "# Isolated native compatibility fixture\ndefaultThinkingLevel: high\nworktree:\n  onExit: force\n", "utf8");
  const runtime = new OmpRpcRuntime({ rootDir, manager: { getExecutablePath: async () => binary }, emit() {} });
  try {
    await runtime.attach({ sessionId: "managed-force-policy-smoke", cwd: rootDir }, { includeMessages: false });
    const state = await runtime.command("managed-force-policy-smoke", "get_state");
    assert.equal(state.success, true, "OMP must parse the same managed profile file used by the settings UI");
    assert.equal(typeof state.data?.sessionId, "string");
    assert.ok(state.data.sessionId.length > 0);
    // No task or worktree is created: this verifies native config acceptance without exercising removal.
  } finally { await runtime.stopAll(); await rm(rootDir, { recursive: true, force: true }); }
});

test("native OMP historical entry fork preserves the parent and restores both mapped sessions after restart", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to verify OMP branch navigation without a real provider."); return; }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-branch-navigation-"));
  const profileDir = join(rootDir, "runtime", "profile");
  await mkdir(profileDir, { recursive: true });
  const responses = ["First isolated reply", "Second isolated reply"];
  let responseIndex = 0;
  const apiServer = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const content = responses[Math.min(responseIndex++, responses.length - 1)];
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => apiServer.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = apiServer.address();
  assert.ok(address && typeof address === "object");
  await writeFile(join(profileDir, "models.json"), JSON.stringify({ providers: {
    pi_branch_test: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "PI_OMP_BRANCH_TEST_KEY", authHeader: true,
      models: [{ id: "branch-model", name: "Branch model", contextWindow: 32000, maxTokens: 4096, input: ["text"], reasoning: false }],
    },
  } }));
  const events = [];
  let runtime = new OmpRpcRuntime({
    rootDir,
    manager: { getExecutablePath: async () => binary },
    emit: (event) => events.push(event),
    getCustomModelApiKeys: async () => ({ PI_OMP_BRANCH_TEST_KEY: "isolated-branch-key" }),
  });
  const sessionId = "native-branch-navigation";
  const waitForSettlement = async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (events.some((event) => event.sessionId === sessionId && event.frame.type === "runtime_error")) {
        assert.fail(`OMP runtime error: ${events.find((event) => event.sessionId === sessionId && event.frame.type === "runtime_error")?.frame.message}`);
      }
      const state = await runtime.command(sessionId, "get_state");
      if (events.some((event) => event.sessionId === sessionId && event.frame.type === "session_settled") &&
        state.data?.isStreaming !== true && state.data?.isCompacting !== true && state.data?.hasPendingAsyncWork !== true) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`expected native session to settle and report idle state; saw ${events.map((event) => event.frame.type).join(", ")}`);
  };
  const treeEntries = (nodes) => nodes.flatMap((node) => [node.entry, ...(Array.isArray(node.children) ? treeEntries(node.children) : [])].filter(Boolean));
  try {
    await runtime.attach({ sessionId, cwd: rootDir }, { includeMessages: false });
    await runtime.command(sessionId, "set_model", { provider: "pi_branch_test", modelId: "branch-model" });
    await runtime.prompt({ sessionId, cwd: rootDir, message: "First user request" });
    await waitForSettlement();
    const firstTree = await runtime.command(sessionId, "get_tree");
    const firstUserEntry = treeEntries(firstTree.data?.tree ?? []).find((entry) => entry.message?.role === "user");
    const firstAssistantEntry = treeEntries(firstTree.data?.tree ?? []).find((entry) => entry.message?.role === "assistant");
    assert.ok(firstUserEntry?.id, "expected a stable native user entry to branch before");
    assert.ok(firstAssistantEntry?.id, "expected a stable native assistant entry to navigate to");
    await runtime.prompt({ sessionId, cwd: rootDir, message: "Second user request" });
    await waitForSettlement();
    const beforeMessages = await runtime.command(sessionId, "get_messages");
    assert.equal(beforeMessages.data?.messages?.length > 0, true);
    const canonicalParentMessages = beforeMessages.data;
    const withoutRpcDefaults = (value) => Array.isArray(value)
      ? value.map(withoutRpcDefaults)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).filter(([key, field]) => !(key === "errorId" && field === 0)).map(([key, field]) => [key, withoutRpcDefaults(field)]))
        : value;
    const beforeTree = await runtime.command(sessionId, "get_tree");
    const previousLeafId = beforeTree.data?.leafId;
    let rejectedMirrorWrite = false;
    await assert.rejects(runtime.navigateTreeAndSync({
      sessionId,
      entryId: firstAssistantEntry.id,
      replaceTranscript: async () => { rejectedMirrorWrite = true; throw new Error("injected transcript mirror write failure"); },
    }), /injected transcript mirror write failure/);
    assert.equal(rejectedMirrorWrite, true);
    assert.equal((await runtime.command(sessionId, "get_tree")).data?.leafId, previousLeafId, "failed PI mirror write must restore the original OMP leaf");
    assert.deepEqual(withoutRpcDefaults((await runtime.command(sessionId, "get_messages")).data), withoutRpcDefaults(canonicalParentMessages));

    let synchronizedMessages = null;
    const moved = await runtime.navigateTreeAndSync({
      sessionId,
      entryId: firstAssistantEntry.id,
      replaceTranscript: async (_id, messages) => { synchronizedMessages = messages; },
    });
    assert.equal(moved.cancelled, false);
    assert.equal(moved.previousLeafId, previousLeafId);
    assert.deepEqual(synchronizedMessages, moved.messages, "successful native navigation must persist the exact PI mirror snapshot");
    const [afterTree, afterMessages] = await Promise.all([
      runtime.command(sessionId, "get_tree"),
      runtime.command(sessionId, "get_messages"),
    ]);
    assert.equal(afterTree.data?.leafId, firstAssistantEntry.id);
    assert.ok(Array.isArray(afterMessages.data?.messages));
    assert.ok(afterMessages.data.messages.length < beforeMessages.data.messages.length, "navigation must expose the shorter active branch snapshot");
    const activeTranscript = JSON.stringify(afterMessages.data.messages);
    assert.match(activeTranscript, /First user request/);
    assert.match(activeTranscript, /First isolated reply/);
    assert.doesNotMatch(activeTranscript, /Second user request|Second isolated reply/);

    const oldSecondPromptId = normalizeOmpTranscriptSnapshot(beforeMessages.data).messages.find((message) => message.content === "Second user request")?.id;
    assert.ok(oldSecondPromptId, "expected the old branch's second prompt snapshot id");
    let stalePromptPersisted = false;
    let staleMirrorReplacementCount = 0;
    await assert.rejects(runtime.promptFromMessage({
      sessionId,
      cwd: rootDir,
      messageId: oldSecondPromptId,
      message: "Stale edit must not be sent",
      replaceTranscript: async () => { staleMirrorReplacementCount += 1; },
      persistUserMessage: async () => { stalePromptPersisted = true; },
    }), (error) => error?.errorCode === "OMP_HISTORY_STALE");
    assert.equal(stalePromptPersisted, false, "stale UI actions must not append or send a prompt");
    assert.equal(staleMirrorReplacementCount, 0, "rejecting a stale action must not rewrite Host's richer transcript mirror");

    // Fork into a distinct PI identity, then restart both runtime processes.
    // The source must reopen the parent file while the child opens the OMP
    // fork file, proving that mappings survive a desktop restart.
    const parentState = await runtime.command(sessionId, "get_state");
    const parentSessionFile = await realpath(parentState.data?.sessionFile);
    assert.equal(typeof parentSessionFile, "string");

    // Inject failure exactly at the paired mapping commit after OMP has made
    // its native child file. Runtime compensation must restore the parent file
    // and leave no PI mapping/journal for the failed target.
    const failedTargetSessionId = "native-branch-navigation-failed-fork";
    const persistMappings = runtime.updateSessionMappings.bind(runtime);
    let injectedMappingFailure = false;
    runtime.updateSessionMappings = async (updates) => {
      if (!injectedMappingFailure && updates?.[failedTargetSessionId]) {
        injectedMappingFailure = true;
        throw new Error("injected paired OMP mapping commit failure");
      }
      return persistMappings(updates);
    };
    await assert.rejects(runtime.forkToSession({ sessionId, targetSessionId: failedTargetSessionId, cwd: rootDir, entryId: firstAssistantEntry.id }), /injected paired OMP mapping commit failure/);
    runtime.updateSessionMappings = persistMappings;
    assert.equal(injectedMappingFailure, true);
    assert.equal(await runtime.hasMappedSession(failedTargetSessionId), false);
    assert.equal(await runtime.pendingForkTranscriptSync(failedTargetSessionId), null);
    const restoredAfterInjectedFailure = await runtime.command(sessionId, "get_state");
    assert.equal(await realpath(restoredAfterInjectedFailure.data?.sessionFile), parentSessionFile);
    assert.deepEqual(withoutRpcDefaults((await runtime.command(sessionId, "get_messages")).data), withoutRpcDefaults(canonicalParentMessages));

    const targetSessionId = "native-branch-navigation-fork";
    let forked;
    try { forked = await runtime.forkToSession({ sessionId, targetSessionId, cwd: rootDir, entryId: firstAssistantEntry.id }); }
    catch (error) { assert.fail(error instanceof Error ? error.message : String(error)); }
    assert.match(JSON.stringify(forked.messages), /First user request/);
    assert.match(JSON.stringify(forked.messages), /First isolated reply/);
    const restoredState = await runtime.command(sessionId, "get_state");
    assert.equal(await realpath(restoredState.data?.sessionFile), parentSessionFile);
    const restoredMessages = await runtime.command(sessionId, "get_messages");
    assert.deepEqual(withoutRpcDefaults(restoredMessages.data), withoutRpcDefaults(canonicalParentMessages), "forking a historical entry must restore the complete native parent history");
    const childState = await runtime.command(targetSessionId, "get_state").catch(async () => {
      await runtime.connect({ sessionId: targetSessionId, cwd: rootDir });
      return runtime.command(targetSessionId, "get_state");
    });
    assert.notEqual(await realpath(childState.data?.sessionFile), parentSessionFile);
    const forkMessages = await runtime.command(targetSessionId, "get_messages");
    const forkTranscript = JSON.stringify(forkMessages.data?.messages ?? []);
    assert.match(forkTranscript, /First user request/);
    assert.match(forkTranscript, /First isolated reply/);
    assert.doesNotMatch(forkTranscript, /Second user request|Second isolated reply/);
    await runtime.stopAll();
    runtime = new OmpRpcRuntime({
      rootDir,
      manager: { getExecutablePath: async () => binary },
      emit: (event) => events.push(event),
      getCustomModelApiKeys: async () => ({ PI_OMP_BRANCH_TEST_KEY: "isolated-branch-key" }),
    });
    await runtime.connect({ sessionId, cwd: rootDir });
    await runtime.connect({ sessionId: targetSessionId, cwd: rootDir });
    const [parentAfterRestart, childAfterRestart] = await Promise.all([
      runtime.command(sessionId, "get_state"),
      runtime.command(targetSessionId, "get_state"),
    ]);
    assert.equal(await realpath(parentAfterRestart.data?.sessionFile), parentSessionFile);
    assert.equal(await realpath(childAfterRestart.data?.sessionFile), await realpath(childState.data?.sessionFile));
    const parentAfterRestartMessages = await runtime.command(sessionId, "get_messages");
    assert.deepEqual(withoutRpcDefaults(parentAfterRestartMessages.data), withoutRpcDefaults(canonicalParentMessages));
    assert.match(JSON.stringify(parentAfterRestartMessages.data), /Second user request|Second isolated reply/);
    assert.match(JSON.stringify((await runtime.command(targetSessionId, "get_messages")).data), /First isolated reply/);

  } finally {
    await runtime.stopAll();
    await new Promise((resolve) => apiServer.close(resolve));
    // Windows can keep SQLite/session handles busy briefly after the OMP child
    // exits; retry so integration results do not fail solely during cleanup.
    await removeTestDirectoryWithRetries(rootDir);
  }
});

test("native OMP historical edit creates a durable sibling in the same session", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to verify native edit branches across a restart."); return; }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-in-place-edit-"));
  const profileDir = join(rootDir, "runtime", "profile");
  await mkdir(profileDir, { recursive: true });
  const responses = ["First native reply", "Original version reply", "Edited version reply", "Duplicate prompt reply", "Image-only reply", "Edited image-only reply"];
  const apiRequestBodies = [];
  let responseIndex = 0;
  const apiServer = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      apiRequestBodies.push(Buffer.concat(chunks).toString("utf8"));
      const content = responses[Math.min(responseIndex++, responses.length - 1)];
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => apiServer.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = apiServer.address();
  assert.ok(address && typeof address === "object");
  await writeFile(join(profileDir, "models.json"), JSON.stringify({ providers: {
    pi_in_place_edit_test: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "PI_OMP_IN_PLACE_EDIT_KEY", authHeader: true,
      models: [{ id: "in-place-edit-model", name: "In-place edit model", contextWindow: 32000, maxTokens: 4096, input: ["text", "image"], reasoning: false }],
    },
  } }));
  const sessionId = "native-in-place-edit";
  const events = [];
  let runtime = new OmpRpcRuntime({
    rootDir,
    manager: { getExecutablePath: async () => binary },
    emit: (event) => events.push(event),
    getCustomModelApiKeys: async () => ({ PI_OMP_IN_PLACE_EDIT_KEY: "isolated-in-place-edit-key" }),
  });
  const settledCount = () => events.filter((event) => event.sessionId === sessionId && event.frame.type === "session_settled").length;
  const waitForSettlement = async (previousSettledCount) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (events.some((event) => event.sessionId === sessionId && event.frame.type === "runtime_error")) {
        assert.fail(`OMP runtime error: ${events.find((event) => event.sessionId === sessionId && event.frame.type === "runtime_error")?.frame.message}`);
      }
      const state = await runtime.command(sessionId, "get_state");
      if (settledCount() > previousSettledCount &&
        state.data?.isStreaming !== true && state.data?.isCompacting !== true && state.data?.hasPendingAsyncWork !== true) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`expected edited native session to settle; saw ${events.map((event) => event.frame.type).join(", ")}`);
  };
  try {
    await runtime.attach({ sessionId, cwd: rootDir }, { includeMessages: false });
    await runtime.command(sessionId, "set_model", { provider: "pi_in_place_edit_test", modelId: "in-place-edit-model" });
    let previousSettledCount = settledCount();
    await runtime.prompt({ sessionId, cwd: rootDir, message: "First user request" });
    await waitForSettlement(previousSettledCount);
    previousSettledCount = settledCount();
    const originalImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    const livePiMessageId = "a1c0f938-4147-4753-bbda-018d24cb5f11";
    await runtime.prompt({
      sessionId,
      cwd: rootDir,
      message: "Original version",
      messageId: livePiMessageId,
      images: [{ data: originalImage, mimeType: "image/png" }],
    });
    await waitForSettlement(previousSettledCount);

    const beforeTree = await runtime.command(sessionId, "get_tree");
    const entries = entriesInTree(beforeTree.data?.tree);
    const entryText = (entry) => (Array.isArray(entry?.message?.content)
      ? entry.message.content.flatMap((block) => typeof block?.text === "string" ? [block.text] : []).join("")
      : typeof entry?.message?.content === "string" ? entry.message.content : "");
    const originalUser = entries.find((entry) => entry.type === "message" && entry.message?.role === "user" && entryText(entry) === "Original version");
    const originalAssistant = entries.find((entry) => entry.type === "message" && entry.message?.role === "assistant" && entryText(entry) === "Original version reply");
    const parentId = originalUser?.parentId;
    assert.ok(originalUser?.id && typeof parentId === "string");
    assert.ok(originalAssistant?.id);
    const originalSnapshot = normalizeOmpTranscriptSnapshot(await runtime.command(sessionId, "get_messages").then((result) => result.data));
    assert.ok(originalSnapshot.ok);
    const originalPrompt = originalSnapshot.messages.find((message) => message.content === "Original version");
    assert.ok(originalPrompt?.id);
    let mirrorSnapshots = [];
    let ambiguousMirrorAttempts = 0;
    const ambiguousMirrorSnapshots = [];
    await assert.rejects(runtime.promptFromMessage({
      sessionId,
      cwd: rootDir,
      messageId: livePiMessageId,
      message: "Must not be sent after an ambiguous mirror write",
      replaceTranscript: async (_id, messages) => {
        ambiguousMirrorSnapshots.push(messages);
        ambiguousMirrorAttempts += 1;
        if (ambiguousMirrorAttempts === 1) throw new Error("injected lost Host mirror acknowledgement");
      },
      persistUserMessage: async () => assert.fail("the prompt must not be admitted when mirror replacement fails"),
    }), /injected lost Host mirror acknowledgement/);
    assert.equal((await runtime.command(sessionId, "get_tree")).data?.leafId, beforeTree.data?.leafId, "ambiguous PI mirror failure must restore the original OMP leaf");
    assert.ok(ambiguousMirrorSnapshots.length >= 2, "rollback must retry the mirror with OMP's restored canonical snapshot");
    assert.match(JSON.stringify(ambiguousMirrorSnapshots.at(-1)), /Original version reply/);
    assert.doesNotMatch(JSON.stringify(ambiguousMirrorSnapshots), /Must not be sent/);

    await assert.rejects(runtime.promptFromMessage({
      sessionId,
      cwd: rootDir,
      messageId: livePiMessageId,
      message: "Must not be sent when Host mirror admission fails",
      replaceTranscript: async (_id, messages) => { mirrorSnapshots.push(messages); },
      persistUserMessage: async () => { throw new Error("injected edited prompt persistence failure"); },
    }), /injected edited prompt persistence failure/);
    assert.equal((await runtime.command(sessionId, "get_tree")).data?.leafId, beforeTree.data?.leafId, "failed Host append must restore the original native leaf");
    assert.match(JSON.stringify((await runtime.command(sessionId, "get_messages")).data), /Original version reply/);
    assert.doesNotMatch(JSON.stringify((await runtime.command(sessionId, "get_messages")).data), /Must not be sent/);
    assert.ok(mirrorSnapshots.length >= 2, "rollback must restore the PI mirror after the branch snapshot was written");

    previousSettledCount = settledCount();
    const editedPiMessageId = "a7c5c5f7-f43a-45ab-99fb-1a230c7c1187";
    const submitted = await runtime.promptFromMessage({
      sessionId,
      cwd: rootDir,
      messageId: livePiMessageId,
      newMessageId: editedPiMessageId,
      message: "Edited version",
      images: [
        { data: originalImage, mimeType: "image/png" },
        { data: originalImage, mimeType: "image/png" },
      ],
      replaceTranscript: async (_id, messages) => { mirrorSnapshots.push(messages); },
      persistUserMessage: async () => {
        const branchMirror = mirrorSnapshots.at(-1);
        assert.doesNotMatch(JSON.stringify(branchMirror), /Original version/);
      },
    });
    assert.equal(submitted.accepted, true);
    await waitForSettlement(previousSettledCount);
    const editedRequest = JSON.parse(apiRequestBodies.at(-1) ?? "{}");
    const editedUserContent = editedRequest.messages?.filter((message) => message.role === "user").at(-1)?.content;
    assert.match(JSON.stringify(editedUserContent), /data:image\/(?:png|webp);base64,/, `editing without replacing attachments must keep an inline image; original native content: ${JSON.stringify(originalUser?.message?.content)}`);
    assert.doesNotMatch(JSON.stringify(editedUserContent), /image omitted:/, "the preserved image must remain decodable through OMP's native preparation path");

    previousSettledCount = settledCount();
    await runtime.prompt({
      sessionId,
      cwd: rootDir,
      message: "Original version",
      images: [{ data: originalImage, mimeType: "image/png" }],
    });
    await waitForSettlement(previousSettledCount);

    const apiRequestsBeforeStaleUuid = apiRequestBodies.length;
    let staleUuidPromptPersisted = false;
    let staleUuidMirrorReplacementCount = 0;
    let staleMappedError;
    await assert.rejects(runtime.promptFromMessage({
      sessionId,
      cwd: rootDir,
      messageId: livePiMessageId,
      message: "Stale UUID edit must not be sent",
      replaceTranscript: async () => { staleUuidMirrorReplacementCount += 1; },
      persistUserMessage: async () => { staleUuidPromptPersisted = true; },
    }), (error) => { staleMappedError = error; return error?.errorCode === "OMP_HISTORY_STALE"; });
    assert.match(staleMappedError.message, /当前活动分支/, "a known native mapping outside the active branch gets the branch-conflict explanation");
    assert.equal(staleUuidPromptPersisted, false, "a stale live UUID must not persist an optimistic prompt");
    assert.equal(apiRequestBodies.length, apiRequestsBeforeStaleUuid, "a stale live UUID must not issue a model request");
    assert.equal(staleUuidMirrorReplacementCount, 0, "a stale live UUID must not overwrite Host transcript ids or attachment metadata");

    let legacyUuidPromptPersisted = false;
    let legacyUuidMirrorReplacementCount = 0;
    await assert.rejects(runtime.promptFromMessage({
      sessionId,
      cwd: rootDir,
      messageId: "f4c2c989-cd71-4b5d-b72a-e1c74d7467f5",
      message: "Legacy unmapped edit must not be sent",
      replaceTranscript: async () => { legacyUuidMirrorReplacementCount += 1; },
      persistUserMessage: async () => { legacyUuidPromptPersisted = true; },
    }), (error) => error?.errorCode === "OMP_HISTORY_STALE" && /可靠关联到 OMP 原生历史/.test(error.message));
    assert.equal(legacyUuidPromptPersisted, false, "an unmapped legacy UUID must not persist a speculative edit");
    assert.equal(legacyUuidMirrorReplacementCount, 0, "an unmapped legacy UUID must not rewrite the transcript mirror");
    assert.equal(apiRequestBodies.length, apiRequestsBeforeStaleUuid, "an unmapped legacy UUID must not issue a model request");

    const afterTree = await runtime.command(sessionId, "get_tree");
    const afterEntries = entriesInTree(afterTree.data?.tree);
    const editedUser = afterEntries.find((entry) => entry.type === "message" && entry.message?.role === "user" && entryText(entry) === "Edited version");
    assert.ok(afterEntries.some((entry) => entry.id === originalUser.id), "the old user entry must remain in the native history tree");
    assert.ok(afterEntries.some((entry) => entry.id === originalAssistant.id), "the old assistant response must remain in the native history tree");
    assert.equal(editedUser?.parentId, parentId, "the edited prompt must become a sibling of the original prompt");
    assert.notEqual(editedUser?.id, originalUser.id);
    const activeMessages = await runtime.command(sessionId, "get_messages");
    assert.match(JSON.stringify(activeMessages.data), /Edited version|Edited version reply/);
    assert.doesNotMatch(JSON.stringify(activeMessages.data), /Original version reply/);

    previousSettledCount = settledCount();
    await runtime.prompt({ sessionId, cwd: rootDir, message: "", images: [{ data: originalImage, mimeType: "image/png" }] });
    await waitForSettlement(previousSettledCount);
    const imageOnlySnapshot = normalizeOmpTranscriptSnapshot((await runtime.command(sessionId, "get_messages")).data);
    assert.equal(imageOnlySnapshot.ok, true);
    const imageOnlyPrompt = imageOnlySnapshot.messages.find((message) => message.role === "user" && !message.content && message.inlineImages?.length);
    assert.ok(imageOnlyPrompt?.id, "expected a native image-only user prompt");
    const imageOnlyTree = await runtime.command(sessionId, "get_tree");
    const imageOnlyEntry = entriesInTree(imageOnlyTree.data?.tree).find((entry) =>
      entry.type === "message" && entry.message?.role === "user" && entryText(entry) === "" &&
      Array.isArray(entry.message?.content) && entry.message.content.some((block) => block?.type === "image"));
    const imageOnlyParentId = imageOnlyEntry?.parentId;
    assert.ok(imageOnlyEntry?.id && typeof imageOnlyParentId === "string");

    previousSettledCount = settledCount();
    const editedImageOnly = await runtime.promptFromMessage({
      sessionId,
      cwd: rootDir,
      messageId: imageOnlyPrompt.id,
      message: "",
      replaceTranscript: async () => {},
      persistUserMessage: async () => {},
    });
    assert.equal(editedImageOnly.accepted, true);
    await waitForSettlement(previousSettledCount);
    const imageOnlyEditRequest = JSON.parse(apiRequestBodies.at(-1) ?? "{}");
    const imageOnlyEditedContent = imageOnlyEditRequest.messages?.filter((message) => message.role === "user").at(-1)?.content;
    assert.match(JSON.stringify(imageOnlyEditedContent), /data:image\/(?:png|webp);base64,/);
    assert.doesNotMatch(JSON.stringify(imageOnlyEditedContent), /image omitted:/);
    const imageOnlyEditedTree = await runtime.command(sessionId, "get_tree");
    const afterImageEntries = entriesInTree(imageOnlyEditedTree.data?.tree);
    const editedImageEntry = afterImageEntries.find((entry) =>
      entry.type === "message" && entry.message?.role === "user" && entryText(entry) === "" &&
      Array.isArray(entry.message?.content) && entry.message.content.some((block) => block?.type === "image") &&
      entry.parentId === imageOnlyParentId && entry.id !== imageOnlyEntry.id);
    assert.ok(editedImageEntry?.id, "image-only edit must create a sibling under the same native parent");

    const nativeSessionFile = await realpath((await runtime.command(sessionId, "get_state")).data?.sessionFile);
    await runtime.stopAll();
    runtime = new OmpRpcRuntime({ rootDir, manager: { getExecutablePath: async () => binary }, emit: (event) => events.push(event) });
    await runtime.connect({ sessionId, cwd: rootDir });
    const [restartedTree, restartedMessages, restartedState] = await Promise.all([
      runtime.command(sessionId, "get_tree"),
      runtime.command(sessionId, "get_messages"),
      runtime.command(sessionId, "get_state"),
    ]);
    assert.equal(await realpath(restartedState.data?.sessionFile), nativeSessionFile, "same PI chat must reopen the same native OMP file");
    const restartedEntries = entriesInTree(restartedTree.data?.tree);
    assert.ok(restartedEntries.some((entry) => entry.id === originalUser.id), "restart must retain the original sibling");
    assert.ok(restartedEntries.some((entry) => entry.id === editedUser.id), "restart must retain the edited sibling");
    assert.ok(restartedEntries.some((entry) => entry.id === editedImageEntry.id), "restart must retain the image-only edit sibling");
    assert.match(JSON.stringify(restartedMessages.data), /Edited version/);
    assert.doesNotMatch(JSON.stringify(restartedMessages.data), /Original version reply/);

    previousSettledCount = settledCount();
    const editedAgainAfterRestart = await runtime.promptFromMessage({
      sessionId,
      cwd: rootDir,
      messageId: editedPiMessageId,
      newMessageId: "e93e3072-56f8-4e0b-bd9b-c71aa438af36",
      message: "Edited after runtime restart",
      replaceTranscript: async () => {},
      persistUserMessage: async () => {},
    });
    assert.equal(editedAgainAfterRestart.accepted, true, "stable Host-to-native identity mappings survive runtime restart");
    await waitForSettlement(previousSettledCount);
  } finally {
    await runtime.stopAll();
    await new Promise((resolve) => apiServer.close(resolve));
    await removeTestDirectoryWithRetries(rootDir);
  }
});

test("native OMP builtin slash output arrives through the documented command_output frame", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to verify native builtin slash output frames."); return; }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-command-output-"));
  const sessionId = "native-builtin-command-output";
  const events = [];
  const runtime = new OmpRpcRuntime({ rootDir, manager: { getExecutablePath: async () => binary }, emit: (event) => events.push(event) });
  try {
    await runtime.attach({ sessionId, cwd: rootDir }, { includeMessages: false });
    const catalog = await runtime.command(sessionId, "get_available_commands");
    const commandNames = (catalog.data?.commands ?? []).map((command) => command.name);
    const builtin = commandNames.find((name) => ["model", "settings", "new", "clear"].includes(name));
    assert.ok(builtin, `expected a safe native builtin command, got ${commandNames.join(", ")}`);
    await runtime.prompt({ sessionId, cwd: rootDir, message: `/${builtin}` });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !events.some((event) => event.frame.type === "command_output" || event.frame.type === "runtime_error")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const output = events.find((event) => event.frame.type === "command_output");
    assert.ok(output, `expected command_output, received ${events.map((event) => event.frame.type).join(", ")}`);
    assert.equal(typeof output.frame.text, "string");
    assert.ok(output.frame.text.length > 0);
  } finally { await runtime.stopAll(); await rm(rootDir, { recursive: true, force: true }); }
});

test("a restored OMP session can serve its first GUI command before any prompt or attach", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to validate command-first session restoration."); return; }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-command-first-"));
  const runtime = new OmpRpcRuntime({ rootDir, manager: { getExecutablePath: async () => binary }, emit() {} });
  try {
    const sessionId = "restored-session-without-prior-prompt";
    await runtime.connect({ sessionId, cwd: rootDir });
    const state = await runtime.command(sessionId, "get_state");
    assert.equal(state.success, true);
    assert.ok(state.data && typeof state.data === "object");
    const ipc = await read("../electron/main/ipc/register.ts");
    assert.match(ipc, /await ompRpcRuntime!\.connect\(context\);[\s\S]{0,180}ompRpcRuntime!\.command\(context\.sessionId, command/);
  } finally { await runtime.stopAll(); await rm(rootDir, { recursive: true, force: true }); }
});

test("native OMP RPC routes bounded project read/write/edit and URI requests through Host", async (t) => {
  const binary = process.env.PI_OMP_BINARY;
  if (!binary) { t.skip("Set PI_OMP_BINARY to validate native host-tool registration and callbacks."); return; }
  const OmpRpcRuntime = await loadOmpRpcRuntime();
  const rootDir = await mkdtemp(join(tmpdir(), "pi-omp-host-bridge-"));
  const profileDir = join(rootDir, "runtime", "profile");
  const workspace = join(rootDir, "workspace");
  await mkdir(profileDir, { recursive: true });
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "readme.txt"), "fixture contents\n");
  await writeFile(join(workspace, "src", "large.txt"), "x".repeat(256 * 1024 + 1));
  const hostCalls = [];
  const runtime = new OmpRpcRuntime({
    rootDir,
    manager: { getExecutablePath: async () => binary },
    emit: () => undefined,
    executeHostTool: async (input) => {
      hostCalls.push(input);
      const path = join(input.workspaceRoot, input.args.path);
      if (input.toolName === "Read") {
        const info = await import("node:fs/promises").then(({ stat }) => stat(path));
        if (info.size > 256 * 1024) return { ok: false, content: `workspace file exceeds 262144 bytes` };
        return { ok: true, content: await readFile(path, "utf8") };
      }
      if (input.toolName === "Write") {
        await writeFile(path, input.args.content, "utf8");
        return { ok: true, content: "written" };
      }
      const current = await readFile(path, "utf8");
      if (!current.includes(input.args.oldText)) return { ok: false, content: "exact text not found" };
      await writeFile(path, current.replace(input.args.oldText, input.args.newText), "utf8");
      return { ok: true, content: "edited" };
    },
  });
  const writes = [];
  try {
    await runtime.attach({ sessionId: "host-bridge-session", cwd: workspace, workspaceRoot: workspace }, { includeMessages: false });
    const tools = await runtime.command("host-bridge-session", "set_host_tools", { tools: [{
      name: "pi_read_workspace_file", label: "Read", description: "Read relative text files",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    }, {
      name: "pi_write_workspace_file", label: "Write", description: "Write relative text files",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    }, {
      name: "pi_edit_workspace_file", label: "Edit", description: "Edit exact text in relative files",
      parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"], additionalProperties: false },
    }] });
    assert.ok(tools.data?.toolNames?.includes("pi_read_workspace_file"));
    const schemes = await runtime.command("host-bridge-session", "set_host_uri_schemes", { schemes: [{ scheme: "pi-workspace", writable: true, immutable: false }] });
    assert.ok(schemes.data?.schemes?.includes("pi-workspace"));
    const session = runtime.sessions.get("host-bridge-session");
    assert.ok(session);
    runtime.write = (_session, frame) => writes.push(frame);
    await runtime.handleHostRequest(session, { type: "host_tool_call", id: "tool-1", toolName: "pi_read_workspace_file", arguments: { path: "src/readme.txt" } });
    assert.equal(writes.at(-1)?.type, "host_tool_result");
    assert.equal(writes.at(-1)?.result?.content?.[0]?.text, "fixture contents\n");
    await runtime.handleHostRequest(session, { type: "host_uri_request", id: "uri-1", operation: "read", url: "pi-workspace://src/readme.txt" });
    assert.equal(writes.at(-1)?.type, "host_uri_result");
    assert.equal(writes.at(-1)?.content, "fixture contents\n");
    await runtime.handleHostRequest(session, { type: "host_uri_request", id: "uri-write", operation: "write", url: "pi-workspace://src/readme.txt", content: "overwritten" });
    assert.equal(writes.at(-1)?.type, "host_uri_result");
    assert.equal(await readFile(join(workspace, "src", "readme.txt"), "utf8"), "overwritten");
    await runtime.handleHostRequest(session, { type: "host_tool_call", id: "edit-1", toolName: "pi_edit_workspace_file", arguments: { path: "src/readme.txt", oldText: "overwritten", newText: "edited" } });
    assert.equal(await readFile(join(workspace, "src", "readme.txt"), "utf8"), "edited");
    await runtime.handleHostRequest(session, { type: "host_tool_call", id: "escape", toolName: "pi_read_workspace_file", arguments: { path: "../profile/existing-profile-marker" } });
    assert.equal(writes.at(-1)?.isError, true);
    assert.deepEqual(hostCalls.map((call) => call.toolName), ["Read", "Read", "Write", "Edit"]);
    await runtime.handleHostRequest(session, { type: "host_tool_call", id: "large", toolName: "pi_read_workspace_file", arguments: { path: "src/large.txt" } });
    assert.equal(writes.at(-1)?.isError, true);
    assert.match(writes.at(-1)?.result?.content?.[0]?.text ?? "", /exceeds 262144 bytes/);
  } finally {
    await runtime.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("OMP history edits use persisted native message ids and reject PI transcript truncation", async () => {
  const ipc = await read("../electron/main/ipc/agent-ipc.ts");
  const runtime = await read("../electron/main/omp/rpc-runtime.ts");
  assert.match(ipc, /req\.ompNativeEdit\.messageId/);
  assert.match(ipc, /if \(ompNativeEditMessageId\) \{[\s\S]*?return ompRpcRuntime\.promptFromMessage/);
  assert.match(ipc, /messageAround:\s*ompNativeEditMessageId/);
  assert.match(ipc, /newMessageId:\s*userMessage\.id/);
  assert.match(runtime, /readNativeMessageEntryId\(input\.sessionId, messageId\)/);
  assert.match(runtime, /nativeEntryId:\s*mappedNativeEntryId/);
  assert.match(runtime, /findNewOmpNativeUserEntryId/);
  assert.doesNotMatch(ipc, /appendPromptFallbackPaths\(sourceContent,\s*preparedAttachments\)/);
  assert.match(ipc, /replaceTranscript: async \(sessionId, messages\) => \{[\s\S]*?session\.replaceMessages/);
  assert.match(ipc, /if \(!ompNativeEditMessageId\) \{[\s\S]*?persistUserMessage\(\)/);
  assert.match(runtime, /navigate_tree[\s\S]*?branchSnapshot\.messages[\s\S]*?persistUserMessage\(\)[\s\S]*?"prompt"/);
  assert.match(runtime, /originalLeafId[\s\S]*?OMP 原生分支叶节点未恢复/);
  assert.match(ipc, /OMP 会话只支持通过原生历史树编辑消息/);
  assert.match(ipc, /req\.truncateFromMessageId/);
});

test("OMP turn completion waits for native session settlement when async work remains", async () => {
  const adapter = await read("../electron/main/omp/rpc-event-adapter.ts");
  const register = await read("../electron/main/ipc/register.ts");
  assert.match(adapter, /frame\.sessionSettled === false \? null/);
  assert.match(adapter, /case "session_settled"/);
  assert.match(register, /event\.frame\.type === "session_settled"/);
});

test("OMP agent_end terminal flags never settle the PI turn before session_settled", async () => {
  const { ompFrameToAgentEvent } = await loadOmpEventAdapter();
  for (const frame of [
    { type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true },
    { type: "agent_end", isTerminal: true, yielded: false, awaitingAsyncWork: false },
  ]) {
    assert.equal(ompFrameToAgentEvent({ sessionId: "pi-session", runId: "run-omp", frame, messageIds: new Set() }), null);
  }
  const settled = ompFrameToAgentEvent({ sessionId: "pi-session", runId: "run-omp", frame: { type: "session_settled" }, messageIds: new Set() });
  assert.deepEqual(settled.event, { type: "agent_end", messageIds: [] });
});

test("OMP event adapter namespaces process-local message IDs and waits for settlement", async () => {
  const { ompFrameToAgentEvent } = await loadOmpEventAdapter();
  const ids = new Set();
  const message = ompFrameToAgentEvent({
    sessionId: "pi-session",
    runId: "omp-run-unique",
    frame: { type: "message_end", messageId: "message-1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    messageIds: ids,
  });
  assert.equal(message.event.message.id, "omp:omp-run-unique:message-1");
  assert.equal(ompFrameToAgentEvent({ sessionId: "pi-session", runId: "omp-run-unique", frame: { type: "prompt_result", status: "completed", sessionSettled: false }, messageIds: ids }), null);
  const settled = ompFrameToAgentEvent({ sessionId: "pi-session", runId: "omp-run-unique", frame: { type: "session_settled" }, messageIds: ids });
  assert.deepEqual(settled.event, { type: "agent_end", messageIds: ["omp:omp-run-unique:message-1"] });
  assert.deepEqual(ompFrameToAgentEvent({ sessionId: "pi-session", runId: "omp-run-unique", frame: { type: "turn_start" }, messageIds: ids }).event, { type: "turn_start" });
  assert.deepEqual(ompFrameToAgentEvent({ sessionId: "pi-session", runId: "omp-run-unique", frame: { type: "turn_end" }, messageIds: ids }).event, { type: "turn_end" });
  assert.deepEqual(ompFrameToAgentEvent({ sessionId: "pi-session", runId: "omp-run-unique", frame: { type: "tool_stream_update", toolCallId: "shell-1", toolName: "bash", update: { text: "partial output" } }, messageIds: ids }).event, { type: "tool_update", toolCallId: "shell-1", partialResult: { text: "partial output" } });
});

test("OMP tool calls carry explicit engine provenance so task rows cannot route to PI delegation transcripts", async () => {
  const { ompFrameToAgentEvent } = await loadOmpEventAdapter();
  const event = ompFrameToAgentEvent({
    sessionId: "pi-session", runId: "run-omp", frame: { type: "tool_execution_start", toolCallId: "batch-15", toolName: "Task", args: { tasks: Array.from({ length: 15 }, (_, index) => ({ name: `agent-${index + 1}` })) } }, messageIds: new Set(),
  });
  assert.deepEqual(event.event, { type: "tool_start", toolCallId: "batch-15", toolName: "Task", args: { tasks: Array.from({ length: 15 }, (_, index) => ({ name: `agent-${index + 1}` })) }, engineOrigin: "omp" });
  const row = await read("../src/features/chat/transcript/ToolRow.tsx");
  assert.match(row, /message\.engineOrigin === "omp"[\s\S]*?openOmpSubagentBatchTab\(message\.toolCallId \|\| message\.id\)/);
  assert.match(row, /omp-batch-child-agents[\s\S]*?openOmpSubagentBatchTab\(ompBatchToolCallId, String\(agent\.id\), label\)/);
  assert.match(row, /ompBatchSummary/);
  assert.doesNotMatch(row, /if \(ompBatch\) openSubagentTab/);
  const pane = await read("../src/components/workpanel/OmpSubagentBatchTab.tsx");
  assert.match(pane, /command: "get_subagents"/);
  assert.match(pane, /agentsForOmpToolCall\(agents, toolCallId\)/);
  assert.match(pane, /command: "get_subagent_messages"/);
  assert.match(pane, /RequestedTasksNotConfirmed|requestedTasksNotConfirmed/);
  assert.match(pane, /selectedAgentId/);
  const activity = await read("../src/features/chat/transcript/ActivityGroup.tsx");
  assert.match(activity, /summarizeOmpBatchRoster/);
});

test("OMP batch roster separates requested task count from observed agents and retains agents that leave the running-only snapshot", async () => {
  const source = await read("../src/components/omp-subagent-roster.mjs");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { mergeOmpSubagentRoster, agentsForOmpToolCall, isOmpTaskBatch, recordOmpSubagentRoster, recordOmpSubagentTranscriptOutcome, applyOmpSubagentFrame, getOmpSubagentRoster, summarizeOmpBatchRoster } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  assert.equal(isOmpTaskBatch(undefined, "Task", { tasks: [{ name: "legacy-batch" }] }), true);
  assert.equal(isOmpTaskBatch(undefined, "Task", { prompt: "single PI delegate" }), false);
  assert.equal(isOmpTaskBatch("omp", "Task", {}), true);
  const launched = Array.from({ length: 15 }, (_, index) => ({ id: `agent-${index + 1}`, parentToolCallId: "batch-1", status: "running" }));
  const observed = mergeOmpSubagentRoster([], launched);
  assert.equal(agentsForOmpToolCall(observed, "batch-1").agents.length, 15);
  const restoredArchive = mergeOmpSubagentRoster([], [{ id: "agent-archived", parentToolCallId: "batch-1", status: "completed", lastKnownStatus: "completed", observedActive: false }]);
  assert.equal(restoredArchive[0].observedActive, false, "archive rehydration must not relabel completed children as live");
  const unlinkedRoster = launched.map(({ parentToolCallId: _ignored, ...agent }) => agent);
  assert.deepEqual(agentsForOmpToolCall(unlinkedRoster, "batch-1"), { agents: unlinkedRoster, correlated: false });
  const stillRunning = mergeOmpSubagentRoster(observed, launched.slice(2));
  assert.equal(agentsForOmpToolCall(stillRunning, "batch-1").agents.length, 15);
  assert.equal(stillRunning.filter((agent) => agent.observedActive === false).length, 2);
  assert.deepEqual(agentsForOmpToolCall([{ id: "unlinked" }], "batch-1"), { agents: [{ id: "unlinked" }], correlated: false });
  recordOmpSubagentRoster("session-a", launched);
  applyOmpSubagentFrame("session-a", { type: "subagent_lifecycle", payload: { id: "agent-1", parentToolCallId: "batch-1", status: "completed" } });
  const retained = getOmpSubagentRoster("session-a");
  assert.equal(retained.length, 15);
  assert.equal(retained.find((agent) => agent.id === "agent-1").observedActive, false);
  assert.equal(retained.find((agent) => agent.id === "agent-1").status, "completed");
  recordOmpSubagentRoster("session-a", launched.slice(2));
  assert.deepEqual(recordOmpSubagentTranscriptOutcome("session-a", "agent-2", "completed").find((agent) => agent.id === "agent-2"), { id: "agent-2", parentToolCallId: "batch-1", status: "running", observedActive: false, lastKnownStatus: "running", transcriptOutcome: "completed" });
  recordOmpSubagentRoster("session-a", launched.slice(3));
  assert.equal(recordOmpSubagentTranscriptOutcome("session-a", "agent-3", "failed").find((agent) => agent.id === "agent-3").transcriptOutcome, "failed");
  recordOmpSubagentRoster("session-a", launched.slice(3));
  recordOmpSubagentRoster("session-a", [launched[3]]);
  assert.equal(recordOmpSubagentTranscriptOutcome("session-a", "agent-4", "completed").find((agent) => agent.id === "agent-4").transcriptOutcome, undefined, "never infer completion while the native running roster still includes the agent");
  applyOmpSubagentFrame("session-nested", { type: "subagent_progress", payload: { progress: { id: "agent-nested", parent_tool_call_id: "batch-nested", status: "running", message: "Reading" } } });
  const nested = getOmpSubagentRoster("session-nested");
  assert.equal(nested[0].status, "running", "a first progress frame is enough to recover a missing roster item");
  assert.equal(agentsForOmpToolCall(nested, "batch-nested").agents[0].id, "agent-nested", "nested parent-call ids remain correlated to the correct Task card");
  const summary = summarizeOmpBatchRoster(retained, ["batch-1"]);
  assert.equal(summary.total, 15);
  assert.equal(summary.running, 14);
  assert.equal(summary.finished, 1);
});

test("OMP native IPC snapshots child transcripts durably and rehydrates archived rows for old conversations", async () => {
  const ipc = await read("../electron/main/ipc/register.ts");
  const archive = await read("../electron/main/omp/subagent-archive.mjs");
  assert.match(ipc, /new OmpSubagentArchive\(join\(dataDir, "managed-engines", "oh-my-pi"\)\)/);
  assert.match(ipc, /frameType\.startsWith\("subagent_"\)[\s\S]*?ompSubagentArchive\.upsertAgent/);
  assert.match(ipc, /captureOmpSubagents[\s\S]*?get_subagents[\s\S]*?get_subagent_messages/);
  assert.match(ipc, /command === "get_subagents"[\s\S]*?ompSubagentArchive\.mergeRoster/);
  assert.match(ipc, /command === "get_subagent_messages"[\s\S]*?ompSubagentArchive\.getTranscript[\s\S]*?archived: true/);
  assert.match(archive, /randomUUID/);
  assert.match(archive, /MAX_TRANSCRIPT_BYTES/);
  assert.match(archive, /sha256/);
});

test("OMP native command output is persisted as readable transcript text without terminal controls", async () => {
  const { ompFrameToAgentEvent } = await loadOmpEventAdapter();
  const ids = new Set(["omp:run-a:message-1"]);
  const output = ompFrameToAgentEvent({
    sessionId: "pi-session",
    runId: "run-a",
    frame: { type: "command_output", text: "\u001b[32mProvider status\u001b[0m\r\n\u001b]8;;https://example.test\u0007open link\u001b]8;;\u0007\u0007" },
    messageIds: ids,
  });
  assert.equal(output.event.type, "message_end");
  assert.equal(output.event.message.role, "assistant");
  assert.equal(output.event.message.content, "Provider status\r\nopen link");
  assert.equal(output.event.message.status, "complete");
  assert.equal(output.event.message.id, "omp:run-a:command-output:2");
  assert.ok(ids.has(output.event.message.id));

  const isolatedIds = new Set();
  const sameOutputFromAnotherProcess = ompFrameToAgentEvent({
    sessionId: "pi-session", runId: "run-b", frame: { type: "command_output", text: "result" }, messageIds: isolatedIds,
  });
  assert.equal(sameOutputFromAnotherProcess.event.message.id, "omp:run-b:command-output:1");
  assert.equal(ompFrameToAgentEvent({ sessionId: "pi-session", runId: "run-a", frame: { type: "command_output", text: "\u001b[31m\u0007\u001b]8;;\u0007" }, messageIds: ids }), null);
});

test("RPC UI confirmation does not race a deferred React state update", async () => {
  const interaction = await read("../src/components/OmpRpcInteraction.tsx");
  const styles = await read("../src/styles/composer-menus.css");
  assert.match(interaction, /answer\(method === "confirm" \? true : undefined, isRiskAcknowledgement \? "yes" : undefined\)/);
  assert.match(interaction, /confirmed: confirmation \?\? value === "yes"/);
});

test("OMP extension dialogs remain dismissible while RPC is busy or after process failure", async () => {
  const interaction = await read("../src/components/OmpRpcInteraction.tsx");
  assert.match(interaction, /frame\.type === "process_exit" \|\| frame\.type === "runtime_error"[\s\S]*?clearRequests\(\)/);
  assert.match(interaction, /Close locally first[\s\S]*?dropRequest\(requestId\)[\s\S]*?respondOmpRpcUi/);
  assert.match(interaction, /aria-label=\{t\("common\.cancel"\)\}[^>]*onClick=\{\(\) => void dismiss\(\)\}/);
  assert.doesNotMatch(interaction, /Button type="button" variant="secondary" disabled=\{busy\} onClick=\{\(\) => void dismiss\(\)\}/);
});

test("OMP transport overflow, extension and native warning notices are visible in the GUI", async () => {
  const interaction = await read("../src/components/OmpRpcInteraction.tsx");
  const en = await read("../../../packages/i18n/src/locales/en/index.ts");
  const zh = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");
  assert.match(interaction, /frame\.type === "rpc_frame_error"[\s\S]*?rpcFrameError/);
  assert.match(interaction, /frame\.type === "extension_error"[\s\S]*?extensionError/);
  assert.match(interaction, /frame\.type === "notice"[\s\S]*?nativeNotice/);
  for (const key of ["rpcFrameError", "extensionError", "nativeNotice"]) {
    assert.match(en, new RegExp(`${key}:`));
    assert.match(zh, new RegExp(`${key}:`));
  }
  assert.match(interaction, /auto_compaction_start[\s\S]*?chat\.compactingContext/);
  assert.match(interaction, /auto_retry_start[\s\S]*?chat\.retryingModel/);
  assert.match(interaction, /frame\.success === false && typeof frame\.finalError === "string"/);
});

test("OMP model selection supports provider/model search and explains native RPC prompts", async () => {
  const picker = await read("../src/features/chat/composer/ComposerOmpModelPicker.tsx");
  const interaction = await read("../src/components/OmpRpcInteraction.tsx");
  assert.match(picker, /candidate\.provider.*candidate\.id/);
  assert.match(picker, /modelSearchPlaceholder/);
  assert.match(picker, /noModelsMatch/);
  assert.match(picker, /<label className="composer-model-search">/);
  // The picker mirrors the native two-pane menu: a source rail plus a pane.
  assert.match(picker, /composer-model-rail/);
  assert.match(picker, /composer-model-body/);
  assert.match(picker, /if \(open\) loadPromiseRef\.current = load\(\);/);
  assert.match(picker, /getOmpHiddenModels/);
  assert.match(picker, /setSettingsTab\("agentEngines"\)/);
  assert.doesNotMatch(picker, /get_login_providers|const login = async/);
  assert.match(interaction, /interactiveRequestHint/);
  assert.match(interaction, /targetHost\(url\)/);
  assert.match(interaction, /openLinkHint/);
  assert.match(interaction, /openLinkInBrowser/);
  assert.doesNotMatch(interaction, /openAuthorization|authorizationLinkHint/);
});

test("OMP settings provide centralized provider login, account logout and persistent model visibility", async () => {
  const settings = await read("../src/components/settings/OmpProviderManager.tsx");
  const page = await read("../src/features/settings/SettingsPage.tsx");
  const visibility = await read("../electron/main/omp/model-visibility.ts");
  assert.match(page, /<OmpProviderManager \/>/);
  assert.match(settings, /get_login_providers/);
  assert.match(settings, /command: "login"/);
  assert.match(settings, /command: "get_logout_accounts"/);
  assert.match(settings, /command: "logout"/);
  assert.match(settings, /getOmpHiddenModels/);
  assert.match(settings, /setOmpHiddenModels/);
  assert.match(settings, /type="checkbox" checked=\{shown\}/);
  assert.match(visibility, /pi-visible-models\.json/);
});

test("OMP OAuth code prompts explain the browser callback and resume the login flow", async () => {
  const providerSettings = await read("../src/components/settings/OmpProviderManager.tsx");
  const interaction = await read("../src/components/OmpRpcInteraction.tsx");
  const styles = await read("../src/styles/composer-menus.css");
  const runtime = await read("../electron/main/omp/rpc-runtime.ts");
  assert.match(providerSettings, /const login = async[\s\S]*?command: "login"[\s\S]*?providerId: provider\.id[\s\S]*?await refresh\(\)/);
  assert.match(providerSettings, /providerLoginSuccess|providerLoginFailed/);
  assert.match(interaction, /isAuthorizationCodePrompt/);
  assert.match(interaction, /loginCodeTitle/);
  assert.match(interaction, /loginCodeHint/);
  assert.match(interaction, /loginCodePlaceholder/);
  assert.match(interaction, /submitLoginCode/);
  assert.match(interaction, /loginCancelled/);
  assert.match(interaction, /frame\.type === "auth_url"/);
  assert.match(interaction, /openAuthLink/);
  assert.match(interaction, /event\.key === "Escape"/);
  assert.match(interaction, /event\.target === event\.currentTarget/);
  assert.match(interaction, /requestIds\.map\(\(id\)/);
  assert.match(styles, /\.omp-rpc-overlay\s*\{[^}]*z-index: 1000/);
  assert.match(styles, /\.omp-rpc-dialog\s*\{[^}]*background: var\(--ds-raised\)/);
  assert.match(runtime, /const LOGIN_TIMEOUT_MS = 6 \* 60_000/);
  assert.match(runtime, /type === "login" \? LOGIN_TIMEOUT_MS : type === "dictation_start" \|\| type === "dictation_stop" \? NATIVE_AUDIO_TIMEOUT_MS/);
  assert.match(runtime, /type === "login"\) this\.emitLoginFailure\(session, cause\)/);
  assert.match(interaction, /frame\.type === "login_failed"[\s\S]*?clearRequests\(\)[\s\S]*?setAuthLink\(null\)/);
});

test("OMP 18.22.1 login risk acknowledgement is isolated to provider settings and cannot be silently accepted", async () => {
  const providerSettings = await read("../src/components/settings/OmpProviderManager.tsx");
  const chatSurface = await read("../src/components/ChatSurface.tsx");
  const interaction = await read("../src/components/OmpRpcInteraction.tsx");
  const styles = await read("../src/styles/composer-menus.css");
  const helper = await read("../src/lib/omp-rpc-prompts.mjs");
  const en = await read("../../../packages/i18n/src/locales/en/index.ts");
  const zh = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");
  assert.match(providerSettings, /context="provider-management"/);
  assert.match(providerSettings, /setAuthPromptReset\(\(value\) => value \+ 1\)[\s\S]*?command: "login"/);
  assert.match(chatSurface, /<OmpRpcInteraction sessionId=\{activeSessionId\} \/>/);
  assert.match(helper, /placeholder\.trim\(\)\.toLocaleLowerCase\(\) === "yes"/);
  assert.match(helper, /at your own risk|risk\.\{0,40\}/);
  assert.match(interaction, /context === "provider-management" && isOmpPreAuthRiskAcknowledgementPrompt/);
  assert.match(interaction, /authorizationUrlSeen\.current = true/);
  assert.match(interaction, /createOmpRiskAcknowledgementResponse\(request\.id\)/);
  assert.match(interaction, /createOmpRiskAcknowledgementCancellationResponse\(id\)/);
  assert.match(interaction, /loginRiskWarningFallback/);
  assert.match(interaction, /isRiskAcknowledgement \? "yes" : undefined/);
  assert.match(interaction, /loginRiskAccept/);
  assert.match(interaction, /loginRiskDecline/);
  assert.match(interaction, /loginRiskTitle/);
  assert.match(interaction, /loginRiskHint/);
  assert.match(styles, /\.omp-rpc-risk-warning\s*\{[^}]*var\(--ds-warning\)/);
  for (const key of ["loginRiskTitle", "loginRiskHint", "loginRiskWarningFallback", "loginRiskAccept", "loginRiskDecline"]) {
    assert.match(en, new RegExp(`${key}:`));
    assert.match(zh, new RegExp(`${key}:`));
  }
});

test("OMP native voice, dictation and slash command surfaces are exposed without PI runtime fallback", async () => {
  const ipc = await read("../electron/main/ipc/register.ts");
  const runtime = await read("../electron/main/omp/rpc-runtime.ts");
  const controls = await read("../src/components/OmpNativeControls.tsx");
  const toolbar = await read("../src/features/chat/composer/ComposerToolbar.tsx");
  const draft = await read("../src/features/chat/composer/hooks/useComposerDraft.ts");
  assert.match(ipc, /"live_start", "live_connect", "live_stop", "live_mute", "dictation_start", "dictation_stop"/);
  assert.match(ipc, /"get_subagents", "get_subagent_messages", "cancel_subagent", "steer_subagent"/);
  assert.match(runtime, /type === "dictation_start" \|\| type === "dictation_stop" \? NATIVE_AUDIO_TIMEOUT_MS/);
  assert.match(controls, /get_available_commands/);
  assert.match(controls, /available_commands_update/);
  assert.match(controls, /live_start/);
  assert.match(controls, /live_connect/);
  assert.match(controls, /acquireOmpMicrophone/);
  assert.match(controls, /releaseOmpMicrophone/);
  assert.match(controls, /createDataChannel\("oai-events"\)/);
  assert.match(controls, /track\.enabled = !next/);
  assert.match(controls, /dictation_start/);
  assert.match(controls, /live_levels/);
  assert.match(controls, /setLevels\(\{ input: Number\(frame\.input\)/);
  assert.match(controls, /get_btw_history/);
  assert.match(controls, /btw_cancel/);
  assert.match(controls, /recordId: btwFollowupRecordId/);
  assert.match(controls, /get_subagents/);
  assert.match(controls, /get_subagent_messages/);
  assert.match(controls, /fields: \{ subagentId: agentId, fromByte \}/);
  assert.match(controls, /steer_subagent/);
  assert.match(controls, /cancel_subagent/);
  assert.match(controls, /composerPrefill: \{ sessionId, text, fileReferences: \[\], append: true \}/);
  assert.match(toolbar, /<OmpNativeControls sessionId=\{activeSessionId \?\? null\}/);
  assert.match(draft, /applyComposerPrefillText\(current, prefilled\.text, composerPrefill\.append\)/);
});

test("OMP model and thinking notifications refresh the picker from native state", async () => {
  const picker = await read("../src/features/chat/composer/ComposerOmpModelPicker.tsx");
  assert.match(picker, /event\.frame\.type !== "model_changed" && event\.frame\.type !== "thinking_level_changed" && event\.frame\.type !== "config_update"/);
  assert.match(picker, /command: "get_state"/);
  assert.match(picker, /const modelChanged =/);
  assert.match(picker, /readOmpThinkingLevels\(/);
  assert.match(picker, /useAppStore\.getState\(\)\.activeSessionId !== sessionId/);
  assert.match(picker, /patchCache\(\{[\s\S]*?thinkingLevel:[\s\S]*?slowModeSupported:/);
});

test("OMP todo auto-clear refreshes the canonical goal and todo snapshot", async () => {
  const controls = await read("../src/components/OmpNativeControls.tsx");
  assert.match(controls, /frame\.type === "todo_auto_clear"[\s\S]*?command: "get_state"/);
  assert.match(controls, /if \(!active \|\| useAppStore\.getState\(\)\.activeSessionId !== sessionId\) return/);
  assert.match(controls, /const phases = Array\.isArray\(state\.todoPhases\) \? state\.todoPhases : \[\];[\s\S]*?setOmpTodos\(phases\);[\s\S]*?setTodoHistoryLoaded\(phases\.length === 0\)/);
});

test("OMP builtin title updates persist to the matching PI conversation", async () => {
  const controls = await read("../src/components/OmpNativeControls.tsx");
  assert.match(controls, /frame\.type === "session_info_update" && typeof frame\.title === "string"/);
  assert.match(controls, /state\.activeSessionId === sessionId/);
  assert.match(controls, /state\.renameSession\(sessionId, frame\.title\.trim\(\)\)/);
});

test("native OMP public commands are session-scoped and dictation appends instead of overwriting draft text", async () => {
  const ipc = await read("../electron/main/ipc/register.ts");
  const draftSource = await read("../src/lib/composer-smart-stop.ts");
  const javascript = ts.transpileModule(draftSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { applyComposerPrefillText } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  assert.match(ipc, /const ompSessionContext = async/);
  assert.match(ipc, /if \(!allowedCommands\.has\(command\)\)/);
  assert.equal(applyComposerPrefillText("existing draft", "recognized words", true), "existing draft\nrecognized words");
  assert.equal(applyComposerPrefillText("existing draft", "replacement", false), "replacement");
  assert.equal(applyComposerPrefillText("", "recognized words", true), "recognized words");
});
