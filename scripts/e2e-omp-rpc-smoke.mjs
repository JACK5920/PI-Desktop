import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.PI_OMP_BINARY;
if (!binary) throw new Error("Set PI_OMP_BINARY to an already-installed OMP executable.");
const root = join(repoRoot, ".artifacts", "omp-rpc-smoke");
const profileDir = join(root, "profile");
const sessionDir = join(root, "session");
const cwd = join(root, "workspace");
await Promise.all([profileDir, sessionDir, cwd].map((path) => mkdir(path, { recursive: true })));
const fixtureSessionId = "a78c86b1-3c7a-4f30-947a-7468bd0a3dcf";
const fixturePath = join(sessionDir, "2026-01-01T00-00-00.000Z_" + fixtureSessionId + ".jsonl");
const fixtureEntries = [
  { type: "session", version: 3, id: fixtureSessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd },
  { type: "message", id: "omp-smoke-user", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "OMP RPC isolated session-tree fixture", timestamp: 1767225601000 } },
];
await writeFile(fixturePath, fixtureEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { encoding: "utf8" });

const child = spawn(binary, ["--mode", "rpc-ui", "--cwd", cwd, "--model", "openai/gpt-5.2"], {
  cwd,
  env: { ...process.env, PI_CODING_AGENT_DIR: profileDir },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = "";
let requestId = 0;
let ready = false;
let failed = false;
const pending = new Map();

function send(type, fields = {}) {
  const id = `smoke-${++requestId}`;
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`OMP RPC smoke timed out: ${type}`));
    }, 15_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolveRequest(value); }, reject: (error) => { clearTimeout(timer); rejectRequest(error); } });
    child.stdin.write(`${JSON.stringify({ ...fields, id, type })}\n`);
  });
}

function fail(error) {
  if (failed) return;
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
  child.kill();
  process.exitCode = 1;
}

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("error", fail);
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
  for (;;) {
    const newline = stdout.indexOf("\n");
    if (newline < 0) break;
    const line = stdout.slice(0, newline);
    stdout = stdout.slice(newline + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame.type === "ready" && !ready) {
      ready = true;
      void (async () => {
        if (frame.supportedProtocolVersions?.includes(2)) await send("negotiate_protocol", { protocolVersion: 2 });
        const opened = await send("open_session", { sessionDir });
        const [state, models, login, tree, stats, lastAssistant, messagesSnapshot, entriesSnapshot, branchMessages] = await Promise.all([
          send("get_state"),
          send("get_available_models"),
          send("get_login_providers"),
          send("get_tree"),
          send("get_session_stats"),
          send("get_last_assistant_text"),
          send("get_messages"),
          send("get_entries"),
          send("get_branch_messages"),
        ]);
        const providers = login.data?.providers;
        if (!opened.success || typeof opened.data?.resumed !== "boolean" || !state.success || !models.success || !Array.isArray(providers) || !tree.success || !Array.isArray(tree.data?.tree) || !stats.success || !lastAssistant.success) throw new Error("OMP RPC open/state/model/login/session-tree/statistics/assistant response was incomplete.");
        if (!Array.isArray(messagesSnapshot.data?.messages) || !Array.isArray(entriesSnapshot.data?.entries)) throw new Error("OMP RPC message or entry snapshots were incomplete.");
        const profileEntries = await readdir(profileDir).catch(() => []);
        console.log(JSON.stringify({
          ready: true,
          protocol: frame.supportedProtocolVersions?.includes(2) ? 2 : 1,
          selectedModel: state.data?.model ? `${state.data.model.provider}/${state.data.model.id}` : null,
          openSessionResumed: opened.data.resumed,
          openedSessionFile: opened.data.sessionFile ?? null,
          stateFields: Object.keys(state.data ?? {}).sort(),
          fastModeEnabled: state.data?.fastModeEnabled ?? null,
          slowModeEnabled: state.data?.slowModeEnabled ?? null,
          availableModelCount: models.data?.models?.length ?? 0,
          loginProviderCount: providers.length,
          sessionTreeRootCount: tree.data.tree.length,
          sessionTreeLeafId: tree.data.leafId ?? null,
          sessionStatsFields: Object.keys(stats.data ?? {}).sort(),
          lastAssistantTextSupported: lastAssistant.success === true,
          branchMessagesSupported: branchMessages.success === true && Array.isArray(branchMessages.data?.messages),
          branchableMessageCount: Array.isArray(branchMessages.data?.messages) ? branchMessages.data.messages.length : null,
          nativeMessageSnapshotCount: messagesSnapshot.data.messages.length,
          nativeEntrySnapshotCount: entriesSnapshot.data.entries.length,
          nativeMessageResponseFields: Object.keys(messagesSnapshot.data ?? {}).sort(),
          nativeEntryResponseFields: Object.keys(entriesSnapshot.data ?? {}).sort(),
          profileEntries,
        }));
        child.stdin.end();
      })().catch(fail);
      continue;
    }
    if (frame.type === "response" && typeof frame.id === "string" && pending.has(frame.id)) {
      const waiter = pending.get(frame.id);
      pending.delete(frame.id);
      frame.success === false ? waiter.reject(new Error(frame.error ?? `OMP RPC ${frame.command} failed`)) : waiter.resolve(frame);
    }
  }
});
child.on("exit", async (code, signal) => {
  for (const waiter of pending.values()) waiter.reject(new Error(`OMP exited before the smoke test completed (code=${code}, signal=${signal})`));
  pending.clear();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  if (!ready || (code !== 0 && code !== null)) process.exitCode = 1;
});
const timeout = setTimeout(() => fail(new Error("OMP RPC smoke exceeded 60 seconds.")), 60_000);
child.once("exit", () => clearTimeout(timeout));
