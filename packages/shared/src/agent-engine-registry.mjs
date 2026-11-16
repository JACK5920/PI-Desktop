/**
 * Shared Agent engine catalog and provider compatibility contract.
 *
 * Keep engine choices, compatibility checks, and runtime protocol translation
 * anchored here so the composer, settings, and Electron Main cannot drift.
 */
export const AGENT_ENGINE_REGISTRY = Object.freeze([
  Object.freeze({
    id: "pi",
    nameKey: "settings.omp.enginePi",
    descriptionKey: "settings.agentEngines.piDescription",
    managed: false,
  }),
  Object.freeze({
    id: "omp",
    nameKey: "settings.omp.engineOmp",
    descriptionKey: "settings.agentEngines.ompDescription",
    managed: true,
  }),
]);

export function getAgentEngine(engineId) {
  return AGENT_ENGINE_REGISTRY.find((engine) => engine.id === engineId) ?? null;
}
