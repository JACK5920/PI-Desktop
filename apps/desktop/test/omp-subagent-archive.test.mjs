import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OmpSubagentArchive } from "../electron/main/omp/subagent-archive.mjs";

test("OMP subagent roster and transcript survive archive recreation and merge with live state", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-subagent-archive-"));
  try {
    const archive = new OmpSubagentArchive(root);
    const firstRoster = await archive.mergeRoster("session-1", [
      { id: "agent-1", parentToolCallId: "task-call", task: "Read report", status: "running" },
      { id: "agent-2", parentToolCallId: "task-call", task: "Check tests", status: "completed" },
    ]);
    assert.equal(firstRoster.find((agent) => agent.id === "agent-1").observedActive, true);
    assert.equal(firstRoster.find((agent) => agent.id === "agent-2").observedActive, false);
    await archive.appendTranscript("session-1", "agent-1", {
      fromByte: 0,
      nextByte: 128,
      messages: [{ id: "u1", role: "user", content: "Read report" }, { id: "a1", role: "assistant", content: "Reading" }],
    });
    await archive.appendTranscript("session-1", "agent-1", {
      fromByte: 128,
      nextByte: 256,
      messages: [{ id: "a1", role: "assistant", content: "Reading" }, { id: "a2", role: "assistant", content: "Done" }],
    });

    const restarted = new OmpSubagentArchive(root);
    const historical = await restarted.getRoster("session-1");
    assert.equal(historical.length, 2);
    assert.equal(historical.find((agent) => agent.id === "agent-2").parentToolCallId, "task-call");
    assert.ok(historical.every((agent) => agent.observedActive === false));
    const transcript = await restarted.getTranscript("session-1", "agent-1");
    assert.deepEqual(transcript.messages.map((message) => message.id), ["u1", "a1", "a2"]);
    assert.equal(transcript.nextByte, 256);

    const merged = await restarted.mergeRoster("session-1", [
      { id: "agent-1", parentToolCallId: "task-call", task: "Read report", status: "running", progress: { message: "Reopened" } },
    ]);
    assert.equal(merged.length, 2);
    assert.equal(merged.find((agent) => agent.id === "agent-1").observedActive, true);
    assert.equal(merged.find((agent) => agent.id === "agent-2").observedActive, false);
    assert.equal(merged.find((agent) => agent.id === "agent-2").lastKnownStatus, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OMP subagent archive hashes path-shaped session and agent identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-subagent-archive-"));
  try {
    const archive = new OmpSubagentArchive(root);
    const sessionId = "../outside";
    const agentId = "agent/../../outside";
    await archive.mergeRoster(sessionId, [{ id: agentId, status: "running" }]);
    assert.equal((await archive.getRoster(sessionId))[0].id, agentId);
    await archive.appendTranscript(sessionId, agentId, {
      fromByte: 0,
      nextByte: 1,
      messages: [{ id: "a1", role: "assistant", content: "safe hashed filename" }],
    });
    assert.equal((await archive.getTranscript(sessionId, agentId)).messages[0].id, "a1");
    const sessionHash = createHash("sha256").update(sessionId).digest("hex");
    await access(join(root, "runtime", "subagents", sessionHash, "index.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
