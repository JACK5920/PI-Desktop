import { ompSubagentsFromTaskFrame } from "../../shared/omp-subagent-progress.mjs";

/** Persist authoritative Task-result child identities before the live roster can disappear. */
export async function archiveOmpTaskProgress(archive, sessionId, frame) {
  const agents = ompSubagentsFromTaskFrame(frame);
  await Promise.all(agents.map((agent) => archive.upsertAgent(sessionId, agent)));
  return agents.map((agent) => agent.id);
}
