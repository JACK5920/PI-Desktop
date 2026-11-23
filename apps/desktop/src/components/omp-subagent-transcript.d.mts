import type { SubagentTranscriptDisplayTurn } from "./workpanel/SubagentTranscriptContent";

export function buildOmpSubagentTranscriptTurns(
  messages: unknown[],
  agentStatus?: string,
  labels?: { unlinkedResult?: string; image?: string },
  assignedTask?: string,
): SubagentTranscriptDisplayTurn[];
export function getOmpSubagentConclusion(
  turns: SubagentTranscriptDisplayTurn[],
  deliveryOutput: string,
): { content: string; source: "delivery" | "transcript" } | null;
