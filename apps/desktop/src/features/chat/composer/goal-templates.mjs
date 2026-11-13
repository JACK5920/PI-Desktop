export const GOAL_TEMPLATES = [
  {
    id: "delivery",
    labelKey: "goal.templates.deliveryTitle",
    descriptionKey: "goal.templates.deliveryDescription",
    promptKey: "goal.templates.deliveryPrompt",
  },
  {
    id: "bugfix",
    labelKey: "goal.templates.bugfixTitle",
    descriptionKey: "goal.templates.bugfixDescription",
    promptKey: "goal.templates.bugfixPrompt",
  },
  {
    id: "research",
    labelKey: "goal.templates.researchTitle",
    descriptionKey: "goal.templates.researchDescription",
    promptKey: "goal.templates.researchPrompt",
  },
];

/** Insert a template at the current caret without overwriting user draft text. */
export function insertGoalTemplate(draft, caret, templateText) {
  const text = String(draft ?? "");
  const insertion = String(templateText ?? "").trim();
  const offset = Math.max(0, Math.min(text.length, Number.isFinite(caret) ? caret : text.length));
  if (!insertion) return { text, caret: offset };

  const before = text.slice(0, offset);
  const after = text.slice(offset);
  const prefix = before && !before.endsWith("\n") ? "\n\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n\n" : "";
  const inserted = `${prefix}${insertion}${suffix}`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + prefix.length + insertion.length,
  };
}
