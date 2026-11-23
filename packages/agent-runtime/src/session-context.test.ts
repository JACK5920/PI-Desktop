import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import { convertToLlm, textFromContent } from "./pi-runtime-messages.js";
import type { CompactionEntry, MessageEntry } from "./pi-runtime-types.js";
import { buildSessionContext } from "./session-context.js";

function user(id: string, text: string, seq: number): MessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    seq,
    timestamp: seq,
    message: { role: "user", content: text, timestamp: seq },
  };
}

function assistant(
  id: string,
  text: string,
  seq: number,
  stopReason: "stop" | "error" | "aborted" = "stop",
): MessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    seq,
    timestamp: seq,
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "local",
      model: "local",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: seq,
      content: [{ type: "text", text }],
    } as AgentMessage,
  };
}

function compaction(
  id: string,
  seq: number,
  tail: AgentMessage[] = [],
): CompactionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    seq,
    timestamp: seq,
    summary: "older work",
    tokensBefore: 100,
    retainedTail: tail,
    fromHook: false,
  };
}

describe("buildSessionContext", () => {
  it("passes message entries through and drops failed assistants", () => {
    const messages = buildSessionContext([
      user("u1", "hello", 0),
      assistant("a1", "failed", 1, "error"),
      assistant("a2", "ok", 2),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(
      messages[1] && "content" in messages[1]
        ? (messages[1].content as { text?: string }[])[0]?.text
        : undefined,
    ).toBe("ok");
  });

  it("drops assistants that have no content blocks", () => {
    // D446: an accepted silent completion reply, or any other empty
    // assistant, is not worth resending and would be rejected by providers.
    const empty = assistant("a1", "", 1);
    (empty.message as { content: unknown[] }).content = [];
    const messages = buildSessionContext([
      user("u1", "notice", 0),
      empty,
      user("u2", "next", 2),
      assistant("a2", "answer", 3),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
  });

  it("slices from the newest compaction and puts the summary before the tail", () => {
    const keptUser = user("u2", "keep me", 3).message;
    const messages = buildSessionContext([
      user("u0", "old", 0),
      assistant("a0", "old answer", 1),
      compaction("c1", 2, [keptUser]),
      user("u3", "next", 3),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "user",
    ]);
    expect(JSON.stringify(messages)).toContain("older work");
    expect(JSON.stringify(messages)).toContain("keep me");
    expect(JSON.stringify(messages)).toContain("next");
    expect(JSON.stringify(messages)).not.toContain("old answer");
  });

  it("replays retained reasoning between the summary and the user tail", () => {
    // #296
    const keptUser = user("u2", "keep me", 3).message;
    const entry = compaction("c1", 2, [keptUser]);
    entry.details = {
      retainedReasoning: [{ thinking: "prior plan", text: "prior answer" }],
    };
    const messages = buildSessionContext([
      user("u0", "old", 0),
      assistant("a0", "old answer", 1),
      entry,
      user("u3", "next", 3),
    ]).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
      "user",
      "user",
    ]);
    expect(JSON.stringify(messages)).toContain("prior plan");
    expect(JSON.stringify(messages)).toContain("keep me");
    expect(JSON.stringify(messages)).not.toContain("old answer");
  });

  it("does not replay DeepSeek reasoning into a different provider", () => {
    const keptUser = user("u2", "keep me", 3).message;
    const entry = compaction("c1", 2, [keptUser]);
    entry.details = {
      retainedReasoning: [{ thinking: "prior DeepSeek plan", text: "answer" }],
    };
    const messages = buildSessionContext(
      [entry, user("u3", "next", 4)],
      {
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-6",
        requiresCompletionsReasoningReplay: false,
      },
    ).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "user",
    ]);
    expect(JSON.stringify(messages)).not.toContain("prior DeepSeek plan");
  });

  it("places a successful active-turn checkpoint after its original request", () => {
    const entry = compaction("active", 2, [user("u1", "finish the migration", 1).message]);
    entry.details = { retainedTailMode: "active_turn" };
    const messages = buildSessionContext([entry]).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "compactionSummary",
    ]);
    expect(messages[1]).toMatchObject({ role: "compactionSummary", resumeActiveTurn: true });
    const providerMessages = convertToLlm(messages);
    expect(textFromContent(providerMessages[1]?.content)).toContain(
      "checkpoint is newer than the original request above",
    );
  });

  it("keeps fallback checkpoints in summary-first order", () => {
    const entry = compaction("fallback", 2, [user("u1", "continue", 1).message]);
    entry.details = {
      retainedTailMode: "active_turn",
      fallback: "retained_tail",
    };
    const messages = buildSessionContext([entry]).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
    ]);
    expect(messages[0]).not.toHaveProperty("resumeActiveTurn");
    expect(textFromContent(convertToLlm(messages)[0]?.content)).toContain(
      "conversation history before this point was compacted",
    );
  });

  it("keeps summary-first order when retained reasoning must be replayed", () => {
    const entry = compaction("reasoning", 2, [user("u1", "continue", 1).message]);
    entry.details = {
      retainedTailMode: "active_turn",
      retainedReasoning: [{ thinking: "prior reasoning", text: "prior answer" }],
    };
    const messages = buildSessionContext([entry], {
      api: "openai-completions",
      provider: "deepseek",
      model: "deepseek-reasoner",
      requiresCompletionsReasoningReplay: true,
    }).messages;
    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "assistant",
      "user",
    ]);
    expect(messages[0]).not.toHaveProperty("resumeActiveTurn");
  });

});
