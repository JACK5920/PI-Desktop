import type { OmpThinkingLevel } from "../../../lib/api";

type OmpRpcCommandInput = {
  sessionId: string;
  command: string;
  fields?: Record<string, unknown>;
};

export function selectOmpModelAndRefreshThinkingLevels(input: {
  rpcCommand: (input: OmpRpcCommandInput) => Promise<unknown>;
  sessionId: string;
  provider: string;
  modelId: string;
  onModelApplied?: () => void;
  onThinkingLevels?: (levels: OmpThinkingLevel[]) => void;
}): Promise<OmpThinkingLevel[]>;

export function readOmpThinkingLevels(input: {
  rpcCommand: (input: OmpRpcCommandInput) => Promise<unknown>;
  sessionId: string;
  onThinkingLevels?: (levels: OmpThinkingLevel[]) => void;
}): Promise<OmpThinkingLevel[]>;
