import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile as readSource } from "node:fs/promises";

const {
  saveOmpCustomModel, listOmpCustomModels, removeOmpCustomModel, readOmpCustomModelKeys,
  ompCustomModelEnvName, ompCustomModelProviderId, OMP_CUSTOM_MODEL_ENV,
} = await import("../electron/main/omp/custom-model.ts");

function secretStore() {
  const secrets = new Map();
  return {
    secrets,
    store: {
      set: async (id, value) => { secrets.set(id, value); },
      delete: async (id) => { secrets.delete(id); },
      has: async (id) => secrets.has(id),
    },
  };
}

test("a custom OMP model writes profile metadata without persisting its key", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-custom-model-"));
  const { secrets, store } = secretStore();
  try {
    await writeFile(join(root, "models.json"), JSON.stringify({ providers: { keep_me: { api: "openai-completions", models: [] } } }));
    const result = await saveOmpCustomModel(root, {
      providerName: "My Gateway", baseUrl: "https://api.example.test/v1", api: "openai-completions", auth: "apiKey",
      modelId: "my-model", contextWindow: 100000, maxTokens: 8000, apiKey: "super-secret-test-token",
    }, store);
    const modelConfig = await readFile(join(root, "models.json"), "utf8");
    const records = await readFile(join(root, "pi-custom-models.json"), "utf8");
    assert.equal(secrets.get(result.id), "super-secret-test-token");
    assert.equal(result.configured, true);
    assert.equal(result.apiKey, undefined);
    assert.doesNotMatch(modelConfig + records, /super-secret-test-token/);
    const parsed = JSON.parse(modelConfig);
    assert.equal(parsed.providers.keep_me.api, "openai-completions");
    assert.equal(parsed.providers[ompCustomModelProviderId(result.id)].apiKey, ompCustomModelEnvName(result.id));
    assert.equal(parsed.providers[ompCustomModelProviderId(result.id)].auth, "apiKey");
    assert.equal(parsed.providers[ompCustomModelProviderId(result.id)].models[0].id, "my-model");
    assert.equal(result.id, "my-model");
    assert.deepEqual(await listOmpCustomModels(root, store.has), [{
      id: "my-model", providerId: "pi_custom_my-model", providerName: "My Gateway", baseUrl: "https://api.example.test/v1",
      api: "openai-completions", auth: "apiKey", configured: true,
      models: [{
        id: "my-model", contextWindow: 100000, maxTokens: 8000,
        supportsImages: false, thinkingLevels: [],
      }],
    }]);
    await saveOmpCustomModel(root, {
      id: result.id,
      providerName: "Changed", baseUrl: "https://api.example.test/v1", api: "anthropic-messages", auth: "apiKey",
      modelId: "anthropic-model", contextWindow: 128000, maxTokens: 4096,
    }, store);
    assert.equal(secrets.get(result.id), "super-secret-test-token", "omitting a replacement key retains the encrypted saved credential");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("adding a second model keeps the first entry and gives each its own provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-custom-model-multi-"));
  const { secrets, store } = secretStore();
  try {
    const first = await saveOmpCustomModel(root, {
      providerName: "First", baseUrl: "https://first.example.test/v1", api: "openai-completions", auth: "apiKey",
      modelId: "first-model", contextWindow: 64000, maxTokens: 4096, apiKey: "first-key",
    }, store);
    const second = await saveOmpCustomModel(root, {
      providerName: "Second", baseUrl: "https://second.example.test/v1", api: "openai-responses", auth: "apiKey",
      modelId: "second-model", contextWindow: 128000, maxTokens: 8192, apiKey: "second-key",
    }, store);
    assert.notEqual(first.id, second.id);
    const providers = JSON.parse(await readFile(join(root, "models.json"), "utf8")).providers;
    assert.equal(providers[ompCustomModelProviderId(first.id)].models[0].id, "first-model");
    assert.equal(providers[ompCustomModelProviderId(second.id)].models[0].id, "second-model");
    const envs = await readOmpCustomModelKeys(root, async (id) => secrets.get(id) ?? null);
    assert.equal(envs[ompCustomModelEnvName(first.id)], "first-key");
    assert.equal(envs[ompCustomModelEnvName(second.id)], "second-key");
    assert.equal((await listOmpCustomModels(root, store.has)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one service saves every chosen model with limits, thinking map and app-side overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-custom-model-service-"));
  const { store } = secretStore();
  try {
    const saved = await saveOmpCustomModel(root, {
      providerName: "Gateway", baseUrl: "https://gw.example.test/v1", api: "openai-completions", auth: "apiKey", apiKey: "gateway-key",
      models: [
        {
          id: "big", displayName: "Big Model", contextWindow: 500000, maxTokens: 128000, supportsImages: true,
          thinkingLevels: ["off", "low", "high", "max"], defaultThinkingLevel: "high",
        },
        {
          id: "small", contextWindow: 32000, maxTokens: 4096,
          thinkingLevels: ["off", "low"], supportsReasoningEffort: true,
        },
      ],
    }, store);
    assert.deepEqual(saved.models.map((model) => model.id), ["big", "small"]);
    const provider = JSON.parse(await readFile(join(root, "models.json"), "utf8")).providers[ompCustomModelProviderId(saved.id)];
    assert.equal(provider.models.length, 2);
    assert.equal(provider.models[0].name, "Big Model");
    assert.deepEqual(provider.models[0].input, ["text", "image"]);
    assert.equal(provider.models[0].reasoning, true);
    // Unselected standard levels are hidden; selected ones keep the provider default.
    assert.equal(provider.models[0].thinkingLevelMap.minimal, null);
    assert.equal(provider.models[0].thinkingLevelMap.low, undefined);
    assert.equal(provider.models[0].thinkingLevelMap.max, "max");
    assert.equal(provider.models[1].compat.supportsReasoningEffort, true);
    const overrides = JSON.parse(await readFile(join(root, "pi-model-overrides.json"), "utf8")).overrides;
    assert.equal(overrides[`pi_custom_${saved.id}::big`].displayName, "Big Model");
    assert.equal(overrides[`pi_custom_${saved.id}::big`].defaultThinkingLevel, "high");
    assert.equal(overrides[`pi_custom_${saved.id}::small`].displayName, undefined);

    // Editing replaces the whole model list and drops the aliases of removed models.
    await saveOmpCustomModel(root, {
      id: saved.id, providerName: "Gateway", baseUrl: "https://gw.example.test/v1", api: "openai-completions", auth: "apiKey",
      models: [{ id: "small", contextWindow: 32000, maxTokens: 4096 }],
    }, store);
    const nextOverrides = JSON.parse(await readFile(join(root, "pi-model-overrides.json"), "utf8")).overrides;
    assert.equal(nextOverrides[`pi_custom_${saved.id}::big`], undefined);
    const nextProvider = JSON.parse(await readFile(join(root, "models.json"), "utf8")).providers[ompCustomModelProviderId(saved.id)];
    assert.deepEqual(nextProvider.models.map((model) => model.id), ["small"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("custom OMP model rejects remote HTTP endpoints and corrupt profile is not overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-custom-model-invalid-"));
  const { secrets, store } = secretStore();
  try {
    await assert.rejects(saveOmpCustomModel(root, {
      providerName: "bad", baseUrl: "http://example.test/v1", api: "openai-completions", auth: "apiKey", modelId: "x",
      contextWindow: 10000, maxTokens: 1000, apiKey: "should-not-be-stored",
    }, store), /必须使用 HTTPS/);
    assert.equal(secrets.size, 0);
    await writeFile(join(root, "models.json"), "{broken");
    await assert.rejects(saveOmpCustomModel(root, {
      providerName: "good", baseUrl: "https://api.example.test/v1", api: "openai-responses", auth: "apiKey", modelId: "x",
      contextWindow: 10000, maxTokens: 1000, apiKey: "key",
    }, store), /配置文件损坏/);
    assert.equal(await readFile(join(root, "models.json"), "utf8"), "{broken");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("supports explicitly unauthenticated local endpoints without retaining an old key", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-custom-model-no-auth-"));
  const { secrets, store } = secretStore();
  try {
    secrets.set("local-model", "previous-api-key");
    const result = await saveOmpCustomModel(root, {
      providerName: "Local Gateway", baseUrl: "http://localhost:8080/v1", api: "openai-completions", auth: "none",
      modelId: "local-model", contextWindow: 16000, maxTokens: 2048,
    }, store);
    const provider = JSON.parse(await readFile(join(root, "models.json"), "utf8")).providers[ompCustomModelProviderId(result.id)];
    assert.equal(result.configured, true);
    assert.equal(secrets.has(result.id), false);
    assert.equal(provider.auth, "none");
    assert.equal(provider.apiKey, undefined);
    assert.deepEqual(provider.models[0].input, ["text"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("removing one custom model removes only its provider row, record and secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-custom-model-remove-"));
  const deleted = new Set();
  try {
    await saveOmpCustomModel(root, {
      providerName: "Keep", baseUrl: "https://keep.example.test/v1", api: "openai-completions", auth: "apiKey",
      modelId: "keep-me", contextWindow: 16000, maxTokens: 2048, apiKey: "keep-key",
    }, { set: async () => {}, delete: async () => {}, has: async () => true });
    const drop = await saveOmpCustomModel(root, {
      providerName: "Drop", baseUrl: "https://drop.example.test/v1", api: "openai-completions", auth: "apiKey",
      modelId: "drop-me", contextWindow: 16000, maxTokens: 2048, apiKey: "drop-key",
    }, { set: async () => {}, delete: async () => {}, has: async () => true });
    await removeOmpCustomModel(root, drop.id, async (id) => { deleted.add(id); });
    const parsed = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
    assert.equal(parsed.providers[ompCustomModelProviderId(drop.id)], undefined);
    assert.ok(parsed.providers[ompCustomModelProviderId("keep-me")]);
    const records = JSON.parse(await readFile(join(root, "pi-custom-models.json"), "utf8"));
    assert.deepEqual(records.providers.map((provider) => provider.id), ["keep-me"]);
    assert.deepEqual([...deleted], [drop.id]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy single-model profiles still resolve their key and provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-custom-model-legacy-"));
  try {
    await writeFile(join(root, "pi-custom-model.json"), JSON.stringify({
      providerName: "Legacy", baseUrl: "https://legacy.example.test/v1", api: "openai-completions", auth: "apiKey",
      modelId: "legacy-model", contextWindow: 32000, maxTokens: 2048,
    }));
    const models = await listOmpCustomModels(root, async () => true);
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "compatible");
    assert.equal(ompCustomModelProviderId(models[0].id), "pi_custom_compatible");
    assert.equal(ompCustomModelEnvName("compatible"), OMP_CUSTOM_MODEL_ENV);
    const envs = await readOmpCustomModelKeys(root, async () => "legacy-key");
    assert.equal(envs[OMP_CUSTOM_MODEL_ENV], "legacy-key");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OMP child process receives its Host-stored keys only through its private environment", async () => {
  const runtime = await readSource(new URL("../electron/main/omp/rpc-runtime.ts", import.meta.url), "utf8");
  const service = await readSource(new URL("../electron/main/ipc/register.ts", import.meta.url), "utf8");
  assert.match(runtime, /getCustomModelApiKeys\?\.\(\)/);
  assert.match(runtime, /Object\.assign\(childEnv, customKeys\)/);
  assert.match(service, /secrets\.getForRuntime.*ompCustomModelSecretRef/s);
  assert.doesNotMatch(runtime, /console\.(?:log|info|warn|error).*customKeys/);
});
