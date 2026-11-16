export type AgentEngineId = "pi" | "omp";
export type AgentEngineRegistryEntry = {
  id: AgentEngineId;
  nameKey: string;
  descriptionKey: string;
  managed: boolean;
};
export const AGENT_ENGINE_REGISTRY: ReadonlyArray<AgentEngineRegistryEntry>;
export function getAgentEngine(engineId: string): AgentEngineRegistryEntry | null;
