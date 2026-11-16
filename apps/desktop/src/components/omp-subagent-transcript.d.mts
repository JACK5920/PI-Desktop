import type { SubagentTranscriptDisplayTurn } from "./workpanel/SubagentTranscriptContent";

export function buildOmpSubagentTranscriptTurns(
  messages: unknown[],
  agentStatus?: string,
  labels?: { unlinkedResult?: string; image?: string },
  assignedTask?: string,
): SubagentTranscriptDisplayTurn[];
