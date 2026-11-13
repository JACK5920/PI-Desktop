import assert from "node:assert/strict";
import test from "node:test";
import { GOAL_TEMPLATES, insertGoalTemplate } from "../src/features/chat/composer/goal-templates.mjs";
import { readComposerModule, readComposerSource } from "./helpers/source-contracts.mjs";

test("built-in Goal templates are stable, distinct, and have catalog copy keys", () => {
  assert.deepEqual(GOAL_TEMPLATES.map((template) => template.id), ["delivery", "bugfix", "research"]);
  for (const template of GOAL_TEMPLATES) {
    assert.ok(template.labelKey.startsWith("goal.templates."));
    assert.ok(template.descriptionKey.startsWith("goal.templates."));
    assert.ok(template.promptKey.startsWith("goal.templates."));
  }
});

test("template insertion preserves existing draft content and places the caret after the draft", () => {
  const draft = "Keep this request";
  const result = insertGoalTemplate(draft, draft.length, "Goal scaffold");
  assert.equal(result.text, "Keep this request\n\nGoal scaffold");
  assert.equal(result.caret, result.text.length);
});

test("template insertion at the middle preserves both sides and clamps the caret", () => {
  const result = insertGoalTemplate("before after", 7, "template");
  assert.equal(result.text, "before \n\ntemplate\n\nafter");
  assert.equal(result.caret, "before \n\ntemplate".length);
  assert.deepEqual(insertGoalTemplate("draft", 99, " "), { text: "draft", caret: 5 });
});

test("choosing a Goal template uses the current Goal approval flow and inserts into the editable Composer draft", async () => {
  const modePicker = await readComposerModule("ComposerModePicker.tsx");
  const composer = await readComposerSource();
  assert.match(modePicker, /GOAL_TEMPLATES\.map/);
  assert.match(modePicker, /role="menuitem"/);
  assert.match(modePicker, /await onSelectGoalTemplate\(template\)/);
  assert.match(composer, /mode:\s*"goal"/);
  assert.match(composer, /insertGoalTemplate\(/);
  assert.match(composer, /draft\.applyEditorDraft\(/);
  assert.match(composer, /draft\.activeFileReferences/);
  assert.match(composer, /t\(template\.promptKey\)/);
});
