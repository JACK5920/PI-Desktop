import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { estimateTranscriptCacheBytes } = await import(
  "../src/lib/transcript-cache-budget.ts"
);

const message = (id, content, extra = {}) => ({
  id,
  role: "assistant",
  content,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

test("transcript cache estimate accounts for visible and structured tool payloads", () => {
  const short = [message("a", "hi")];
  const long = [message("a", "hi".repeat(100))];
  const tool = [message("tool", "", { toolResult: { lines: ["x".repeat(100)] } })];
  assert.ok(estimateTranscriptCacheBytes(long) > estimateTranscriptCacheBytes(short));
  assert.ok(estimateTranscriptCacheBytes(tool) > estimateTranscriptCacheBytes([message("tool", "")]));
});

test("unchanged transcript snapshots reuse a stable size estimate", () => {
  const transcript = Array.from({ length: 130 }, (_, index) => message(String(index), "row"));
  assert.equal(estimateTranscriptCacheBytes(transcript), estimateTranscriptCacheBytes(transcript));
});
