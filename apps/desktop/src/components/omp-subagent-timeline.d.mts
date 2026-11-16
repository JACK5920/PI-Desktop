export function buildOmpSubagentTimeline(messages: unknown[], agentStatus?: string): Array<Record<string, any>>;
export function ompSubagentIdentity(agent: Record<string, any>, index: number, fallback?: string, peers?: Array<Record<string, any>>): string;
export function ompSubagentTaskSummary(agent: Record<string, any>): string;
export function ompSubagentProgressSummary(agent: Record<string, any>): string;
export function ompSubagentTaskDetail(agent: Record<string, any>): string;
export function ompSubagentStatusKey(status: unknown): string;
export function ompSubagentLifecycleStatus(agent: Record<string, any> | null | undefined): string;
export function ompSubagentTranscriptOutcome(messages: unknown): "completed" | "failed" | "aborted" | "";
