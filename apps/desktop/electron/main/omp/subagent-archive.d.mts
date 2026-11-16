export class OmpSubagentArchive {
  constructor(root: string);
  getRoster(sessionId: string): Promise<Array<Record<string, any>>>;
  getAgentMeta(sessionId: string, agentId: string): Promise<Record<string, any> | null>;
  upsertAgent(sessionId: string, agent: Record<string, any>): Promise<void>;
  mergeRoster(sessionId: string, incoming: Array<Record<string, any>>): Promise<Array<Record<string, any>>>;
  getTranscript(sessionId: string, agentId: string): Promise<{ messages: Array<Record<string, any>>; nextByte: number; capturedAt?: string } | null>;
  appendTranscript(sessionId: string, agentId: string, input: Record<string, any>): Promise<{ messages: Array<Record<string, any>>; nextByte: number } | undefined>;
}
