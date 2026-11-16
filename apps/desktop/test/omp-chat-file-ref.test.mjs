import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveOmpCwdFileRef } from "../electron/main/omp/chat-file-ref.mjs";

test("OMP no-project references resolve only existing relative files within the verified cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-file-ref-"));
  try {
    const report = join(root, "pi_tooltest", "a1_fileops", "report.md");
    await mkdir(join(root, "pi_tooltest", "a1_fileops"), { recursive: true });
    await writeFile(report, "verified report", "utf8");
    const match = await resolveOmpCwdFileRef("pi_tooltest/a1_fileops/report.md:4", root);
    assert.equal(match.absolutePath, await realpath(report));
    assert.equal(match.root, "scratch");
    assert.equal(match.matchedBy, "exact-relative");
    assert.equal(await resolveOmpCwdFileRef("missing/report.md", root), null);
    assert.equal(await resolveOmpCwdFileRef("../outside.txt", root), null);
    assert.equal(await resolveOmpCwdFileRef(report, root), null, "absolute refs use the existing explicit absolute-path flow");
    assert.equal(await resolveOmpCwdFileRef("pi_tooltest/a1_fileops/report.md", null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace reference IPC uses only the Host-verified local OMP cwd when no project root exists", async () => {
  const source = await readFile(new URL("../electron/main/ipc/workspace-ipc.ts", import.meta.url), "utf8");
  assert.match(source, /session\.agentEngine !== "omp" \|\| session\.remoteWorkspace/);
  assert.match(source, /if \(session\.projectPath\?\.trim\(\)\) return null;[\s\S]*?const candidate = homedir\(\)/);
  assert.match(source, /resolveOmpCwdFileRef\(ref, ompCwd\)/);
  assert.match(source, /exact transcript file references/);
});
