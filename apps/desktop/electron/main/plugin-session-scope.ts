/**
 * Scope rules for plugin session events (#1754). Selection events carry
 * another project's session identity, so their recipients are scope-checked
 * against the announced session's project — the same line `session.getActive`
 * enforces on the pull side. Kept dependency free so
 * `plugin-services.test.mjs` can drive the filter directly.
 */

/** Session events whose payload describes the user's current selection. */
export const SESSION_SCOPED_EVENTS = new Set([
  "session:activated",
  "session:turnStarted",
  "session:userMessagePersisted",
]);

/**
 * Events whose payload can reveal user-message or turn activity. They require
 * the plugin process's `session.observe` grant and must not be mirrored into
 * renderer-backed docked views, whose bridge is intentionally not an
 * authorization boundary.
 */
export const SESSION_OBSERVE_PLUGIN_ONLY_EVENTS = new Set([
  "session:turnStarted",
  "session:userMessagePersisted",
]);

export function mayBroadcastSessionEventToPluginView(event: string): boolean {
  return !SESSION_OBSERVE_PLUGIN_ONLY_EVENTS.has(event);
}

/** Apply the docked-view authorization boundary at the actual delivery edge. */
export function broadcastSessionEventToPluginView(
  event: string,
  payload: unknown,
  scopeFilter: ((pluginId: string) => boolean) | undefined,
  broadcast: (
    event: string,
    payload: unknown,
    scopeFilter?: (pluginId: string) => boolean,
  ) => void,
): boolean {
  if (!mayBroadcastSessionEventToPluginView(event)) return false;
  broadcast(event, payload, scopeFilter);
  return true;
}

/**
 * The recipient filter for a session event, or `undefined` when the event
 * fans out unconditionally.
 */
export function sessionEventScopeFilter(
  event: string,
  sessionId: string | undefined,
  sessionProjects: ReadonlyMap<string, string | null>,
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean,
): ((pluginId: string) => boolean) | undefined {
  if (!SESSION_SCOPED_EVENTS.has(event)) return undefined;
  return (pluginId: string) =>
    pluginActiveInProject(
      pluginId,
      (sessionId && sessionProjects.get(sessionId)) ?? null,
    );
}
