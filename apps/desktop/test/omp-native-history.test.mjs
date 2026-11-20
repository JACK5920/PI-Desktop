import assert from "node:assert/strict";
import test from "node:test";
import { canCaptureOmpNativePromptMapping, describeOmpNativeLegacyLookup, describeOmpNativePromptMappingSkip, findNewOmpNativeUserEntryId, findOmpNativeTreeEntry, lookupOmpNativeEntryIdForLegacyMessage, resolveOmpNativeMessageEntryId } from "../electron/main/omp/history-entry.mjs";
import { normalizeOmpTranscriptSnapshot } from "../src/lib/omp-transcript-sync.mjs";

const message = (role, text, timestamp) => ({ role, content: [{ type: "text", text }], timestamp });

test("OMP native message identity capture only runs for confirmed idle immediate prompts", () => {
  const base = {
    messageId: "b5f9407f-cdb2-48f8-8afc-e221c493ac58",
    commandType: "prompt",
    sessionBusy: false,
    pendingCommandCount: 0,
    nativeState: { isStreaming: false, isCompacting: false, hasPendingAsyncWork: false },
  };
  assert.equal(canCaptureOmpNativePromptMapping(base), true);
  assert.equal(canCaptureOmpNativePromptMapping({ ...base, commandType: "steer" }), false, "queued steer has no provable request-to-node correlation");
  assert.equal(canCaptureOmpNativePromptMapping({ ...base, streamingBehavior: "followUp" }), false, "queued follow-up has no provable request-to-node correlation");
  assert.equal(canCaptureOmpNativePromptMapping({ ...base, sessionBusy: true }), false);
  assert.equal(canCaptureOmpNativePromptMapping({ ...base, pendingCommandCount: 1 }), false);
  assert.equal(canCaptureOmpNativePromptMapping({ ...base, nativeState: { isStreaming: true } }), false);
  assert.equal(canCaptureOmpNativePromptMapping({ ...base, nativeState: {} }), true, "engines that omit isStreaming while idle must still capture mappings");
  assert.equal(canCaptureOmpNativePromptMapping({ ...base, messageId: "not-a-uuid" }), false);
});

test("OMP mapping skips report the exact reason for future diagnostics", () => {
  const base = {
    messageId: "b5f9407f-cdb2-48f8-8afc-e221c493ac58",
    commandType: "prompt",
    sessionBusy: false,
    pendingCommandCount: 0,
    nativeState: { isStreaming: false },
  };
  assert.equal(describeOmpNativePromptMappingSkip(base), null);
  assert.equal(describeOmpNativePromptMappingSkip({ ...base, nativeState: { isStreaming: true } }), "native-streaming");
  assert.equal(describeOmpNativePromptMappingSkip({ ...base, sessionBusy: true }), "session-busy");
  assert.equal(describeOmpNativePromptMappingSkip({ ...base, pendingCommandCount: 2 }), "pending-commands");
  assert.equal(describeOmpNativePromptMappingSkip({ ...base, streamingBehavior: "steer" }), "streaming-behavior");
  assert.equal(describeOmpNativePromptMappingSkip({ ...base, nativeState: { isCompacting: true } }), "native-compacting");
  assert.equal(describeOmpNativePromptMappingSkip({ ...base, nativeState: { hasPendingAsyncWork: true } }), "native-async-work");
  assert.equal(describeOmpNativePromptMappingSkip({ ...base, nativeState: { isSettled: false } }), "native-not-settled");
  assert.equal(describeOmpNativePromptMappingSkip({ ...base, messageId: "legacy" }), "message-id-not-uuid");
});

