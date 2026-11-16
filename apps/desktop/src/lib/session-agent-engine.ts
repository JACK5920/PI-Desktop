import type { SessionSummary } from "@pi-desktop/shared";
import type { DraftSessionConfiguration } from "../stores/app-state";
import {
  getAgentEngine,
  type AgentEngineId,
} from "../../../../packages/shared/src/agent-engine-registry.mjs";

type AgentEngineInput = {
  /** The conversation being shown; absent on the new-task surface. */
  session?: Pick<SessionSummary, "agentEngine"> | null;
  /** Toolbar choice retained for the not-yet-created conversation. */
  draftConfiguration?: Pick<DraftSessionConfiguration, "agentEngine"> | null;
  settingsEngine?: string | null;
};

/**
 * One resolver for every surface that must agree on which engine is live.
 *
 * The conversation's own pin outranks everything: switching engines inside a
 * chat must never leak into other chats. Only a chat that has never pinned an
 * engine (or a draft that has no conversation yet) follows the app-wide
 * default, which is what makes a brand-new window open on the last used engine.
 */
export function resolveAgentEngine(input: AgentEngineInput): AgentEngineId {
  const candidate =
    input.session?.agentEngine ??
    input.draftConfiguration?.agentEngine ??
    input.settingsEngine ??
    "pi";
  return getAgentEngine(candidate)?.id ?? "pi";
}

/** Store-shaped wrapper so components subscribe once instead of re-deriving. */
export function agentEngineForState(state: {
  activeSessionId?: string | null;
  sessions?: Array<Pick<SessionSummary, "id" | "agentEngine">>;
  draftConfiguration?: Pick<DraftSessionConfiguration, "agentEngine"> | null;
  settings?: { agentEngine?: string | null } | null;
}): AgentEngineId {
  const session = state.activeSessionId
    ? state.sessions?.find((candidate) => candidate.id === state.activeSessionId)
    : undefined;
  return resolveAgentEngine({
    session,
    draftConfiguration: state.draftConfiguration,
    settingsEngine: state.settings?.agentEngine,
  });
}

/**
 * Engine a not-yet-created conversation starts on. The user's last explicit
 * pick outranks the chat they happen to be looking at, and `settings.agentEngine`
 * is only the install-level fallback for chats that never pinned one.
 */
export function resolveNewSessionAgentEngine(state: {
  activeSessionId?: string | null;
  sessions?: Array<Pick<SessionSummary, "id" | "agentEngine">>;
  draftConfiguration?: Pick<DraftSessionConfiguration, "agentEngine"> | null;
  settings?: { agentEngine?: string | null; defaultAgentEngine?: string | null } | null;
}): AgentEngineId {
  const previous = state.activeSessionId
    ? state.sessions?.find((candidate) => candidate.id === state.activeSessionId)
    : undefined;
  const candidate =
    state.draftConfiguration?.agentEngine ??
    state.settings?.defaultAgentEngine ??
    previous?.agentEngine ??
    state.settings?.agentEngine ??
    "pi";
  return getAgentEngine(candidate)?.id ?? "pi";
}
