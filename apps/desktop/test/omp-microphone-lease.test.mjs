import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("OMP WebRTC microphone lease is main-window-owner-bound, exclusive and released on session exit", async () => {
  const source = await read("../electron/main/omp/microphone-lease.ts");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { OmpMicrophoneLeaseRegistry } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  let captures = 0;
  let releases = 0;
  const registry = new OmpMicrophoneLeaseRegistry(() => { captures++; return () => { releases++; }; });
  const owner = { webContentsId: 1, frameProcessId: 2, frameRoutingId: 3, url: "file:///app/index.html" };
  const otherOwner = { ...owner, frameRoutingId: 4 };
  registry.acquire("session-a", owner);
  registry.acquire("session-a", owner); // idempotent retry
  assert.equal(captures, 1);
  assert.equal(registry.hasReservation(owner), true);
  assert.throws(() => registry.acquire("session-b", otherOwner), /麦克风正被另一个功能占用/);
  assert.equal(registry.release("session-a", otherOwner), false);
  assert.equal(registry.release("session-a", owner), true);
  assert.equal(releases, 1);
  registry.acquire("session-c", otherOwner);
  registry.releaseForWebContents(otherOwner.webContentsId);
  assert.equal(registry.hasReservation(otherOwner), false);
  assert.equal(releases, 2);
});

test("OMP WebRTC microphone IPC is limited to a running chat session and permission handler checks owner lease", async () => {
  const register = await read("../electron/main/ipc/register.ts");
  const index = await read("../electron/main/index.ts");
  assert.match(register, /ompMicrophoneAcquire[\s\S]*?ompSessionContext[\s\S]*?OMP_SETTINGS_RPC_SESSION_ID[\s\S]*?isRunning\(context\.sessionId\)/);
  assert.match(register, /liveOwnerFromInvoke\(event, getMainWindow\(\)\)/);
  assert.match(register, /releaseSession\(event\.sessionId\)/);
  assert.match(index, /liveCallService\.hasMicrophoneReservation\(owner\) \|\| ompMicrophoneLeases\.hasReservation\(owner\)/);
});