test("legacy prompts rebuild a mapping only from one unambiguous active-branch match", () => {
  const first = message("user", "1", "2026-11-20T05:33:03.145Z");
  const second = message("user", "1", "2026-11-20T06:33:03.145Z");
  const other = message("user", "other", "2026-11-20T05:30:00.000Z");
  const tree = {
    leafId: "u-second",
    tree: [{
      entry: { id: "u-other", type: "message", parentId: null, message: other },
      children: [{
        entry: { id: "u-first", type: "message", parentId: "u-other", message: first },
        children: [{
          entry: { id: "u-second", type: "message", parentId: "u-first", message: second },
          children: [],
        }],
      }],
    }],
  };
  const messages = [other, first, second];
  assert.equal(
    lookupOmpNativeEntryIdForLegacyMessage({
      messagesSnapshot: messages,
      treeSnapshot: tree,
      text: "1",
      timestampMs: Date.parse("2026-11-20T05:33:03.145Z"),
    }),
    "u-first",
    "the nearest timestamp disambiguates duplicate short prompts",
  );
  assert.equal(
    lookupOmpNativeEntryIdForLegacyMessage({
      messagesSnapshot: messages,
      treeSnapshot: tree,
      text: "1",
      timestampMs: Date.parse("2026-11-20T05:33:03.145Z") + 60 * 60 * 1000,
    }),
    "u-second",
  );
  assert.equal(
    lookupOmpNativeEntryIdForLegacyMessage({ messagesSnapshot: messages, treeSnapshot: tree, text: "1" }),
    null,
    "duplicate text without timestamps stays unresolved",
  );
  assert.equal(
    lookupOmpNativeEntryIdForLegacyMessage({
      messagesSnapshot: messages,
      treeSnapshot: tree,
      text: "1",
      timestampMs: Date.parse("2026-11-20T12:00:00.000Z"),
    }),
    null,
    "a timestamp outside the matching window must not guess",
  );
  assert.equal(
    lookupOmpNativeEntryIdForLegacyMessage({ messagesSnapshot: messages, treeSnapshot: tree, text: "missing" }),
    null,
  );
});

test("legacy rebuild rejects a snapshot and tree that raced apart", () => {
  const messages = [message("user", "older", "2026-11-20T04:00:00.000Z"), message("user", "1", "2026-11-20T05:00:00.000Z")];
  const tree = {
    leafId: "u1",
    tree: [{ entry: { id: "u1", type: "message", parentId: null, message: message("user", "1", "2026-11-20T05:00:00.000Z") }, children: [] }],
  };
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: messages,
    treeSnapshot: tree,
    text: "1",
    timestampMs: Date.parse("2026-11-20T05:00:00.000Z"),
  }), null, "a missing user message on the active path must invalidate the ordinal alignment");
});

test("legacy rebuild rejects equal-length branches that differ only in assistant nodes", () => {
  const user = message("user", "continue", "2026-11-20T05:00:00.000Z");
  const assistantA = message("assistant", "branch A", "2026-11-20T05:00:05.000Z");
  const assistantB = message("assistant", "branch B", "2026-11-20T05:00:05.000Z");
  const tree = {
    leafId: "a1",
    tree: [{
      entry: { id: "u1", type: "message", parentId: null, message: user },
      children: [{ entry: { id: "a1", type: "message", parentId: "u1", message: assistantB }, children: [] }],
    }],
  };
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [user, assistantA],
    treeSnapshot: tree,
    text: "continue",
    timestampMs: Date.parse("2026-11-20T05:00:00.000Z"),
  }), null, "assistant/tool divergence must invalidate the snapshot-tree alignment");
});

test("legacy rebuild detects non-text divergence such as different tool calls", () => {
  const user = message("user", "run it", "2026-11-20T05:00:00.000Z");
  const toolA = { role: "assistant", content: [{ type: "tool", name: "bash", input: { cmd: "ls" } }], timestamp: "2026-11-20T05:00:05.000Z" };
  const toolB = { role: "assistant", content: [{ type: "tool", name: "bash", input: { cmd: "rm -rf build" } }], timestamp: "2026-11-20T05:00:05.000Z" };
  const tree = {
    leafId: "a1",
    tree: [{
      entry: { id: "u1", type: "message", parentId: null, message: user },
      children: [{ entry: { id: "a1", type: "message", parentId: "u1", message: toolB }, children: [] }],
    }],
  };
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [user, toolA],
    treeSnapshot: tree,
    text: "run it",
    timestampMs: Date.parse("2026-11-20T05:00:00.000Z"),
  }), null, "tool-call payloads are part of branch identity");
});

