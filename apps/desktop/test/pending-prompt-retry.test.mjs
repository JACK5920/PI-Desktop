import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("ordinary send failures keep the exact optimistic user attempt for retry", async () => {
  const queue = await readSource("../src/stores/slices/queue-slice.ts");
  const runtime = await readSource("../src/stores/runtime/session-runtime.ts");
  const failureStart = queue.indexOf("runtime.promptSubmissionWasAccepted(startedIn, optimisticMessage.id)");
  const failureEnd = queue.indexOf("const messageError =", failureStart);
  const failure = queue.slice(failureStart, failureEnd);

  assert.notEqual(failureStart, -1);
  assert.match(failure, /promptSubmissionWasAccepted\(startedIn, optimisticMessage\.id\)/);
  assert.match(failure, /markPendingPromptFailed\(startedIn, optimisticMessage\)/);
  assert.doesNotMatch(failure.slice(0, failure.indexOf("const messageError")), /retractOptimisticUserMessage/);
  assert.match(runtime, /pendingPromptAttempts: Map<string, Map<string, UiMessage>>/);
  assert.match(runtime, /PENDING_PROMPT_ATTEMPT_LIMIT = 100/);
  assert.match(runtime, /upsertLiveSessionMessage\(normalized, attempt\)/);
});

test("retry is bound to one message ID and reconciles durable history before resending", async () => {
  const transcript = await readSource("../src/stores/slices/transcript-slice.ts");
  const start = transcript.indexOf("retryLastPrompt: async (messageId)");
  const end = transcript.indexOf("      let userIndex = -1;", start);
  const retry = transcript.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(retry, /message\.id === messageId && message\.role === "user" && message\.status === "error"/);
  assert.match(retry, /await api\.getSession\(sessionId\)/);
  assert.match(retry, /message\.id === attempt\.id && message\.role === "user"/);
  assert.match(retry, /messageId: attempt\.id/);
  assert.match(retry, /attachments: promptAttachmentsFromMessage\(attempt\.attachments\)/);
  assert.doesNotMatch(retry, /truncateFromMessageId/);
  assert.match(retry, /markPendingPromptFailed\(sessionId, attempt\)/);
});

test("late persistence confirmation clears only the matching failed attempt", async () => {
  const events = await readSource("../src/stores/slices/events-slice.ts");
  const runtime = await readSource("../src/stores/runtime/session-runtime.ts");
  const event = events.slice(events.indexOf('if (event.type === "user_message_persisted")'));

  assert.match(event, /acceptPromptSubmission\(sessionId, event\.optimisticMessageId\)/);
  assert.match(event, /clearPendingPromptAttempt\(sessionId, event\.optimisticMessageId\)/);
  assert.match(runtime, /attempts\.delete\(messageId\)/);
  assert.match(runtime, /normalized\.find\(\(message\) => message\.id === messageId && message\.role === "user"\)/);
});

test("editing or deleting a failed row cannot resurrect its stale retry affordance", async () => {
  const transcript = await readSource("../src/stores/slices/transcript-slice.ts");
  const editStart = transcript.indexOf("editUserMessage: async (messageId, content, attachments)");
  const editEnd = transcript.indexOf("retryLastPrompt: async (messageId)", editStart);
  const edit = transcript.slice(editStart, editEnd);
  const deleteStart = transcript.indexOf("deleteMessage: async (messageId)");
  const deleteEnd = transcript.indexOf("rollbackWorkspaceChange: async", deleteStart);
  const deletion = transcript.slice(deleteStart, deleteEnd);

  assert.match(edit, /clearPendingPromptAttempt\(sessionId, messageId\)/);
  assert.match(deletion, /if \(!result\.deleted\) return;\s+runtime\.clearPendingPromptAttempt\(sessionId, messageId\)/);
});
