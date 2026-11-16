import { describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { createEventPersistence } from "./event-persistence";

describe("createEventPersistence.publishAgentEvent", () => {
  it("fans OMP stream updates to the renderer and persists the completed reply and turn", async () => {
    const rendererEvents: AgentEventEnvelope[] = [];
    const stored: Array<{ message: UiMessage; turnId?: string }> = [];
    const checkpoint = { observe: vi.fn(), flush: vi.fn(async () => {}), settleIf: vi.fn(), flushAll: vi.fn(async () => {}), dispose: vi.fn() };
    const finishTurn = vi.fn(async () => {});
    const outbox = {
      enqueue: vi.fn(async (entry: { message?: UiMessage; turnId?: string }) => {
        if (entry.message) stored.push({ message: entry.message, turnId: entry.turnId });
      }),
      flush: vi.fn(async () => {}),
      size: vi.fn(() => 0),
    };
    const activeTurns = new Map([["session-1", "turn-1"]]);
    const persistence = createEventPersistence({
      runtimeState: { host: null } as any,
      steeringReplies: new Set(),
      completionNoticeTurns: new Set(),
      activeTurns,
      activeToolCalls: new Map(),
      activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
      approvedExecutionIdsBySession: new Map(),
      approvedExecutionTurns: new Map(),
      pendingExecutionFinishes: new Map(),
      planSubmissionTurnIds: new Set(),
      planSubmissionTurnKey: (sessionId, turnId) => `${sessionId}:${turnId}`,
      inflightCheckpointer: checkpoint as any,
      persistenceOutbox: outbox as any,
      addActiveTurnUsage: vi.fn(),
      logger: { app: vi.fn() } as any,
      finishTurn,
      isStaleTerminalEvent: () => false,
      transcriptRewrite: {
        beginTranscriptRewrite: () => ({ commit: vi.fn(), rollback: vi.fn() }),
        deferTranscriptEvent: () => false,
        isStaleTranscriptEvent: () => false,
      } as any,
      finishApprovedExecution: vi.fn(async () => {}),
      emitAgentEvent: (event) => rendererEvents.push(event),
    });

    const publish = persistence.publishAgentEvent;
    publish({ sessionId: "session-1", turnId: "turn-1", ts: 1, event: { type: "message_start", message: { id: "assistant-1", role: "assistant", content: "", status: "streaming", createdAt: new Date(1).toISOString() } } });
    publish({ sessionId: "session-1", turnId: "turn-1", ts: 2, event: { type: "message_update", message: { id: "assistant-1", role: "assistant", content: "A complete reply", status: "streaming", createdAt: new Date(1).toISOString() } } });
    publish({ sessionId: "session-1", turnId: "turn-1", ts: 3, event: { type: "message_end", message: { id: "assistant-1", role: "assistant", content: "A complete reply", status: "complete", createdAt: new Date(1).toISOString() } } });
    publish({ sessionId: "session-1", turnId: "turn-1", ts: 3, event: { type: "tool_start", toolCallId: "tool-1", toolName: "Read", args: { path: "report.md" } } });
    publish({ sessionId: "session-1", turnId: "turn-1", ts: 3, event: { type: "tool_end", toolCallId: "tool-1", result: { content: "report contents" } } });
    publish({ sessionId: "session-1", turnId: "turn-1", ts: 4, event: { type: "agent_end", messageIds: ["assistant-1"] } });

    await persistence.flush();
    await vi.waitFor(() => expect(finishTurn).toHaveBeenCalledWith("session-1", "completed", undefined, { turnId: "turn-1" }));
    expect(rendererEvents.map(({ event }) => event.type)).toEqual(["message_start", "message_update", "message_end", "tool_start", "tool_end", "agent_end"]);
    expect(checkpoint.observe).toHaveBeenCalled();
    expect(checkpoint.flush).toHaveBeenCalledWith("session-1");
    expect(stored).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ id: "assistant-1", content: "A complete reply", status: "complete" }), turnId: "turn-1" }));
    expect(stored).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ id: "tool-1", toolName: "Read", toolStatus: "success" }), turnId: "turn-1" }));
  });
});