test("legacy rebuild separates identical text, time and image duplicates by ordinal", () => {
  const first = message("user", "ok", "2026-11-20T05:00:00.000Z");
  const second = message("user", "ok", "2026-11-20T05:00:00.000Z");
  const tree = {
    leafId: "u2",
    tree: [{
      entry: { id: "u1", type: "message", parentId: null, message: first },
      children: [{ entry: { id: "u2", type: "message", parentId: "u1", message: second }, children: [] }],
    }],
  };
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [first],
    treeSnapshot: tree,
    text: "ok",
    timestampMs: Date.parse("2026-11-20T05:00:00.000Z"),
  }), null, "sequence lengths disagreeing means the two reads cannot be trusted");
  const matchingTree = {
    leafId: "u2",
    tree: [{
      entry: { id: "u1", type: "message", parentId: null, message: first },
      children: [{ entry: { id: "u2", type: "message", parentId: "u1", message: second }, children: [] }],
    }],
  };
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [first, second],
    treeSnapshot: matchingTree,
    text: "ok",
    timestampMs: Date.parse("2026-11-20T05:00:00.000Z"),
  }), null, "two indistinguishable candidates must still fail closed");
});

test("legacy rebuild ignores structural assistant nodes that get_messages omits", () => {
  const first = message("user", "第一问", "2026-11-20T05:00:00.000Z");
  const firstAnswer = message("assistant", "答一", "2026-11-20T05:00:02.000Z");
  // Real OMP tree keeps a content-less assistant node for some turns while
  // get_messages skips it; a literal comparison shifted every later ordinal.
  const placeholder = { role: "assistant", content: [], timestamp: "2026-11-20T05:00:03.000Z" };
  const second = message("user", "第二问", "2026-11-20T05:00:04.000Z");
  const tree = {
    leafId: "u2",
    tree: [{
      entry: { id: "u1", type: "message", parentId: null, message: first },
      children: [{
        entry: { id: "a1", type: "message", parentId: "u1", message: firstAnswer },
        children: [{
          entry: { id: "a-empty", type: "message", parentId: "a1", message: placeholder },
          children: [{ entry: { id: "u2", type: "message", parentId: "a-empty", message: second }, children: [] }],
        }],
      }],
    }],
  };
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [first, firstAnswer, second],
    treeSnapshot: tree,
    text: "第二问",
    timestampMs: Date.parse("2026-11-20T05:00:04.000Z"),
  }), "u2", "a content-less assistant node must not shift the ordinal");
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [first, firstAnswer, second],
    treeSnapshot: tree,
    text: "第一问",
    timestampMs: Date.parse("2026-11-20T05:00:00.000Z"),
  }), "u1", "prompts before the placeholder still resolve");
});

test("legacy rebuild ignores non-conversation custom rows returned by get_messages", () => {
  const first = message("user", "a", "2026-11-20T05:00:00.000Z");
  const answer = message("assistant", "b", "2026-11-20T05:00:02.000Z");
  const custom = { role: "custom", content: [{ type: "text", text: "<environment>" }], timestamp: "2026-11-20T05:00:03.000Z" };
  const second = message("user", "c", "2026-11-20T05:00:04.000Z");
  const tree = {
    leafId: "u2",
    tree: [{
      entry: { id: "u1", type: "message", parentId: null, message: first },
      children: [{
        entry: { id: "a1", type: "message", parentId: "u1", message: answer },
        children: [{
          entry: { id: "c1", type: "custom_message", parentId: "a1", message: { role: "custom", content: custom.content } },
          children: [{ entry: { id: "u2", type: "message", parentId: "c1", message: second }, children: [] }],
        }],
      }],
    }],
  };
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [first, answer, custom, second],
    treeSnapshot: tree,
    text: "c",
    timestampMs: Date.parse("2026-11-20T05:00:04.000Z"),
  }), "u2", "custom notification rows are not part of the conversation sequence");
});

test("legacy rebuild rejects alignment when either side lacks timestamps", () => {
  const user = message("user", "go", "2026-11-20T05:00:00.000Z");
  const assistantWithoutTimestamp = { role: "assistant", content: [{ type: "text", text: "same" }] };
  const treeWithoutTimestamp = { role: "assistant", content: [{ type: "text", text: "same" }] };
  const tree = {
    leafId: "a1",
    tree: [{
      entry: { id: "u1", type: "message", parentId: null, message: user },
      children: [{ entry: { id: "a1", type: "message", parentId: "u1", message: treeWithoutTimestamp }, children: [] }],
    }],
  };
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [user, assistantWithoutTimestamp],
    treeSnapshot: tree,
    text: "go",
    timestampMs: Date.parse("2026-11-20T05:00:00.000Z"),
  }), null, "null === null on both sides is not evidence of the same turn");
});

