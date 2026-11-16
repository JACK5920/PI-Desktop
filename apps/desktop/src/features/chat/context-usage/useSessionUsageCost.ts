import { useEffect, useState } from "react";
import type { SessionUsageCost } from "@pi-desktop/shared";
import { api } from "../../../lib/api";

export type SessionUsageCostState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: SessionUsageCost };

type Loaded = { sessionId: string; key: string; state: SessionUsageCostState };

/** Loads the full host ledger: the renderer may only hold a transcript window. */
export function useSessionUsageCost({
  enabled,
  sessionId,
  refreshKey,
}: {
  enabled: boolean;
  sessionId?: string;
  refreshKey: string;
}): SessionUsageCostState | undefined {
  const [loaded, setLoaded] = useState<Loaded>();

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let current = true;
    api.getSessionUsageCost(sessionId).then(
      (data) => {
        if (current) setLoaded({ sessionId, key: refreshKey, state: { status: "ready", data } });
      },
      () => {
        if (current) setLoaded({ sessionId, key: refreshKey, state: { status: "error" } });
      },
    );
    return () => { current = false; };
  }, [enabled, refreshKey, sessionId]);

  if (!enabled || !sessionId) return undefined;
  if (loaded?.sessionId !== sessionId) return { status: "loading" };
  if (loaded.key !== refreshKey && loaded.state.status !== "ready") return { status: "loading" };
  return loaded.state;
}
