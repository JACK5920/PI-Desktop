import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  isAssistantFragmentSelectable,
  normalizeTranscriptExcerpt,
  resolveTranscriptSelection,
  resolveTranscriptTextAnchor,
  transcriptSelectionSourceAttribution,
} = await import(
  "../src/lib/transcript-selection.ts"
);

const rect = { top: 12, right: 80, bottom: 32, left: 20, width: 60, height: 20 };
const owner = (overrides = {}) => ({
  sessionId: "session-a",
  messageId: "message-1",
  role: "assistant",
  eligible: true,
  ...overrides,
});

test("transcript excerpt trims and normalizes platform line endings", () => {
  assert.equal(normalizeTranscriptExcerpt("  first\r\nsecond\rlast  "), "first\nsecond\nlast");
});

test("empty or whitespace-only transcript selections are not captured", () => {
  assert.equal(normalizeTranscriptExcerpt(" \r\n \t "), null);
});

test("the toolbar excerpt cap counts Unicode code points and never splits a surrogate pair", () => {
  const excerpt = normalizeTranscriptExcerpt(`${"a".repeat(1999)}😀tail`);
  assert.equal(Array.from(excerpt ?? "").length, 2000);
  assert.equal(excerpt, `${"a".repeat(1999)}😀`);
});

test("selection capture retains one eligible source message and its anchor rectangle", () => {
  assert.deepEqual(
    resolveTranscriptSelection({
      anchorOwner: owner(),
      focusOwner: owner(),
      excerpt: "  quoted text  ",
      rect,
    }),
    {
      sessionId: "session-a",
      messageId: "message-1",
      messageIds: ["message-1"],
      role: "assistant",
      excerpt: "quoted text",
      rect,
    },
  );
});

test("selection capture rejects collapsed, cross-message, cross-session, and ineligible ranges", () => {
  const cases = [
    { anchorOwner: null, focusOwner: owner(), excerpt: "text" },
    { anchorOwner: owner(), focusOwner: null, excerpt: "text" },
    { anchorOwner: owner(), focusOwner: owner({ messageId: "message-2" }), excerpt: "text" },
    { anchorOwner: owner(), focusOwner: owner({ sessionId: "session-b" }), excerpt: "text" },
    { anchorOwner: owner(), focusOwner: owner({ role: "user" }), excerpt: "text" },
    { anchorOwner: owner({ eligible: false }), focusOwner: owner({ eligible: false }), excerpt: "text" },
    { anchorOwner: owner(), focusOwner: owner(), excerpt: "  " },
  ];

  for (const candidate of cases) {
    assert.equal(
      resolveTranscriptSelection({ ...candidate, rect }),
      null,
      `expected rejection for ${JSON.stringify(candidate)}`,
    );
  }
});

test("same-role multi-message ranges preserve every source in transcript order", () => {
  const first = owner({ messageId: "message-1" });
  const second = owner({ messageId: "message-2" });
  const captured = resolveTranscriptSelection({
    anchorOwner: first,
    focusOwner: second,
    sourceOwners: [first, second],
    excerpt: "text spanning rows",
    rect,
  });
  assert.deepEqual(captured?.messageIds, ["message-1", "message-2"]);
  assert.equal(captured?.messageId, "message-1");
  assert.equal(transcriptSelectionSourceAttribution(["message-1", "message-2"], "Source"), "Source (message-1, message-2)");
  assert.equal(isAssistantFragmentSelectable(true, "streaming"), true);
});

test("source anchors resolve half-open UTF-16 offsets across Unicode text", () => {
  const source = "before 😀 selected text after";
  const start = source.indexOf("selected");
  assert.deepEqual(resolveTranscriptTextAnchor(source, start, start + 13, "selected text"), {
    start,
    end: start + 13,
  });
});

test("source anchors reject invalid ranges and text that no longer matches the excerpt", () => {
  assert.equal(resolveTranscriptTextAnchor("source text", undefined, undefined, "source"), null);
  assert.equal(resolveTranscriptTextAnchor("source text", -1, 6, "source"), null);
  assert.equal(resolveTranscriptTextAnchor("source text", 6, 6, ""), null);
  assert.equal(resolveTranscriptTextAnchor("source text", 0, 99, "source"), null);
  assert.equal(resolveTranscriptTextAnchor("changed text", 0, 6, "source"), null);
});
