import { afterEach, describe, expect, it, vi } from "vitest";
import { runComputerLoop as runBoundedComputerLoop } from "@pi-desktop/computer-use";
import { IPC, type ComputerGrantView } from "@pi-desktop/shared";
import type { IpcMainInvokeEvent } from "electron";

const computerRuntime = vi.hoisted(() => ({ completeOneShot: vi.fn(), runComputerLoop: vi.fn() }));
vi.mock("electron", () => ({
  desktopCapturer: { getSources: vi.fn() },
}));
vi.mock("@pi-desktop/agent-runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pi-desktop/agent-runtime")>(),
  ...computerRuntime,
}));

import { createComputerUseTool } from "./agent-tool";
import { captureSourceIdFor } from "./capture";
import {
  getActiveComputerUseRun,
  publishComputerUseRun,
  subscribeComputerUseActivity,
} from "./active-run";
import { registerComputerUseIpc } from "../ipc/computer-use-ipc";
import type { IpcRegistrar } from "../ipc/types";
import type { HostProcess } from "../host-process";

const grant = {
  grantId: "grant-1", revision: 1, scope: "desktop", targetId: "window-1",
  targetLabel: "Test app", appKey: "test-app", bounds: { x: 0, y: 0, width: 800, height: 600 },
  inputPolicy: "autonomous-in-scope", capture: "a11y-only", remainingBudget: 4,
  sessionId: "session-1", createdAt: "2026-11-07T00:00:00Z", expiresAt: "2026-11-07T00:15:00Z", state: "active",
} as const;

function hostFixture(enabled = true, configuredModel = true) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const host = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "settings.get") return { computerUse: { enabled, ...(configuredModel ? { model: { providerId: "p", modelId: "m" } } : {}) } } as T;
      if (method === "computer.grantCreate") return grant as T;
      if (method === "computer.inspect") return {
        grantId: grant.grantId, revision: 1, bounds: grant.bounds, fidelity: "full",
        nodes: [{ uid: "button-1", role: "button", label: "Continue", hasValue: false, enabled: true, focused: false, bounds: { x: 10, y: 10, width: 80, height: 30 }, actions: ["click"] }],
        truncated: false, secureInput: false,
      } as T;
      if (method === "computer.grantDescribe") return { grant } as T;
      if (method === "computer.listTargets") return { targets: [] } as T;
      if (method === "computer.act") return { grantId: grant.grantId, revision: 1, remainingBudget: 3, dispatched: "accessibility-action" } as T;
      return { revoked: true } as T;
    },
  };
  return { host, calls };
}

afterEach(() => {
  publishComputerUseRun(null);
  computerRuntime.completeOneShot.mockReset();
  computerRuntime.runComputerLoop.mockReset();
});

