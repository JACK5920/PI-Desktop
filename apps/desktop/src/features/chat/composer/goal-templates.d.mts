export type GoalTemplateId = "delivery" | "bugfix" | "research";

export type GoalTemplate = {
  id: GoalTemplateId;
  labelKey: string;
  descriptionKey: string;
  promptKey: string;
};

export const GOAL_TEMPLATES: readonly GoalTemplate[];

export function insertGoalTemplate(
  draft: string,
  caret: number,
  templateText: string,
): { text: string; caret: number };
