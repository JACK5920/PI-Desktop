import { describe, expect, it } from "vitest";
import { assistantContent, toJsonObject, toJsonValue, usageFromPi, usageToPi } from "./agent-messages.js";

describe("agent message JSON projections", () => {
  it("keeps JSON objects and rejects readonly arrays as object maps", () => {
    const values: readonly unknown[] = Object.freeze([{ nested: "value" }]);

    expect(toJsonObject({ details: values })).toEqual({ details: [{ nested: "value" }] });
    expect(toJsonObject(values)).toEqual({});
    expect(toJsonValue(values)).toEqual([{ nested: "value" }]);
  });
});

describe("Pi usage provenance", () => {
  it("preserves provider-billed cost as reported across a Pi transcript round trip", () => {
    const usage = usageFromPi({
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042, totalFromProvider: true },
    } as never);
    expect(usage?.costStatus).toBe("reported");
    expect(usage?.cost?.total).toBe(0.0042);
    expect(usageToPi(usage).cost.totalFromProvider).toBe(true);
  });
});

describe("Responses commentary extraction", () => {
  const signature = (phase: string, id: string) => JSON.stringify({ v: 1, id, phase });

  it("keeps signed progress out of the answer while preserving the transcript source", () => {
    const result = assistantContent([
      { type: "text", text: "Checking.", textSignature: signature("commentary", "msg_progress") },
      { type: "text", text: "42", textSignature: signature("final_answer", "msg_answer") },
    ]);
    expect(result.text).toBe("42");
    expect(result.hasText).toBe(true);
    expect(result.hasFinalAnswer).toBe(true);
    expect(result.transcript).toMatchObject({
      text: "Checking.42",
      replay: { version: 1, blocks: [
        { type: "text", length: 9, signature: signature("commentary", "msg_progress") },
        { type: "text", length: 2, signature: signature("final_answer", "msg_answer") },
      ] },
    });
  });

  it("keeps unsigned provider text verbatim and exposes no commentary projection", () => {
    const result = assistantContent([{ type: "text", text: "Checking.42", textSignature: "opaque" }]);
    expect(result.text).toBe("Checking.42");
    expect(result.transcript).toBeUndefined();
    expect(result.hasFinalAnswer).toBeUndefined();
  });
});
