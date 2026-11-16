import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readOmpHiddenModels, writeOmpHiddenModels, ompModelVisibilityKey } = await import("../electron/main/omp/model-visibility.ts");

test("OMP hidden model preferences persist, deduplicate and preserve new models as visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-model-visibility-"));
  try {
    const hidden = [ompModelVisibilityKey("provider/a", "model x"), ompModelVisibilityKey("provider/a", "model x")];
    assert.deepEqual(await writeOmpHiddenModels(root, hidden), [hidden[0]]);
    assert.deepEqual(await readOmpHiddenModels(root), [hidden[0]]);
    const saved = JSON.parse(await readFile(join(root, "pi-visible-models.json"), "utf8"));
    assert.deepEqual(saved.hiddenModels, [hidden[0]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OMP hidden model preferences reject corrupt data and oversized writes without overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-model-visibility-invalid-"));
  try {
    const path = join(root, "pi-visible-models.json");
    await writeFile(path, "{broken");
    await assert.rejects(readOmpHiddenModels(root), /损坏/);
    await assert.rejects(writeOmpHiddenModels(root, new Array(20_001).fill("p::m")), /无效/);
    assert.equal(await readFile(path, "utf8"), "{broken");
  } finally { await rm(root, { recursive: true, force: true }); }
});
