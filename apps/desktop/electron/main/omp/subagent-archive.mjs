import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const VERSION = 1;
const MAX_AGENTS = 256;
const MAX_AGENT_METADATA_BYTES = 128 * 1024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

function key(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function toStatus(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function terminalStatus(value) {
  const status = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ["completed", "complete", "success", "succeeded", "failed", "failure", "error", "aborted", "cancelled", "canceled", "stopped", "timed_out", "timeout", "denied"]
    .includes(status) ? status : "";
}

function terminalStatusOf(agent) {
  return terminalStatus(agent?.deliveryOutcome)
    || terminalStatus(agent?.transcriptOutcome)
    || terminalStatus(agent?.lastKnownStatus)
    || terminalStatus(agent?.status);
}

function isNewTaskGeneration(previous, incoming) {
  return Boolean(previous?.parentToolCallId && incoming?.parentToolCallId
    && previous.parentToolCallId !== incoming.parentToolCallId);
}

/** Merge one OMP snapshot without letting a delayed active event undo a settled task. */
function mergeAgentSnapshot(previous, incoming, activeFromStatus) {
  const newGeneration = isNewTaskGeneration(previous, incoming);
  const prior = newGeneration ? null : previous;
  const status = toStatus(incoming.status ?? incoming.progress?.status ?? prior?.status);
  const priorTerminal = terminalStatusOf(prior);
  const incomingTerminal = terminalStatus(status);
  const preserveTerminal = Boolean(priorTerminal && !incomingTerminal);
  const merged = {
    ...(prior ?? {}),
    ...incoming,
    id: incoming.id,
    status: preserveTerminal ? priorTerminal : status,
    lastKnownStatus: preserveTerminal ? priorTerminal : status,
    observedActive: preserveTerminal ? false : activeFromStatus(status),
  };

  // A new Task call is a new lifecycle generation. Do not carry the previous
  // run's delivery, transcript outcome, or progress into the new card.
  if (newGeneration) {
    for (const field of ["deliveryStatus", "deliveryOutcome", "deliveryOutput", "deliveryOutputTruncated", "deliveryError", "deliveryAbortReason", "deliveryDuration", "deliveryToolCallId", "transcriptOutcome"]) {
      delete merged[field];
    }
    if (!incoming.name && previous.name) merged.name = previous.name;
  }

  return merged;
}

/**
 * Durable, per-conversation archive for OMP's ephemeral subagent roster and
 * transcripts. It deliberately lives under the managed OMP data directory,
 * never under a project-controlled path. Session and agent ids are hashed for
 * filenames; the JSON files are atomically replaced and size-bounded.
 */
export class OmpSubagentArchive {
  #root;
  #locks = new Map();

  constructor(root) {
    this.#root = join(root, "runtime", "subagents");
  }

  #sessionDir(sessionId) {
    const id = String(sessionId ?? "").trim();
    if (!id || id.length > 512 || id.includes("\0")) throw new Error("invalid OMP session id");
    return join(this.#root, key(id));
  }

  #indexPath(sessionId) {
    return join(this.#sessionDir(sessionId), "index.json");
  }

  #transcriptPath(sessionId, agentId) {
    const id = String(agentId ?? "").trim();
    if (!id || id.length > 512 || id.includes("\0")) throw new Error("invalid OMP subagent id");
    return join(this.#sessionDir(sessionId), `${key(id)}.json`);
  }

  async #locked(sessionId, operation) {
    const id = String(sessionId);
    const previous = this.#locks.get(id) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const chained = previous.then(() => current);
    this.#locks.set(id, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(id) === chained) this.#locks.delete(id);
    }
  }

  async #readIndex(sessionId) {
    try {
      const parsed = JSON.parse(await readFile(this.#indexPath(sessionId), "utf8"));
      if (parsed?.version !== VERSION || !Array.isArray(parsed.agents)) throw new Error("unsupported OMP subagent archive");
      return parsed.agents
        .filter((agent) => safeObject(agent) && typeof agent.id === "string" && agent.id.trim())
        .slice(-MAX_AGENTS);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async #atomicWrite(path, value, maxBytes) {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") > maxBytes) throw new Error("OMP subagent archive size limit exceeded");
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, path);
    } catch (error) {
      // Do not remove an unverified path here; the random temporary name is
      // unique and an interrupted write is harmless on the next startup.
      throw error;
    }
  }

  async #writeIndex(sessionId, agents) {
    await this.#atomicWrite(this.#indexPath(sessionId), { version: VERSION, agents: agents.slice(-MAX_AGENTS) }, 32 * 1024 * 1024);
  }

  async getRoster(sessionId) {
    return this.#locked(sessionId, async () => (await this.#readIndex(sessionId)).map((agent) => ({
      ...agent,
      observedActive: false,
      lastKnownStatus: toStatus(agent.lastKnownStatus ?? agent.status),
    })));
  }

  async getAgentMeta(sessionId, agentId) {
    return this.#locked(sessionId, async () => {
      const agents = await this.#readIndex(sessionId);
      return agents.find((agent) => agent.id === agentId) ?? null;
    });
  }

  async upsertAgent(sessionId, incoming) {
    const agent = safeObject(incoming);
    if (!agent || typeof agent.id !== "string" || !agent.id.trim() || agent.id.length > 512) return;
    await this.#locked(sessionId, async () => {
      const agents = await this.#readIndex(sessionId);
      const previousIndex = agents.findIndex((item) => item.id === agent.id);
      const previous = previousIndex >= 0 ? agents[previousIndex] : null;
      const next = mergeAgentSnapshot(previous, agent, (status) =>
        !terminalStatus(status) && ["running", "pending", "started", "unknown"].includes(status.toLowerCase()),
      );
      if (jsonSize(next) > MAX_AGENT_METADATA_BYTES) throw new Error("OMP subagent metadata size limit exceeded");
      if (previousIndex >= 0) agents.splice(previousIndex, 1);
      agents.push(next);
      await this.#writeIndex(sessionId, agents);
    });
  }

  async mergeRoster(sessionId, incoming) {
    const current = Array.isArray(incoming)
      ? incoming.filter((agent) => safeObject(agent) && typeof agent.id === "string" && agent.id.trim() && agent.id.length <= 512)
      : [];
    return this.#locked(sessionId, async () => {
      const agents = await this.#readIndex(sessionId);
      const next = new Map(agents.map((agent) => [agent.id, { ...agent, observedActive: false }]));
      for (const agent of current) {
        const previous = next.get(agent.id);
        const merged = mergeAgentSnapshot(previous, agent, (status) => !terminalStatus(status));
        if (jsonSize(merged) > MAX_AGENT_METADATA_BYTES) continue;
        next.delete(agent.id);
        next.set(agent.id, merged);
      }
      const ordered = [...next.values()].slice(-MAX_AGENTS);
      if (JSON.stringify(ordered) !== JSON.stringify(agents)) await this.#writeIndex(sessionId, ordered);
      return ordered.map((agent) => ({ ...agent }));
    });
  }

  async getTranscript(sessionId, agentId) {
    return this.#locked(sessionId, async () => {
      try {
        const parsed = JSON.parse(await readFile(this.#transcriptPath(sessionId, agentId), "utf8"));
        if (parsed?.version !== VERSION || parsed?.agentId !== agentId || !Array.isArray(parsed.messages)) return null;
        return { messages: parsed.messages, nextByte: Number.isSafeInteger(parsed.nextByte) && parsed.nextByte >= 0 ? parsed.nextByte : 0, capturedAt: parsed.capturedAt };
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    });
  }

  async appendTranscript(sessionId, agentId, input) {
    const data = safeObject(input);
    const rows = Array.isArray(data?.messages) ? data.messages.filter((row) => safeObject(row)) : [];
    if (!rows.length) return;
    return this.#locked(sessionId, async () => {
      const path = this.#transcriptPath(sessionId, agentId);
      let prior = null;
      try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (parsed?.version === VERSION && parsed?.agentId === agentId && Array.isArray(parsed.messages)) prior = parsed;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const reset = data.reset === true || Number(data.fromByte ?? 0) <= 0 || !prior;
      let messages = reset ? rows : [...prior.messages];
      if (!reset) {
        const known = new Set(messages.map((row) => typeof row.id === "string" ? `id:${row.id}` : `json:${key(JSON.stringify(row))}`));
        for (const row of rows) {
          const rowKey = typeof row.id === "string" ? `id:${row.id}` : `json:${key(JSON.stringify(row))}`;
          if (!known.has(rowKey)) { known.add(rowKey); messages.push(row); }
        }
      }
      const snapshot = {
        version: VERSION,
        agentId,
        messages,
        nextByte: Number.isSafeInteger(data.nextByte) && data.nextByte >= 0
          ? data.nextByte
          : (prior?.nextByte ?? 0),
        capturedAt: new Date().toISOString(),
      };
      if (prior && JSON.stringify(snapshot.messages) === JSON.stringify(prior.messages) && snapshot.nextByte === prior.nextByte) {
        return { messages: prior.messages, nextByte: prior.nextByte };
      }
      const snapshotBytes = jsonSize(snapshot);
      if (snapshotBytes > MAX_TRANSCRIPT_BYTES) throw new Error("OMP subagent transcript size limit exceeded");
      const agents = await this.#readIndex(sessionId);
      const otherTranscriptBytes = agents.reduce((total, agent) => total + (agent.id === agentId ? 0 : Number(agent.transcriptBytes) || 0), 0);
      if (otherTranscriptBytes + snapshotBytes > MAX_SESSION_TRANSCRIPT_BYTES) throw new Error("OMP subagent session archive size limit exceeded");
      await this.#atomicWrite(path, snapshot, MAX_TRANSCRIPT_BYTES);
      const index = agents.findIndex((agent) => agent.id === agentId);
      if (index >= 0) {
        agents[index] = { ...agents[index], transcriptAvailable: true, transcriptBytes: snapshotBytes, transcriptNextByte: snapshot.nextByte, transcriptCapturedAt: snapshot.capturedAt };
        await this.#writeIndex(sessionId, agents);
      }
      return { messages: snapshot.messages, nextByte: snapshot.nextByte };
    });
  }
}