test("legacy rebuild treats tool and toolResult as the same RPC role spelling", () => {
  const user = message("user", "run", "2026-11-20T05:00:00.000Z");
  const toolResult = { role: "toolResult", content: [{ type: "text", text: "ok" }], timestamp: "2026-11-20T05:00:02.000Z" };
  const toolAlias = { role: "tool", content: [{ type: "text", text: "ok" }], timestamp: "2026-11-20T05:00:02.000Z" };
  const tree = {
    leafId: "t1",
    tree: [{
      entry: { id: "u1", type: "message", parentId: null, message: user },
      children: [{ entry: { id: "t1", type: "message", parentId: "u1", message: toolResult }, children: [] }],
    }],
  };
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [user, toolAlias],
    treeSnapshot: tree,
    text: "run",
    timestampMs: Date.parse("2026-11-20T05:00:00.000Z"),
  }), "u1", "tool is only a spelling alias of toolResult");
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [user, { ...toolAlias, role: "assistant" }],
    treeSnapshot: tree,
    text: "run",
    timestampMs: Date.parse("2026-11-20T05:00:00.000Z"),
  }), null, "a genuinely different role must still invalidate alignment");
});

test("legacy rebuild reports why an empty native history cannot be associated", () => {
  const diagnosed = describeOmpNativeLegacyLookup({ messagesSnapshot: { messages: [] }, treeSnapshot: { tree: [], leafId: null }, text: "x", timestampMs: Date.now() });
  assert.equal(diagnosed.entryId, null);
  assert.equal(diagnosed.reason, "native-history-empty");
});

test("legacy rebuild rejects a tree node whose images disagree with the snapshot", () => {
  const text = "look at this";
  const snapshotMessage = { role: "user", content: [{ type: "text", text }, { type: "image", data: "abc" }], timestamp: "2026-11-20T05:00:00.000Z" };
  const treeMessage = { role: "user", content: [{ type: "text", text }], timestamp: "2026-11-20T05:00:00.000Z" };
  const tree = { leafId: "u1", tree: [{ entry: { id: "u1", type: "message", parentId: null, message: treeMessage }, children: [] }] };
  assert.equal(lookupOmpNativeEntryIdForLegacyMessage({
    messagesSnapshot: [snapshotMessage],
    treeSnapshot: tree,
    text,
    timestampMs: Date.parse("2026-11-20T05:00:00.000Z"),
  }), null, "snapshot and tree must describe the same image-bearing message");
});

test("OMP normalized message ids resolve only to matching entries on the active native tree path", () => {
  const messages = [
    message("user", "same prompt", "2026-01-01T00:00:00.000Z"),
    message("assistant", "reply", "2026-01-01T00:00:01.000Z"),
    message("user", "same prompt", "2026-01-01T00:00:02.000Z"),
  ];
  const tree = {
    leafId: "u2",
    tree: [{
      entry: { id: "u1", type: "message", parentId: null, message: messages[0] },
      children: [{
        entry: { id: "a1", type: "message", parentId: "u1", message: messages[1] },
        children: [
          { entry: { id: "inactive", type: "message", parentId: "a1", message: message("user", "other branch", "2026-01-01T00:00:03.000Z") }, children: [] },
          { entry: { id: "u2", type: "message", parentId: "a1", message: messages[2] }, children: [] },
        ],
      }],
    }],
  };
  const normalized = normalizeOmpTranscriptSnapshot(messages);
  assert.equal(normalized.ok, true);
  assert.equal(resolveOmpNativeMessageEntryId({ messageId: normalized.messages[0].id, messagesSnapshot: messages, treeSnapshot: tree, requiredRole: "user" }), "u1");
  assert.equal(resolveOmpNativeMessageEntryId({ messageId: normalized.messages[2].id, messagesSnapshot: messages, treeSnapshot: tree, requiredRole: "user" }), "u2");
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "b5f9407f-cdb2-48f8-8afc-e221c493ac58",
    nativeEntryId: "u2",
    messagesSnapshot: messages,
    treeSnapshot: tree,
    requiredRole: "user",
  }), "u2", "a live PI UUID resolves to the matching active OMP tree entry");
  assert.equal(resolveOmpNativeMessageEntryId({ messageId: normalized.messages[1].id, messagesSnapshot: messages, treeSnapshot: tree, requiredRole: "user" }), null);
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "b5f9407f-cdb2-48f8-8afc-e221c493ac58",
    nativeEntryId: "inactive",
    messagesSnapshot: messages,
    treeSnapshot: tree,
    requiredRole: "user",
  }), null, "a prompt from an inactive branch remains rejected");
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "b5f9407f-cdb2-48f8-8afc-e221c493ac58",
    nativeEntryId: null,
    messagesSnapshot: messages,
    treeSnapshot: tree,
    requiredRole: "user",
  }), null, "ambiguous duplicate prompts fail closed when no timestamp is available");
  assert.equal(findOmpNativeTreeEntry(tree, "inactive")?.id, "inactive");
});

