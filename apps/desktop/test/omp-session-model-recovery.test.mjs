import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  buildModelUnavailableError,
  catalogProviders,
  classifyOmpFailure,
  extractRestoreModelFailure,
  isRestoreModelFailure,
  parseModelReference,
  restoreMappedSessionFile,
  selectModelCandidates,
  switchSessionWithModelFallback,
} = await import("../electron/main/omp/session-model-recovery.ts");

const { readOmpModelRecovery } = await import("../src/lib/omp-model-recovery.ts");
const { ompFrameToAgentEvent } = await import("../electron/main/omp/rpc-event-adapter.ts");

const catalog = {
  models: [
    { provider: "workbuddy", id: "hy4flash-free", name: "Hy4 Flash Free" },
    { provider: "workbuddy", id: "hy4flash-pro", name: "Hy4 Flash Pro" },
    { provider: "workbuddy", id: "hy4flash-free", name: "Duplicate" },
    { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
  ],
};

test("model references split on a known provider before falling back to the first slash", () => {
  assert.deepEqual(parseModelReference("workbuddy/hy4free"), {
    provider: "workbuddy",
    modelId: "hy4free",
  });
  assert.deepEqual(parseModelReference("openrouter/anthropic/claude-3.7", ["workbuddy", "openrouter"]), {
    provider: "openrouter",
    modelId: "anthropic/claude-3.7",
  });
  assert.deepEqual(parseModelReference("openrouter/anthropic/claude-3.7"), {
    provider: "openrouter",
    modelId: "anthropic/claude-3.7",
  });
  assert.equal(parseModelReference(""), null);
  assert.equal(parseModelReference("no-slash"), null);
  assert.equal(parseModelReference("provider/"), null);
});

test("restore failures are recognized with and without surrounding quotes", () => {
  assert.equal(isRestoreModelFailure("Could not restore model workbuddy/hy4free"), true);
  assert.equal(isRestoreModelFailure("Model not found: workbuddy/hy4free"), true);
  assert.equal(isRestoreModelFailure("network timeout"), false);
  assert.deepEqual(extractRestoreModelFailure('Could not restore model "workbuddy/hy4free"'), {
    provider: "workbuddy",
    modelId: "hy4free",
  });
  assert.deepEqual(
    extractRestoreModelFailure("Could not restore model openrouter/anthropic/claude-3.7", ["openrouter"]),
    { provider: "openrouter", modelId: "anthropic/claude-3.7" },
  );
});

test("candidates stay inside the failed provider and are deduplicated", () => {
  assert.deepEqual(selectModelCandidates(catalog, "workbuddy"), [
    { provider: "workbuddy", id: "hy4flash-free", name: "Hy4 Flash Free" },
    { provider: "workbuddy", id: "hy4flash-pro", name: "Hy4 Flash Pro" },
  ]);
  assert.deepEqual(selectModelCandidates(catalog, "missing"), []);
  assert.equal(selectModelCandidates(catalog, "workbuddy", 1).length, 1);
  assert.deepEqual(catalogProviders(catalog), ["workbuddy", "openai"]);
  assert.deepEqual(catalogProviders(null), []);
});

test("only transport failures are retriable; permission and auth errors are not", () => {
  assert.deepEqual(classifyOmpFailure("403 Forbidden: account restricted"), {
    code: "ACCOUNT_RESTRICTED",
    retriable: false,
  });
  assert.equal(classifyOmpFailure("401 Unauthorized: invalid api key").code, "AUTH_FAILED");
  assert.deepEqual(classifyOmpFailure("socket hang up"), {
    code: "OMP_RUNTIME_ERROR",
    retriable: true,
  });
  assert.deepEqual(classifyOmpFailure("HTTP 503 Service Unavailable"), {
    code: "OMP_RUNTIME_ERROR",
    retriable: true,
  });
  assert.deepEqual(classifyOmpFailure("something odd"), {
    code: "OMP_RUNTIME_ERROR",
    retriable: false,
  });
  assert.deepEqual(classifyOmpFailure("something odd", "PROVIDER_ERROR", true), {
    code: "PROVIDER_ERROR",
    retriable: true,
  });
  // Text that merely asks the user to try again is not transport evidence.
  assert.deepEqual(classifyOmpFailure("quota shared, please try again later", undefined, false), {
    code: "OMP_RUNTIME_ERROR",
    retriable: false,
  });
  // OMP reports the provider status separately; it outranks the message text.
  assert.deepEqual(classifyOmpFailure("upstream refused", undefined, true, 403), {
    code: "ACCOUNT_RESTRICTED",
    retriable: false,
  });
  assert.deepEqual(classifyOmpFailure("upstream refused", undefined, true, 401), {
    code: "AUTH_FAILED",
    retriable: false,
  });
  assert.deepEqual(classifyOmpFailure("upstream refused", undefined, false, 502), {
    code: "OMP_RUNTIME_ERROR",
    retriable: true,
  });
  assert.equal(classifyOmpFailure("Could not restore model workbuddy/hy4free").code, "MODEL_UNAVAILABLE");
  assert.equal(classifyOmpFailure("unknown provider: ghost").code, "PROVIDER_UNAVAILABLE");
});

test("the structured recovery error carries the original model and candidates", () => {
  const error = buildModelUnavailableError(
    { provider: "workbuddy", modelId: "hy4free" },
    selectModelCandidates(catalog, "workbuddy"),
  );
  assert.equal(error.errorCode, "MODEL_UNAVAILABLE");
  assert.equal(error.data.provider, "workbuddy");
  assert.equal(error.data.modelId, "hy4free");
  assert.equal(error.data.retriable, false);
  assert.equal(error.data.candidates.length, 2);
});

test("the explicit model reaches both session-opening commands", async () => {
  // `switch_session` restores the mapped file's saved model just like
  // `open_session`; passing the pair to only one of them leaves forked
  // conversations stuck on the rename (documented in .omp-source-audit rpc.md).
  const source = await readFile(
    new URL("../electron/main/omp/rpc-runtime.ts", import.meta.url),
    "utf8",
  );
  const passPair = source.match(/provider: explicitModel\.provider, modelId: explicitModel\.modelId/g) ?? [];
  assert.equal(passPair.length, 2);
  assert.match(source, /"open_session", \{/);
  assert.match(source, /"switch_session", \{\s*sessionPath: mappedSessionFile,\s*\.\.\.\(explicitModel \?/);
  // Fork rollback goes through the fallback helper, so a renamed saved model
  // cannot block it and a healthy session never rewrites its saved model.
  assert.match(source, /restoreMappedSessionFile\(/);
  assert.match(source, /restoreMappedSession\(sourceId, originalFile, liveModel\)/);
  assert.doesNotMatch(source, /restoreMappedParent\(/);
});

test("switching back only writes an explicit model when the saved one is gone", async () => {
  const calls = [];
  const ok = await switchSessionWithModelFallback(async (fields) => {
    calls.push(fields);
    return { data: { cancelled: false } };
  }, "parent.jsonl", { provider: "workbuddy", modelId: "hy4flash-free" });
  assert.deepEqual(calls, [{ sessionPath: "parent.jsonl" }]);
  assert.deepEqual(ok, { data: { cancelled: false } });

  const retryCalls = [];
  const retried = await switchSessionWithModelFallback(async (fields) => {
    retryCalls.push(fields);
    if (retryCalls.length === 1) throw new Error("Could not restore model workbuddy/hy4free");
    return { data: { cancelled: false } };
  }, "parent.jsonl", { provider: "workbuddy", modelId: "hy4flash-free" });
  assert.deepEqual(retryCalls, [
    { sessionPath: "parent.jsonl" },
    { sessionPath: "parent.jsonl", provider: "workbuddy", modelId: "hy4flash-free" },
  ]);
  assert.deepEqual(retried, { data: { cancelled: false } });

  const otherCalls = [];
  await assert.rejects(
    () => switchSessionWithModelFallback(async (fields) => {
      otherCalls.push(fields);
      throw new Error("session is busy");
    }, "parent.jsonl", { provider: "workbuddy", modelId: "hy4flash-free" }),
    /session is busy/,
  );
  assert.deepEqual(otherCalls, [{ sessionPath: "parent.jsonl" }]);

  await assert.rejects(
    () => switchSessionWithModelFallback(async () => {
      throw new Error("Could not restore model workbuddy/hy4free");
    }, "parent.jsonl", null),
    /Could not restore model/,
  );
});

test("restoring a mapped session reads the parent only after a verified switch", async () => {
  const calls = [];
  const command = async (type, fields) => {
    calls.push([type, fields]);
    if (type === "get_state") return { data: { sessionFile: "parent.jsonl" } };
    if (type === "get_messages") return { data: [{ role: "user", content: "hello" }] };
    return { data: { cancelled: false } };
  };
  const messages = await restoreMappedSessionFile(
    command,
    "parent.jsonl",
    { provider: "workbuddy", modelId: "hy4flash-free" },
    {},
    async (state) => state?.sessionFile === "parent.jsonl",
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "hello");
  assert.deepEqual(calls.map(([type]) => type), ["switch_session", "get_state", "get_messages"]);
  assert.deepEqual(calls[0][1], { sessionPath: "parent.jsonl" });

  const rollbackCalls = [];
  const rollback = await restoreMappedSessionFile(
    async (type, fields) => {
      rollbackCalls.push([type, fields]);
      return type === "get_state" ? { data: { sessionFile: "parent.jsonl" } } : { data: { cancelled: false } };
    },
    "parent.jsonl",
    null,
    { readMessages: false },
    async () => true,
  );
  assert.deepEqual(rollback, []);
  assert.deepEqual(rollbackCalls.map(([type]) => type), ["switch_session", "get_state"]);

  await assert.rejects(
    () => restoreMappedSessionFile(
      async (type) => type === "get_state" ? { data: { sessionFile: "other.jsonl" } } : { data: { cancelled: false } },
      "parent.jsonl",
      null,
      {},
      async () => false,
    ),
    /restored a different parent session/,
  );

  await assert.rejects(
    () => restoreMappedSessionFile(
      async (type) => type === "get_messages" ? { data: [{ role: "system", content: "nope" }] } : { data: { cancelled: false } },
      "parent.jsonl",
      null,
      {},
      async () => true,
    ),
    /无法安全同步/,
  );

  await assert.rejects(
    () => restoreMappedSessionFile(
      async (type) => type === "switch_session" ? { data: { cancelled: true } } : { data: {} },
      "parent.jsonl",
      null,
      {},
      async () => true,
    ),
    /cancelled restoring/,
  );
});

test("renderer recovery payload is validated before the error card acts on it", () => {
  const info = readOmpModelRecovery("MODEL_UNAVAILABLE", {
    provider: "workbuddy",
    modelId: "hy4free",
    candidates: [
      { provider: "workbuddy", id: "hy4flash-free", name: "Hy4 Flash Free" },
      { provider: "", id: "dropped" },
      "garbage",
    ],
  });
  assert.equal(info?.code, "MODEL_UNAVAILABLE");
  assert.equal(info?.provider, "workbuddy");
  assert.deepEqual(info?.candidates, [
    { provider: "workbuddy", id: "hy4flash-free", name: "Hy4 Flash Free" },
  ]);
  assert.equal(readOmpModelRecovery("NETWORK_ERROR", {}), null);
  assert.deepEqual(readOmpModelRecovery("PROVIDER_UNAVAILABLE", "bad"), {
    code: "PROVIDER_UNAVAILABLE",
    candidates: [],
  });
});

test("OMP runtime frames stop claiming every failure is retriable", () => {
  const restricted = ompFrameToAgentEvent({
    sessionId: "s",
    runId: "r",
    frame: { type: "runtime_error", message: "403 Forbidden: account restricted" },
    messageIds: new Set(),
  });
  assert.equal(restricted?.event.type, "error");
  assert.equal(restricted?.event.error.code, "ACCOUNT_RESTRICTED");
  assert.equal(restricted?.event.error.retriable, false);

  const generic = ompFrameToAgentEvent({
    sessionId: "s",
    runId: "r",
    frame: { type: "prompt_result", status: "failed", error: { message: "model died" } },
    messageIds: new Set(),
  });
  assert.equal(generic?.event.type, "error");
  assert.equal(generic?.event.error.code, "OMP_RUNTIME_ERROR");
  assert.equal(generic?.event.error.retriable, false);

  const network = ompFrameToAgentEvent({
    sessionId: "s",
    runId: "r",
    frame: { type: "runtime_error", message: "fetch failed: ECONNRESET" },
    messageIds: new Set(),
  });
  assert.equal(network?.event.type, "error");
  assert.equal(network?.event.error.retriable, true);

  const restore = ompFrameToAgentEvent({
    sessionId: "s",
    runId: "r",
    frame: { type: "prompt_result", status: "failed", error: { message: "Could not restore model workbuddy/hy4free" } },
    messageIds: new Set(),
  });
  assert.equal(restore?.event.error.code, "MODEL_UNAVAILABLE");
  assert.deepEqual(restore?.event.error.details, { provider: "workbuddy", modelId: "hy4free" });
});
