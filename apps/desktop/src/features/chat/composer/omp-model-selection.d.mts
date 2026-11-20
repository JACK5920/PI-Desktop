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

export type OmpModelOption = {
  provider: string;
  id: string;
  name?: string;
  providerName?: string;
  contextWindow?: number;
};

export type OmpCustomProviderDisplayName = {
  providerId: string;
  providerName: string;
};

export function mapOmpProviderDisplayNames(
  models: readonly OmpModelOption[],
  customProviders: readonly OmpCustomProviderDisplayName[],
): OmpModelOption[];
export function ompProviderDisplayName(model: OmpModelOption): string;
export function filterOmpModelsBySearch(models: readonly OmpModelOption[], query: string): OmpModelOption[];
export function groupOmpModelsByProvider(models: readonly OmpModelOption[]): Array<{
  provider: string;
  displayName: string;
  models: OmpModelOption[];
}>;
export function toOmpRpcModelIdentity(model: OmpModelOption): { provider: string; modelId: string };
