import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  filterOmpModelsBySearch,
  groupOmpModelsByProvider,
  mapOmpProviderDisplayNames,
  toOmpRpcModelIdentity,
} from "../src/features/chat/composer/omp-model-selection.mjs";

const customProvider = {
  id: "magpie",
  providerId: "pi_custom_magpie",
  providerName: "Magpie Gateway",
};

const model = { provider: "pi_custom_magpie", id: "magpie-chat", name: "Magpie Chat" };

test("OMP custom provider names label and search models without changing their RPC identity", () => {
  const [mapped] = mapOmpProviderDisplayNames([model], [customProvider]);

  assert.equal(mapped.providerName, "Magpie Gateway");
  assert.equal(mapped.provider, "pi_custom_magpie");
  assert.equal(mapped.id, "magpie-chat");
  assert.deepEqual(filterOmpModelsBySearch([mapped], "magpie gateway"), [mapped]);
  assert.deepEqual(groupOmpModelsByProvider([mapped]), [{
    provider: "pi_custom_magpie",
    displayName: "Magpie Gateway",
    models: [mapped],
  }]);
  assert.deepEqual(toOmpRpcModelIdentity(mapped), { provider: "pi_custom_magpie", modelId: "magpie-chat" });
});

test("OMP model picker falls back to the native provider ID when custom metadata is unavailable", () => {
  const [unchanged] = mapOmpProviderDisplayNames([model], []);
  assert.equal(unchanged.provider, "pi_custom_magpie");
  assert.equal(unchanged.providerName, undefined);
  assert.equal(groupOmpModelsByProvider([unchanged])[0].displayName, "pi_custom_magpie");
});

test("OMP picker requests custom provider labels but treats a settings lookup failure as optional", async () => {
  const picker = await readFile(new URL("../src/features/chat/composer/ComposerOmpModelPicker.tsx", import.meta.url), "utf8");
  assert.match(picker, /api\.getOmpCustomModels\(\)\.catch\(/);
  assert.match(picker, /mapOmpProviderDisplayNames\(/);
  assert.match(picker, /filterOmpModelsBySearch\(/);
  assert.match(picker, /groupOmpModelsByProvider\(/);
  assert.match(picker, /label: displayName/);
  assert.equal((picker.match(/toOmpRpcModelIdentity\(candidate\)/g) ?? []).length, 2, "both selection and recovery send the native model identity");
  assert.match(picker, /aria-label=\{group\.displayName \|\| undefined\}/);
  assert.match(picker, /title=\{`\$\{ompProviderDisplayName\(candidate\)\} · \$\{candidate\.id\}`\}/);
});
