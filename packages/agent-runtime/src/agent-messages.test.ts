import { describe, expect, it } from "vitest";
import { toJsonObject, toJsonValue, usageFromPi, usageToPi } from "./agent-messages.js";

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
