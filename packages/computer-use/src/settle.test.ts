import { describe, expect, it } from "vitest";

import type { ComputerInspection } from "@pi-desktop/shared";

import {
  POST_ACTION_SETTLE_ATTEMPTS,
  POST_ACTION_SETTLE_INTERVAL_MS,
  inspectionSignature,
  observeUntilSettled,
} from "./settle.js";

function inspection(label: string, uid = "s00000001:0"): ComputerInspection {
  return {
    grantId: "cug_1",
    revision: 2,
    fidelity: "full",
    truncated: false,
    secureInput: false,
    bounds: { x: 0, y: 0, width: 100, height: 80 },
    nodes: [
      {
        uid,
        identity: "document#0/edit#0",
        role: "edit",
        label,
        hasValue: true,
        enabled: true,
        focused: false,
        actions: ["set_value", "type_text"],
      },
    ],
  } as ComputerInspection;
}

/** Record sleeps instead of waiting, so the retry budget is asserted exactly. */
function recorder() {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

describe("inspectionSignature", () => {
  it("ignores uid re-minting between two reads of an untouched window", () => {
    expect(inspectionSignature(inspection("Send", "s00000001:0")))
      .toBe(inspectionSignature(inspection("Send", "s00000009:0")));
  });

  it("detects a label change", () => {
    expect(inspectionSignature(inspection("Send")))
      .not.toBe(inspectionSignature(inspection("使用 ChatGPT Work")));
  });

  it("detects a node being removed", () => {
    const withButton = inspection("Send");
    const withoutButton = {
      ...withButton,
      nodes: withButton.nodes.slice(0, 0),
    } as ComputerInspection;
    expect(inspectionSignature(withButton)).not.toBe(inspectionSignature(withoutButton));
  });
});

describe("observeUntilSettled", () => {
  it("returns the first read without waiting when the tree already changed", async () => {
    const r = recorder();
    let reads = 0;
    const before = inspection("typed text");
    const result = await observeUntilSettled(
      before,
      async () => {
        reads += 1;
        return inspection("cleared");
      },
      inspectionSignature,
      { sleep: r.sleep },
    );
    expect(reads).toBe(1);
    expect(r.sleeps).toEqual([]);
    expect(result.nodes[0].label).toBe("cleared");
  });

  it("re-reads while the tree is stale and returns the first settled read", async () => {
    const r = recorder();
    const before = inspection("typed text");
    let reads = 0;
    const result = await observeUntilSettled(
      before,
      async () => {
        reads += 1;
        // Reads 1 and 2 still show the pre-render composer; read 3 has settled.
        return reads <= 2 ? inspection("typed text", `s0000000${reads}:0`) : inspection("cleared");
      },
      inspectionSignature,
      { sleep: r.sleep },
    );
    expect(reads).toBe(3);
    expect(r.sleeps).toEqual([POST_ACTION_SETTLE_INTERVAL_MS, POST_ACTION_SETTLE_INTERVAL_MS]);
    expect(result.nodes[0].label).toBe("cleared");
  });

  it("stops after the bounded budget and returns the last read for a genuine no-op", async () => {
    const r = recorder();
    const before = inspection("unchanged");
    let reads = 0;
    const result = await observeUntilSettled(
      before,
      async () => {
        reads += 1;
        return inspection("unchanged", `s0000000${reads}:0`);
      },
      inspectionSignature,
      { sleep: r.sleep },
    );
    expect(reads).toBe(POST_ACTION_SETTLE_ATTEMPTS);
    expect(r.sleeps).toHaveLength(POST_ACTION_SETTLE_ATTEMPTS - 1);
    expect(inspectionSignature(result)).toBe(inspectionSignature(before));
  });

  it("does not re-read when the budget is one attempt", async () => {
    const r = recorder();
    let reads = 0;
    await observeUntilSettled(
      inspection("same"),
      async () => {
        reads += 1;
        return inspection("same");
      },
      inspectionSignature,
      { attempts: 1, sleep: r.sleep },
    );
    expect(reads).toBe(1);
    expect(r.sleeps).toEqual([]);
  });

  it("propagates an observe failure without retrying it", async () => {
    const r = recorder();
    let reads = 0;
    await expect(
      observeUntilSettled(
        inspection("before"),
        async () => {
          reads += 1;
          throw Object.assign(new Error("target gone"), { code: "COMPUTER_TARGET_UNAVAILABLE" });
        },
        inspectionSignature,
        { sleep: r.sleep },
      ),
    ).rejects.toThrow("target gone");
    expect(reads).toBe(1);
    expect(r.sleeps).toEqual([]);
  });
});