describe("Computer local tool", () => {
  it("matches pixel capture to the exact native window and never substitutes another source", () => {
    const sources = [{ id: "window:4242:0" }, { id: "window:9001:0" }, { id: "screen:0:0" }];
    expect(captureSourceIdFor(sources, "101:4242")).toBe("window:4242:0");
    expect(captureSourceIdFor(sources, "101:7777")).toBeUndefined();
    expect(captureSourceIdFor(sources, "invalid")).toBeUndefined();
  });

  it("refuses pixel capture while Host reports secure input", async () => {
    const capture = vi.fn(async () => ({ mimeType: "image/png", base64: "must-not-leave-host" }));
    computerRuntime.runComputerLoop.mockImplementation(runBoundedComputerLoop);
    const host = {
      async call<T>(method: string): Promise<T> {
        if (method === "settings.get") return { computerUse: {
          enabled: true,
          defaultCapture: "a11y-and-pixels",
          model: { providerId: "p", modelId: "m" },
        } } as T;
        if (method === "computer.grantCreate") return { ...grant, capture: "a11y-and-pixels" } as T;
        if (method === "computer.inspect") return {
          grantId: grant.grantId, revision: 1, bounds: grant.bounds, fidelity: "full",
          nodes: [], truncated: false, secureInput: true,
        } as T;
        if (method === "computer.grantDescribe") return { grant: { ...grant, capture: "a11y-and-pixels" } } as T;
        if (method === "computer.listTargets") return { targets: [] } as T;
        if (method === "computer.grantRevoke") return { revoked: true } as T;
        throw new Error(`Unexpected Host RPC: ${method}`);
      },
    };
    const handler = createComputerUseTool({
      getHost: () => host,
      resolveProvider: async () => ({
        id: "p", name: "Pinned", modelId: "m", apiKey: "fixture-only",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      }),
      capture,
    });

    const result = await handler({
      sessionId: "session-1",
      toolCallId: "tool-secure-input",
      args: { instruction: "Inspect the fixture" },
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(computerRuntime.completeOneShot).not.toHaveBeenCalled();
  });

  it("sends an explicitly enabled target-window capture to its bound model and draws the cursor events", async () => {
    const capture = vi.fn(async () => ({ mimeType: "image/png", base64: "fixture-pixels" }));
    const applyCursor = vi.fn();
    const content: unknown[] = [];
    computerRuntime.runComputerLoop.mockImplementation(async (_input, deps) => {
      const observation = await deps.observe();
      await deps.decide({
        system: "system",
        instruction: "Inspect the fixture",
        observation: "fixture observation",
        history: "",
        capture: observation.capture,
      });
      deps.onCursor?.({ kind: "show", grantId: grant.grantId, bounds: grant.bounds });
      return { outcome: "done", summary: "inspected", steps: [] };
    });
    computerRuntime.completeOneShot.mockImplementation(async (_provider, context) => {
      content.push(context.messages[0].content);
      return { text: JSON.stringify({ kind: "done", summary: "inspected" }) };
    });
    const host = {
      async call<T>(method: string, params?: unknown): Promise<T> {
        if (method === "settings.get") return { computerUse: {
          enabled: true,
          defaultCapture: "a11y-and-pixels",
          model: { providerId: "p", modelId: "m" },
        } } as T;
        if (method === "computer.grantCreate") return { ...grant, capture: "a11y-and-pixels" } as T;
        if (method === "computer.inspect") return {
          grantId: grant.grantId, revision: 1, bounds: grant.bounds, fidelity: "full",
          nodes: [], truncated: false, secureInput: false,
        } as T;
        if (method === "computer.grantDescribe") return { grant: { ...grant, capture: "a11y-and-pixels" } } as T;
        if (method === "computer.listTargets") return { targets: [] } as T;
        if (method === "computer.grantRevoke") return { revoked: true } as T;
        throw new Error(`Unexpected Host RPC: ${method} ${JSON.stringify(params)}`);
      },
    };
    const handler = createComputerUseTool({
      getHost: () => host,
      resolveProvider: async () => ({
        id: "p", name: "Pinned", modelId: "m", apiKey: "fixture-only",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      }),
      capture,
      cursorOverlay: { apply: applyCursor },
    });

    const result = await handler({
      sessionId: "session-1",
      toolCallId: "tool-pixels",
      args: { instruction: "Inspect the fixture" },
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ targetId: grant.targetId, bounds: grant.bounds }));
    expect(content[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image", data: "fixture-pixels", mimeType: "image/png" }),
    ]));
    expect(applyCursor).toHaveBeenCalledWith(expect.objectContaining({ kind: "show", grantId: grant.grantId }));
  });

  it("runs a bounded host-backed action loop with the dedicated provider and revokes its grant", async () => {
    computerRuntime.runComputerLoop.mockImplementation(async (_input, deps) => {
      deps.onActivity({ phase: "observing", stepIndex: 0 });
      await deps.observe();
      deps.onActivity({ phase: "acting", stepIndex: 1, action: "click", target: "Continue" });
      await deps.act({ kind: "click", uid: "button-1" }, 1);
      deps.onStep({ index: 0, action: "click", ok: true, target: "Continue" });
      await deps.decide({ system: "system", instruction: "Continue", observation: "fixture", history: "" });
      return { outcome: "done", summary: "continued", steps: [] };
    });
    computerRuntime.completeOneShot.mockResolvedValue({ text: JSON.stringify({ kind: "done", summary: "continued" }) });
    const { host, calls } = hostFixture();
    const handler = createComputerUseTool({ getHost: () => host, resolveProvider: async () => ({
      id: "p", name: "Pinned", modelId: "m", apiKey: "key", supportsReasoning: false, supportedThinkingLevels: ["off"],
    }) });
    const activities: unknown[] = [];
    const unsubscribe = subscribeComputerUseActivity((activity) => activities.push(activity));

    const result = await handler({ sessionId: "session-1", toolCallId: "tool-1", args: { instruction: "Continue" }, signal: new AbortController().signal });

    expect(result.ok).toBe(true);
    expect(calls.map(({ method }) => method)).toContain("computer.act");
    expect(calls.at(-1)?.method).toBe("computer.grantRevoke");
    expect(computerRuntime.completeOneShot).toHaveBeenCalledOnce();
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "acting", action: "click", target: "Continue" }),
      expect.objectContaining({ phase: "completed" }),
    ]));
    expect(getActiveComputerUseRun()).toBeNull();
    unsubscribe();
  });

  it("re-observes the real Host state after dispatch before the model can finish", async () => {
    computerRuntime.runComputerLoop.mockImplementation(runBoundedComputerLoop);
    let clicked = false;
    let revision = 1;
    let remainingBudget = 4;
    const hostCalls: Array<{ method: string; params: unknown }> = [];
    const host = {
      async call<T>(method: string, params?: unknown): Promise<T> {
        hostCalls.push({ method, params });
        if (method === "settings.get") return { computerUse: { enabled: true, model: { providerId: "p", modelId: "m" } } } as T;
        if (method === "computer.grantCreate") return { ...grant, revision } as T;
        if (method === "computer.inspect") return {
          grantId: grant.grantId,
          revision,
          bounds: grant.bounds,
          fidelity: "full",
          nodes: [{
            uid: "button-1",
            role: "button",
            label: clicked ? "Continued" : "Continue",
            hasValue: false,
            enabled: true,
            focused: false,
            bounds: { x: 10, y: 10, width: 80, height: 30 },
            actions: ["click"],
          }],
          truncated: false,
          secureInput: false,
        } as T;
        if (method === "computer.grantDescribe") return { grant: { ...grant, revision, remainingBudget } } as T;
        if (method === "computer.listTargets") return { targets: [{
          targetId: grant.targetId,
          appName: "Fixture",
          title: "Computer Use State Fixture",
          appKey: "fixture",
          bounds: grant.bounds,
        }] } as T;
        if (method === "computer.act") {
          const input = params as { action?: { kind?: string; uid?: string }; expectedRevision?: number };
          expect(input.expectedRevision).toBe(revision);
          expect(input.action).toEqual({ kind: "click", uid: "button-1" });
          clicked = true;
          revision += 1;
          remainingBudget -= 1;
          return { grantId: grant.grantId, revision, remainingBudget, dispatched: "accessibility-action" } as T;
        }
        if (method === "computer.grantRevoke") return { revoked: true } as T;
        throw new Error(`Unexpected Host RPC: ${method}`);
      },
    };
    const observations: string[] = [];
    let modelCalls = 0;
    computerRuntime.completeOneShot.mockImplementation(async (_provider: unknown, context: { messages: Array<{ content: unknown }> }) => {
      const content = context.messages[0]?.content;
      const message = typeof content === "string" ? content : "";
      observations.push(message);
      modelCalls += 1;
      if (!clicked) return { text: '{"kind":"action","action":{"kind":"click","uid":"button-1"}}' };
      expect(message).toContain('"Continued"');
      return { text: '{"kind":"done","summary":"the fixture changed"}' };
    });
    const handler = createComputerUseTool({
      getHost: () => host,
      resolveProvider: async () => ({
        id: "p", name: "Pinned", modelId: "m", apiKey: "fixture-only",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      }),
    });

    const result = await handler({
      sessionId: "session-1",
      toolCallId: "tool-state-verification",
      args: { instruction: "Continue the fixture" },
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    expect(modelCalls).toBe(2);
    expect(observations[0]).toContain('"Continue"');
    expect(observations[1]).toContain('"Continued"');
    expect(hostCalls.filter((call) => call.method === "computer.inspect")).toHaveLength(2);
    expect(hostCalls.filter((call) => call.method === "computer.act")).toHaveLength(1);
    expect(hostCalls.at(-1)?.method).toBe("computer.grantRevoke");
  });

  it("fails closed when Computer Use is disabled without minting a grant", async () => {
    const { host, calls } = hostFixture(false);
    const handler = createComputerUseTool({ getHost: () => host, resolveProvider: vi.fn() });
    const result = await handler({ sessionId: "session-1", toolCallId: "tool-2", args: { instruction: "Continue" }, signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, errorCode: "COMPUTER_DISABLED" });
    expect(calls.some(({ method }) => method === "computer.grantCreate")).toBe(false);
  });

  it("requires the separately configured model instead of falling back to the chat model", async () => {
    const { host, calls } = hostFixture(true, false);
    const resolveProvider = vi.fn();
    const handler = createComputerUseTool({ getHost: () => host, resolveProvider });
    const result = await handler({ sessionId: "session-1", toolCallId: "tool-3", args: { instruction: "Continue" }, signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, errorCode: "COMPUTER_MODEL_NOT_CONFIGURED" });
    expect(resolveProvider).toHaveBeenCalledOnce();
    expect(calls.some(({ method }) => method === "computer.grantCreate")).toBe(false);
  });

  it("revokes the live Host grant and aborts only its owning session when Stop is used", async () => {
    let liveGrant: ComputerGrantView | null = null;
    const calls: Array<{ method: string; params: unknown }> = [];
    const revokeReasons: string[] = [];
    const lifecycleOrder: string[] = [];
    const host = {
      async call<T>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, params });
        if (method === "settings.get") {
          return { computerUse: { enabled: true, model: { providerId: "p", modelId: "m" } } } as T;
        }
        if (method === "computer.grantCreate") {
          liveGrant = { ...grant, sessionId: "session-owner" };
          return liveGrant as T;
        }
        if (method === "computer.inspect") {
          return {
            grantId: grant.grantId,
            revision: grant.revision,
            bounds: grant.bounds,
            fidelity: "full",
            nodes: [],
            truncated: false,
            secureInput: false,
          } as T;
        }
        if (method === "computer.grantDescribe") return { grant: liveGrant } as T;
        if (method === "computer.listTargets") return { targets: [] } as T;
        if (method === "computer.grantRevoke") {
          const reason = (params as { reason?: unknown } | undefined)?.reason;
          if (typeof reason === "string") {
            revokeReasons.push(reason);
            lifecycleOrder.push(`revoke:${reason}`);
          }
          liveGrant = null;
          return { revoked: true } as T;
        }
        throw new Error(`Unexpected Host RPC: ${method}`);
      },
    };

    const ownerController = new AbortController();
    const otherSessionController = new AbortController();
    const abortCalls: string[] = [];
    let resolveDecisionStarted!: () => void;
    const decisionStarted = new Promise<void>((resolve) => { resolveDecisionStarted = resolve; });

    computerRuntime.runComputerLoop.mockImplementation(runBoundedComputerLoop);
    computerRuntime.completeOneShot.mockImplementation((...args: unknown[]) => {
      const options = args[3] as { signal: AbortSignal };
      resolveDecisionStarted();
      return new Promise<never>((_resolve, reject) => {
        if (options.signal.aborted) {
          reject(options.signal.reason);
          return;
        }
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    });

    const executeComputer = createComputerUseTool({
      getHost: () => host,
      resolveProvider: async () => ({
        id: "p",
        name: "Pinned",
        modelId: "m",
        apiKey: "fixture-only",
        supportsReasoning: false,
        supportedThinkingLevels: ["off"],
      }),
    });
    const pendingRun = executeComputer({
      sessionId: "session-owner",
      toolCallId: "tool-owner",
      args: { instruction: "Inspect the fixture" },
      signal: ownerController.signal,
    });
    await decisionStarted;

    expect(getActiveComputerUseRun()).toMatchObject({
      sessionId: "session-owner",
      toolCallId: "tool-owner",
      grant: { grantId: "grant-1", sessionId: "session-owner" },
    });

    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const registrar: IpcRegistrar = {
      ipcMain: {} as IpcRegistrar["ipcMain"],
      handle: () => undefined,
      handleWithEvent(channel, handler) {
        handlers.set(channel, (event, ...args) => handler(event as IpcMainInvokeEvent, ...args));
      },
      assertMainWindowSender: () => { throw new Error("Computer widget must be authorized by its owner"); },
    };
    registerComputerUseIpc({
      registrar,
      getHost: () => host as unknown as HostProcess,
      abortAgentRun: async (sessionId) => {
        abortCalls.push(sessionId);
        lifecycleOrder.push(`abort:${sessionId}`);
        if (sessionId === "session-owner") ownerController.abort();
        if (sessionId === "session-other") otherSessionController.abort();
      },
      widget: { owns: (webContentsId) => webContentsId === 73 },
    });
    const stop = handlers.get(IPC.invoke.computerGrantRevoke);
    if (!stop) throw new Error("Computer Stop IPC handler was not registered");
    const event = { sender: { id: 73 } };

    const wrongOwner = await stop(event, { sessionId: "session-other", grantId: "grant-1" });
    expect(wrongOwner).toEqual({ revoked: false, requested: false });
    expect(revokeReasons).toEqual([]);
    expect(abortCalls).toEqual([]);

    const stopped = await stop(event, { sessionId: "session-owner", grantId: "grant-1" });
    expect(stopped).toEqual({ revoked: true, requested: true });
    await expect(pendingRun).rejects.toMatchObject({ name: "AbortError" });

    expect(liveGrant).toBeNull();
    expect(revokeReasons[0]).toBe("user");
    expect(lifecycleOrder.slice(0, 2)).toEqual(["revoke:user", "abort:session-owner"]);
    expect(abortCalls).toEqual(["session-owner"]);
    expect(ownerController.signal.aborted).toBe(true);
    expect(otherSessionController.signal.aborted).toBe(false);
    expect(getActiveComputerUseRun()).toBeNull();
    expect(calls.some(({ method }) => method === "computer.inspect")).toBe(true);
  });
});
