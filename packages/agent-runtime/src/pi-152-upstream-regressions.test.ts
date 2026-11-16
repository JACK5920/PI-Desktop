import {
  isRetryableAssistantError,
  normalizeContext,
  type AssistantMessage,
  type Message,
  type Model,
  type Tool,
} from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { Type } from "typebox";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { agentLoop } from "@earendil-works/pi-agent-core";

const anthropicModel: Model<"anthropic-messages"> = {
  id: "claude-fixture",
  name: "Anthropic fixture",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const openAiCompletionsModel: Model<"openai-completions"> = {
  id: "copilot-fixture",
  name: "Copilot fixture",
  api: "openai-completions",
  provider: "github-copilot",
  baseUrl: "https://fixture.invalid/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function completedAnthropicResponse(): Response {
  const events = [
    { type: "message_start", message: { id: "reply", type: "message", role: "assistant", model: anthropicModel.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Pi 1.5.2 upstream regression adoption", () => {
  it("classifies a gateway's exact Connection closed message as retryable", () => {
    const failure = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage: "Connection closed.",
      timestamp: 1,
    } as AssistantMessage;
    expect(isRetryableAssistantError(failure)).toBe(true);
  });

  it("keeps the tail of a single oversized output line", async () => {
    const modulePath = fileURLToPath(new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/output-accumulator.js",
      import.meta.url,
    ));
    const { OutputAccumulator } = await import(pathToFileURL(modulePath).href) as {
      OutputAccumulator: new (options: { maxBytes: number; maxLines: number }) => {
        append(data: Buffer): void;
        finish(): void;
        snapshot(): { content: string };
      };
    };
    const accumulator = new OutputAccumulator({ maxBytes: 50, maxLines: 10 });
    accumulator.append(Buffer.from(`short line\n${"z".repeat(240)}\n`));
    accumulator.finish();
    const snapshot = accumulator.snapshot();
    expect(snapshot.content).not.toBe("");
    expect(snapshot.content).toContain("z".repeat(40));
  });

  it("emits one result for every sequential tool call when Stop arrives mid-batch", async () => {
    const controller = new AbortController();
    const calls = ["first", "second"].map((name, index) => ({
      type: "toolCall",
      id: `call-${index + 1}`,
      name,
      arguments: {},
    }));
    const assistant = {
      role: "assistant",
      content: calls,
      api: "anthropic-messages",
      provider: "fixture",
      model: anthropicModel.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 1,
    } as AssistantMessage;
    const tools = calls.map((call, index) => ({
      name: call.name,
      label: call.name,
      description: "Fixture tool",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        if (index === 0) controller.abort();
        return { content: [{ type: "text", text: call.name }] };
      },
    }));
    let streamCount = 0;
    const streamFn = () => {
      streamCount += 1;
      const response = streamCount === 1
        ? assistant
        : { ...assistant, content: [{ type: "text", text: "stopped" }], stopReason: "stop" };
      return Object.assign((async function* () {
        yield { type: "start", partial: { ...response, stopReason: "pending" } };
        yield { type: "done" };
      })(), { result: async () => response });
    };
    const emitted: Array<{ type: string; message?: { role?: string; toolCallId?: string } }> = [];
    const stream = agentLoop(
      [{ role: "user", content: "run both", timestamp: 1 }],
      { messages: [], tools } as never,
      { model: anthropicModel, convertToLlm: async (messages: unknown) => messages, toolExecution: "sequential" } as never,
      controller.signal,
      streamFn as never,
    );
    for await (const event of stream as AsyncIterable<(typeof emitted)[number]>) emitted.push(event);
    const toolResults = emitted.filter((event) => event.type === "message_end" && event.message?.role === "toolResult");
    expect(toolResults.map((event) => event.message?.toolCallId)).toEqual(["call-1", "call-2"]);
  }, 5_000);

  it("falls back from preferred strict mode for an untyped nested schema", () => {
    const tools: Tool[] = [{
      name: "untyped_items",
      description: "Fixture",
      parameters: Type.Object({ items: Type.Array(Type.Unknown()) }),
      constrainedSampling: { type: "json_schema", strict: "prefer" },
    }];
    const converted = convertResponsesTools(tools, { supportsStrictMode: true });
    expect(converted).toHaveLength(1);
    expect(converted[0]).not.toHaveProperty("strict", true);
  });

  it("preserves root additionalProperties on non-strict Anthropic tools", async () => {
    const messages: Message[] = [
      {
        role: "system",
        content: "Fixture",
        timestamp: 1,
        toolsAdded: [{
          name: "closed_schema",
          description: "Reject unexpected arguments",
          parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
        }],
      },
      { role: "user", content: "Continue", timestamp: 2 },
    ];
    let request: { tools?: Array<{ name: string; input_schema: Record<string, unknown> }> } | undefined;
    const response = await streamAnthropic(anthropicModel, normalizeContext({ messages }), {
      apiKey: "fixture",
      maxRetries: 0,
      fetch: async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return completedAnthropicResponse();
      },
    }).result();
    expect(response.stopReason).toBe("stop");
    expect(request?.tools?.find((tool) => tool.name === "closed_schema")?.input_schema.additionalProperties).toBe(false);
  });

  it("reads top-level reasoning token usage from Copilot-style completion chunks", async () => {
    const usage = {
      prompt_tokens: 11,
      completion_tokens: 29,
      reasoning_tokens: 13,
      total_tokens: 40,
    };
    const chunks = [
      { id: "fixture", choices: [], usage },
      { id: "fixture", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] },
    ];
    const result = await streamOpenAiCompletions(openAiCompletionsModel, { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never, {
      apiKey: "fixture-token",
      fetch: async () => new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.usage).toMatchObject({ input: 11, output: 29, reasoning: 13, totalTokens: 40 });
  });
});
