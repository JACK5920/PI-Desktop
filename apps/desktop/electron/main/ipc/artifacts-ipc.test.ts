import { describe, expect, it, vi } from "vitest";
import { IPC } from "@pi-desktop/shared";
import { registerArtifactsIpc } from "./artifacts-ipc.js";
import type { IpcRegistrar } from "./types.js";

describe("artifacts IPC", () => {
  it("requires a session and clamps list size before calling the host", async () => {
    let handler: ((payload: unknown) => Promise<unknown>) | undefined;
    const registrar = {
      handle: vi.fn((channel: string, callback: (payload: unknown) => Promise<unknown>) => {
        expect(channel).toBe(IPC.invoke.artifactList);
        handler = callback;
      }),
    } as unknown as IpcRegistrar;
    const call = vi.fn(async (method: string, params: unknown) => ({ method, params }));
    registerArtifactsIpc({ registrar, getHost: () => ({ call } as never) });

    await expect(handler?.({ limit: 20 })).rejects.toThrow("session id required");
    await expect(handler?.({ sessionId: "s1", limit: 0 })).rejects.toThrow("positive integer");
    await expect(handler?.({ sessionId: "s1", limit: "500" })).rejects.toThrow("positive integer");
    await expect(handler?.({ sessionId: "s1", turnId: 4 })).rejects.toThrow("turn id");
    await expect(handler?.({ sessionId: "s1", offset: -1 })).rejects.toThrow("non-negative integer");
    await expect(handler?.({ sessionId: " s1 " })).resolves.toEqual({
      method: "artifacts.list",
      params: { sessionId: "s1", limit: 200, offset: 0 },
    });
    await expect(handler?.({ sessionId: "s1", limit: 900 })).resolves.toEqual({
      method: "artifacts.list",
      params: { sessionId: "s1", limit: 500, offset: 0 },
    });
    await expect(handler?.({ sessionId: " s1 ", turnId: " t1 " })).resolves.toEqual({
      method: "artifacts.list",
      params: { sessionId: "s1", limit: 200, offset: 0, turnId: "t1" },
    });
    await expect(handler?.({ sessionId: "s1", offset: 30 })).resolves.toEqual({
      method: "artifacts.list",
      params: { sessionId: "s1", limit: 200, offset: 30 },
    });
    expect(call).toHaveBeenCalledTimes(4);
  });

  it("does not silently fall back when the host is unavailable", async () => {
    let handler: ((payload: unknown) => Promise<unknown>) | undefined;
    const registrar = {
      handle: vi.fn((_channel: string, callback: (payload: unknown) => Promise<unknown>) => {
        handler = callback;
      }),
    } as unknown as IpcRegistrar;
    registerArtifactsIpc({ registrar, getHost: () => null });
    await expect(handler?.({ sessionId: "s1" })).rejects.toThrow("host unavailable");
  });
});
