import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("OMP word prediction uses the native RPC cold-start deadline", async () => {
  const runtime = await read("../electron/main/omp/rpc-runtime.ts");
  assert.match(runtime, /type === "predict_word" \? 155_000/);
});

test("OMP composer prediction is debounced, session-bound, stale-safe, and quiet on failure", async () => {
  const input = await read("../src/features/chat/composer/ComposerInput.tsx");
  const composer = await read("../src/components/Composer.tsx");
  assert.match(input, /ompPredictionSessionId/);
  assert.match(input, /setTimeout\(\(\) => \{/);
  assert.match(input, /}, 550\)/);
  assert.match(input, /command: "predict_word"/);
  assert.match(input, /sequence !== predictionSequence\.current/);
  assert.match(input, /readEditorValue\(editor\) !== request\.text/);
  assert.match(input, /catch\(\(\) => \{ if \(sequence === predictionSequence\.current\) setWordSuggestion\(null\); \}\)/);
  assert.match(input, /command: "predict_word_feedback"/);
  assert.match(input, /event\.key === "Tab"[\s\S]*?document\.execCommand\("insertText"/);
  assert.match(input, /!composerAc\.hasItems && !composerAc\.open && !suggestion/);
  assert.match(composer, /ompPredictionSessionId=\{agentEngine === "omp" && !remoteSession \? activeSessionId : null\}/);
});
