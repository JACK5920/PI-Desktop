import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureStressTestEvidence, REPO_ROOT, writeStressTestEvidence } from "./stress-test-evidence.mjs";

test("stress evidence fingerprints source/build and hashes raw artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stress-evidence-test-"));
  try {
    const artifact = join(directory, "durability.csv");
    const output = join(directory, "evidence.json");
    const content = "sample,metric\n1,42\n";
    writeFileSync(artifact, content, "utf8");

    const result = writeStressTestEvidence(output, { artifactPaths: [artifact] });
    const document = result.document;
    assert.equal(document.format, "pi-stress-test-evidence-v1");
    assert.match(document.source.gitCommit, /^[0-9a-f]{40}$/);
    assert.match(document.source.workingTree.fingerprintSha256, /^[0-9a-f]{64}$/);
    assert.ok(document.build.appVersion);
    assert.equal(document.artifacts[0].sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(document.artifacts[0].bytes, Buffer.byteLength(content));
    assert.equal(result.output, output);
    assert.equal(captureStressTestEvidence({ repoRoot: REPO_ROOT }).artifacts.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stress evidence refuses missing raw artifacts instead of recording false evidence", () => {
  assert.throws(
    () => captureStressTestEvidence({ artifactPaths: [join(tmpdir(), "definitely-missing-pi-stress.log")] }),
    /evidence artifact is missing or not a file/,
  );
});
