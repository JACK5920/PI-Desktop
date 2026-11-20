import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import {
  getOmpLocalRootPath,
  hasOmpLocalSpillScheme,
  parseOmpLocalSpillRef,
  readOmpNativeSessionId,
  resolveOmpLocalSpillFile,
  resolveOmpLocalSpillRoot,
} from "../electron/main/omp/local-spill-ref.mjs";

test("OMP local spill URLs are strict, bounded numeric references with legacy artifact aliases", () => {
  assert.equal(parseOmpLocalSpillRef("local://19.log"), 19);
  assert.equal(parseOmpLocalSpillRef("local://19.log:raw:5-9"), 19);
  assert.equal(parseOmpLocalSpillRef("local://19.log:1-30,:-30"), 19);
  assert.equal(parseOmpLocalSpillRef("artifact://19"), 19);
  assert.equal(parseOmpLocalSpillRef("artifact://19.log"), 19);
  for (const value of [
    "local://../secret.log",
    "local://19.log/../secret",
    "local://19.log?path=outside",
    "local://9007199254740992.log",
    "local://19.log:raw:bad/path",
    `local://${"1".repeat(257)}.log`,
    "artifact://../../secret",
  ]) assert.equal(parseOmpLocalSpillRef(value), null, value);
  assert.equal(hasOmpLocalSpillScheme("local://not-a-spill"), true);
  assert.equal(hasOmpLocalSpillScheme("artifact://.."), true);
  assert.equal(hasOmpLocalSpillScheme("https://example.test/7.log"), false);
});

test("OMP local root matches the native session directory and Windows long-path fallback", () => {
  const sessionFile = win32.join("C:\\sessions", `${"x".repeat(140)}.jsonl`);
  const regular = getOmpLocalRootPath({ sessionFile, nativeSessionId: "native-id", platform: "win32", tempDirectory: "C:\\Temp" });
  assert.equal(regular, win32.resolve(sessionFile.slice(0, -".jsonl".length), "local"));

  const longSessionFile = win32.join("C:\\sessions", `${"x".repeat(200)}.jsonl`);
  assert.equal(
    getOmpLocalRootPath({ sessionFile: longSessionFile, nativeSessionId: "native/unsafe id", platform: "win32", tempDirectory: "C:\\Temp" }),
    win32.join("C:\\Temp", "omp-local", "native_unsafe_id"),
  );
  assert.equal(getOmpLocalRootPath({ sessionFile: longSessionFile, platform: "win32", tempDirectory: "C:\\Temp" }), null);
  assert.equal(getOmpLocalRootPath({ sessionFile: "/tmp/not-a-session.txt", platform: "linux" }), null);
});

test("OMP spill files resolve only inside the current session's existing local root", async () => {
  const temp = await mkdtemp(join(tmpdir(), "omp-local-spill-"));
  try {
    const sessionFile = join(temp, "native-session.jsonl");
    const spillRoot = join(temp, "native-session", "local");
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "native-session" })}\n${"x".repeat(100_000)}`, "utf8");
    await mkdir(spillRoot, { recursive: true });
    const spillPath = join(spillRoot, "7.log");
    await writeFile(spillPath, "large output body", "utf8");
    assert.equal(await readOmpNativeSessionId(sessionFile), "native-session", "header lookup must not parse the full transcript");

    const resolved = await resolveOmpLocalSpillFile({ sessionFile, nativeSessionId: "native-session", ref: "local://7.log:raw:1-20" });
    assert.equal(resolved.absolutePath, await realpath(spillPath));
    assert.equal(resolved.root, await realpath(spillRoot));
    assert.equal(resolved.relativePath, "7.log");
    assert.equal((await resolveOmpLocalSpillFile({ sessionFile, nativeSessionId: "native-session", ref: "artifact://7" })).absolutePath, resolved.absolutePath);
    assert.equal(await resolveOmpLocalSpillFile({ sessionFile, nativeSessionId: "native-session", ref: "local://8.log" }), null);

    const otherSessionFile = join(temp, "other-session.jsonl");
    await writeFile(otherSessionFile, `${JSON.stringify({ type: "session", id: "other-session" })}\n`, "utf8");
    assert.equal(await resolveOmpLocalSpillFile({ sessionFile: otherSessionFile, nativeSessionId: "other-session", ref: "local://7.log" }), null);
    assert.equal(await resolveOmpLocalSpillRoot({ sessionFile: join(temp, "missing.jsonl"), nativeSessionId: "missing" }), null);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("OMP spill resolution rejects symlinked roots and files", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "omp-local-spill-link-"));
  try {
    const sessionFile = join(temp, "native-session.jsonl");
    const spillRoot = join(temp, "native-session", "local");
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "native-session" })}\n`, "utf8");
    await mkdir(spillRoot, { recursive: true });
    const outside = join(temp, "outside.log");
    await writeFile(outside, "outside", "utf8");
    try {
      await symlink(outside, join(spillRoot, "9.log"), "file");
      assert.equal(await resolveOmpLocalSpillFile({ sessionFile, nativeSessionId: "native-session", ref: "local://9.log" }), null);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return t.skip("symlink creation is unavailable in this Windows environment");
      throw error;
    }

    const linkSessionFile = join(temp, "linked.jsonl");
    const outsideRoot = join(temp, "outside-local");
    await mkdir(join(temp, "linked"));
    await mkdir(outsideRoot);
    await writeFile(linkSessionFile, `${JSON.stringify({ type: "session", id: "linked" })}\n`, "utf8");
    try {
      await symlink(outsideRoot, join(temp, "linked", "local"), "junction");
      assert.equal(await resolveOmpLocalSpillRoot({ sessionFile: linkSessionFile, nativeSessionId: "linked" }), null);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return t.skip("directory symlink creation is unavailable in this Windows environment");
      throw error;
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("workspace IPC resolves local spill URLs only through the session-scoped OMP resolver", async () => {
  const source = await readFile(new URL("../electron/main/ipc/workspace-ipc.ts", import.meta.url), "utf8");
  const registration = await readFile(new URL("../electron/main/ipc/register.ts", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../electron/main/omp/rpc-runtime.ts", import.meta.url), "utf8");
  assert.match(source, /if \(hasOmpLocalSpillScheme\(rawRef\)\) \{[\s\S]*?if \(!input\.sessionId \|\| !resolveOmpLocalSpill\) return \{ match: null \};[\s\S]*?resolveOmpLocalSpill\(\{ sessionId: input\.sessionId, ref: rawRef \}\)/);
  assert.match(registration, /resolveOmpLocalSpill: async \(\{ sessionId, ref \}\) => \{[\s\S]*?resolveOmpSessionContext\(sessionId\)[\s\S]*?ompRpcRuntime\.resolveLocalSpill/);
  assert.match(source, /isPotentialOmpLocalSpillPath\(String\(requestedPath \?\? ""\)\)/);
  assert.match(runtime, /async resolveLocalSpill\([\s\S]*?await this\.ensureSession\(input\)[\s\S]*?this\.command\(input\.sessionId, "get_state"\)[\s\S]*?this\.resolveSessionFile\(stateData\.sessionFile, expectedSessionDir\)/);
});
