import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createAgentHostBridge } = await import("../electron/main/agent-host-bridge.ts");
const { IPC } = await import("@pi-desktop/shared");

test("queued turns wait for manual compaction to release the runtime", async () => {
  let compacting = true;
  const promptRequests = [];
  const host = {
    async call(method, params) {
      if (method === "session.get") {
        return {
          session: {
            id: params?.id ?? "session-a",
            title: "Session A",
            mode: "agent",
            permissionMode: "auto",
            createdAt: "2026-11-13T00:00:00.000Z",
            updatedAt: "2026-11-13T00:00:00.000Z",
          },
        };
      }
      if (method === "session.queueList") return { entries: [] };
      if (method === "session.queuePush") return {};
      if (method === "session.queueRemove") return { removed: true };
      if (method === "session.queuePrioritize") return {};
      throw new Error(`unexpected host call: ${method}`);
    },
  };
  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => host,
    isSessionBusy: () => compacting,
    log: () => undefined,
    async invoke(channel, [request]) {
      if (channel === IPC.invoke.agentPrompt) promptRequests.push(request);
      return { accepted: true, turnId: `turn-${promptRequests.length}` };
    },
  });

  await bridge.queue.push({ sessionId: "session-a", content: "continue after compaction" });
  assert.equal(promptRequests.length, 0, "busy runtime must not receive a queued prompt");

  compacting = false;
  bridge.agentHost.kick("session-a");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(promptRequests.length, 1);
  assert.equal(promptRequests[0].content, "continue after compaction");
});
