import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readOmpProfileSettings, writeOmpProfileSettings } from "../electron/main/omp/profile-settings.mjs";

test("OMP profile defaults use a separate app-owned native config overlay and preserve the OMP default when cleared", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-profile-settings-"));
  try {
    const empty = await readOmpProfileSettings(root);
    assert.equal(empty.defaultThinkingLevel, null);
    assert.match(await readFile(empty.configPath, "utf8"), /PI Desktop managed OMP profile overlay/);

    const saved = await writeOmpProfileSettings(root, { defaultThinkingLevel: "xhigh" });
    assert.equal(saved.defaultThinkingLevel, "xhigh");
    assert.equal(await readFile(saved.configPath, "utf8"), "# PI Desktop managed OMP profile overlay. Edit from the PI settings UI.\ndefaultThinkingLevel: xhigh\n");
    assert.equal((await readOmpProfileSettings(root)).defaultThinkingLevel, "xhigh");

    await writeOmpProfileSettings(root, { defaultThinkingLevel: null });
    assert.equal((await readOmpProfileSettings(root)).defaultThinkingLevel, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OMP worktree exit policy round-trips all native choices without replacing other profile defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-profile-worktree-"));
  try {
    await writeOmpProfileSettings(root, { defaultThinkingLevel: "high" });
    for (const policy of ["keep", "ask", "remove", "force"]) {
      const saved = await writeOmpProfileSettings(root, { worktreeOnExit: policy });
      assert.equal(saved.worktreeOnExit, policy);
      assert.equal(saved.defaultThinkingLevel, "high");
      assert.equal((await readOmpProfileSettings(root)).worktreeOnExit, policy);
      assert.match(await readFile(saved.configPath, "utf8"), new RegExp(`\\s+onExit: ${policy}\\n`));
    }
    const cleared = await writeOmpProfileSettings(root, { worktreeOnExit: null });
    assert.equal(cleared.worktreeOnExit, null);
    assert.equal(cleared.defaultThinkingLevel, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OMP profile settings reject secret-like, unknown, and malformed data without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-profile-invalid-"));
  try {
    await assert.rejects(writeOmpProfileSettings(root, { defaultThinkingLevel: "../../secrets" }), /thinking level/);
    await assert.rejects(writeOmpProfileSettings(root, { apiKey: "secret" }), /unsupported fields/);
    const first = await readOmpProfileSettings(root);
    await writeFile(first.configPath, "apiKey: secret\n", "utf8");
    await assert.rejects(writeOmpProfileSettings(root, { defaultThinkingLevel: "high" }), /unknown or malformed/);
    assert.equal(await readFile(first.configPath, "utf8"), "apiKey: secret\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