test("OMP live UUIDs resolve across the full tree and never jump to same-text messages on another branch", () => {
  const oldPrompt = message("user", "repeat this", "2026-03-01T12:00:00.000Z");
  const newPrompt = message("user", "repeat this", "2026-03-01T12:00:01.000Z");
  const tree = {
    leafId: "new-reply",
    tree: [{
      entry: { id: "root", type: "message", parentId: null, message: message("user", "root", "2026-03-01T11:59:00.000Z") },
      children: [{
        entry: { id: "parent", type: "message", parentId: "root", message: message("assistant", "setup", "2026-03-01T11:59:01.000Z") },
        children: [
          { entry: { id: "old-prompt", type: "message", parentId: "parent", message: oldPrompt }, children: [
            { entry: { id: "old-reply", type: "message", parentId: "old-prompt", message: message("assistant", "old reply", "2026-03-01T12:00:00.500Z") }, children: [] },
          ] },
          { entry: { id: "new-prompt", type: "message", parentId: "parent", message: newPrompt }, children: [
            { entry: { id: "new-reply", type: "message", parentId: "new-prompt", message: message("assistant", "new reply", "2026-03-01T12:00:01.500Z") }, children: [] },
          ] },
        ],
      }],
    }],
  };
  const activeMessages = [tree.tree[0].entry.message, tree.tree[0].children[0].entry.message, newPrompt];
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "older-live-pi-uuid",
    nativeEntryId: "old-prompt",
    messagesSnapshot: activeMessages,
    treeSnapshot: tree,
    requiredRole: "user",
  }), null, "a stale UUID for the old branch must not bind to the sole same-text active prompt");
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "current-live-pi-uuid",
    nativeEntryId: "new-prompt",
    messagesSnapshot: activeMessages,
    treeSnapshot: tree,
    requiredRole: "user",
  }), "new-prompt", "the current live row resolves to its exact active native entry");
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "expired-live-pi-uuid",
    nativeEntryId: null,
    messagesSnapshot: activeMessages,
    treeSnapshot: tree,
    requiredRole: "user",
  }), null, "a unique same-text candidate still must be close to the source row timestamp");
});

test("OMP attachment prompt resolves through its stable accepted native entry mapping", () => {
  const sourceTime = "2026-04-01T12:00:00.000Z";
  const native = message("user", "summarize this\n@report.md", sourceTime);
  const beforeTree = { leafId: "old-assistant", tree: [{
    entry: { id: "old-user", type: "message", parentId: null, message: message("user", "old", "2026-03-31T23:59:00.000Z") },
    children: [{ entry: { id: "old-assistant", type: "message", parentId: "old-user", message: message("assistant", "ready", "2026-03-31T23:59:01.000Z") }, children: [] }],
  }] };
  const afterTree = { leafId: "file-user", tree: [{
    ...beforeTree.tree[0],
    children: [{
      ...beforeTree.tree[0].children[0],
      children: [{ entry: { id: "file-user", type: "message", parentId: "old-assistant", message: native }, children: [] }],
    }],
  }] };
  const mappedEntryId = findNewOmpNativeUserEntryId({
    beforeTreeSnapshot: beforeTree,
    afterTreeSnapshot: afterTree,
    expectedText: "summarize this\n@report.md",
    expectedImageCount: 0,
  });
  assert.equal(mappedEntryId, "file-user");
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "live-file-row-uuid",
    nativeEntryId: mappedEntryId,
    messagesSnapshot: [native],
    treeSnapshot: afterTree,
    requiredRole: "user",
  }), "file-user");
});

