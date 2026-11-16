import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type ArtifactsIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
};

function listInput(payload: unknown): { sessionId: string; limit: number; offset: number; turnId?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("artifact session id required");
  }
  const input = payload as Record<string, unknown>;
  if (typeof input.sessionId !== "string" || !input.sessionId.trim()) {
    throw new Error("artifact session id required");
  }
  const requested = input.limit === undefined ? 200 : input.limit;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    throw new Error("artifact limit must be a positive integer");
  }
  if (input.turnId !== undefined && (typeof input.turnId !== "string" || !input.turnId.trim())) {
    throw new Error("artifact turn id must be a non-empty string");
  }
  const offset = input.offset === undefined ? 0 : input.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("artifact offset must be a non-negative integer");
  }
  return { sessionId: input.sessionId.trim(), limit: Math.min(requested, 500), offset, ...(typeof input.turnId === "string" ? { turnId: input.turnId.trim() } : {}) };
}

/** List only artifacts belonging to the explicitly selected local session. */
export function registerArtifactsIpc({ registrar, getHost }: ArtifactsIpcDependencies): void {
  registrar.handle(IPC.invoke.artifactList, async (payload: unknown) => {
    const params = listInput(payload);
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("artifacts.list", params);
  });
}
