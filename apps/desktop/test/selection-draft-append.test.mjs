import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { formatUserSelectionQuote } = await import("../src/lib/transcript-selection.ts");
const { ComposerDraftBridge } = await import(
  "../src/features/chat/composer/plugins/draft-bridge.ts"
);

test("a selected user excerpt is appended as a quote with a separate source attribution", () => {
  assert.equal(
    formatUserSelectionQuote("  first\r\nsecond  ", "From your message"),
    "> first\n> second\n\n— From your message",
  );
});

test("empty selected user excerpts do not create a draft insertion", () => {
  assert.equal(formatUserSelectionQuote(" \n ", "From your message"), "");
});

test("appending a selection preserves existing draft text and attachment chips without submitting", () => {
  const token = "\uE001";
  const draft = {
    sessionId: "session-a",
    draftKey: "session:session-a",
    text: `Keep this ${token}`,
    references: [{ sessionId: "session-a", path: "scratch/diagram.png", name: "diagram.png", token }],
  };
  let writes = 0;
  const bridge = new ComposerDraftBridge(() => undefined);
  bridge.register({
    read: () => draft,
    focused: () => false,
    selection: () => ({ start: 0, end: 4 }),
    write(next, references, caret, focus) {
      writes += 1;
      draft.text = next;
      draft.references = references;
      assert.equal(caret, next.length);
      assert.equal(focus, true);
    },
    async stage() { throw new Error("not used"); },
  });

  bridge.appendTextForSession("session-a", formatUserSelectionQuote("Need this part", "From your message"));

  assert.equal(draft.text, `Keep this ${token}\n\n> Need this part\n\n— From your message`);
  assert.deepEqual(draft.references, [{ sessionId: "session-a", path: "scratch/diagram.png", name: "diagram.png", token }]);
  assert.equal(writes, 1);
});