test("OMP attachment matching rejects arbitrary text-prefix lookalikes and unavailable source fingerprints", () => {
  const sourceTime = "2026-04-15T12:00:00.000Z";
  const unrelated = message("user", "same-looking but unrelated text; no attachment marker", sourceTime);
  const tree = { leafId: "unrelated", tree: [{
    entry: { id: "unrelated", type: "message", parentId: null, message: unrelated }, children: [],
  }] };

  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "old-file-pi-uuid",
    nativeEntryId: null,
    messagesSnapshot: [unrelated],
    treeSnapshot: tree,
    requiredRole: "user",
  }), null, "a text prefix must never identify an attachment-bearing native message");
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "source-file-unavailable-pi-uuid",
    nativeEntryId: null,
    messagesSnapshot: [unrelated],
    treeSnapshot: tree,
    requiredRole: "user",
  }), null, "failure to reconstruct the original transport text fails closed even if a later message is nearby");
});

test("OMP live UUIDs fail closed without native association even for a nearby exact duplicate", () => {
  const oldTime = "2026-05-01T12:00:00.000Z";
  const oldFilePrompt = message("user", "same\n@old.txt", oldTime);
  const newPlainPrompt = message("user", "same", "2026-05-01T12:00:01.000Z");
  const tree = {
    leafId: "new-plain",
    tree: [{
      entry: { id: "root", type: "message", parentId: null, message: message("user", "root", "2026-05-01T11:59:00.000Z") },
      children: [{
        entry: { id: "parent", type: "message", parentId: "root", message: message("assistant", "setup", "2026-05-01T11:59:01.000Z") },
        children: [
          { entry: { id: "old-file", type: "message", parentId: "parent", message: oldFilePrompt }, children: [] },
          { entry: { id: "new-plain", type: "message", parentId: "parent", message: newPlainPrompt }, children: [] },
        ],
      }],
    }],
  };
  const activeMessages = [tree.tree[0].entry.message, tree.tree[0].children[0].entry.message, newPlainPrompt];
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "old-file-pi-uuid",
    nativeEntryId: null,
    messagesSnapshot: activeMessages,
    treeSnapshot: tree,
    requiredRole: "user",
  }), null, "a live UUID without persisted native identity cannot be guessed from text and time");
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "unknown-file-pi-uuid",
    nativeEntryId: null,
    messagesSnapshot: activeMessages,
    treeSnapshot: tree,
    requiredRole: "user",
  }), null, "a live UUID without a native association fails closed rather than selecting a nearby message");
  assert.equal(resolveOmpNativeMessageEntryId({
    messageId: "unmapped-live-row",
    messagesSnapshot: [newPlainPrompt],
    treeSnapshot: { leafId: "new-plain", tree: [{
      entry: { id: "new-plain", type: "message", parentId: null, message: newPlainPrompt }, children: [],
    }] },
    requiredRole: "user",
  }), null, "a later identical prompt within one second is not proof that it belongs to the Host UUID");
});

test("OMP renderer snapshot ids are rejected when the index, timestamp, or tree content is stale", () => {
  const messages = [message("user", "prompt", "2026-02-01T00:00:00.000Z")];
  const normalized = normalizeOmpTranscriptSnapshot(messages);
  const tree = {
    leafId: "u1",
    tree: [{ entry: { id: "u1", type: "message", parentId: null, message: messages[0] }, children: [] }],
  };
  assert.equal(resolveOmpNativeMessageEntryId({ messageId: "omp:snapshot:8:1769904000000", messagesSnapshot: messages, treeSnapshot: tree, requiredRole: "user" }), null);
  assert.equal(resolveOmpNativeMessageEntryId({ messageId: "omp:snapshot:0:1", messagesSnapshot: messages, treeSnapshot: tree, requiredRole: "user" }), null);
  assert.equal(resolveOmpNativeMessageEntryId({ messageId: normalized.messages[0].id, messagesSnapshot: messages, treeSnapshot: { ...tree, tree: [{ entry: { id: "u1", type: "message", parentId: null, message: message("user", "changed", "2026-02-01T00:00:00.000Z") }, children: [] }] }, requiredRole: "user" }), null);
});
