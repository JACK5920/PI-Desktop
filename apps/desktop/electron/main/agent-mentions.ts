import { stat } from "node:fs/promises";
import { join } from "node:path";
import { findAgentMentions, type AgentMention, type Mode } from "@pi-desktop/shared";

/** Resolve only explicit Agent-mode mentions from the current launch catalog. */
export async function resolvePromptAgentMentions({
  content,
  mode,
  subagentNames,
  workspaceRoot,
}: {
  content: string;
  mode: Mode | undefined;
  subagentNames: readonly string[];
  workspaceRoot: string | null;
}): Promise<AgentMention[]> {
  if (mode !== "agent" || subagentNames.length === 0 || !content.includes("@")) return [];
  const mentions = findAgentMentions(content, new Set(subagentNames));
  if (!mentions.length || !workspaceRoot) return mentions;
  const shadowed = new Set<string>();
  for (const name of new Set(mentions.map((mention) => mention.name))) {
    try {
      await stat(join(workspaceRoot, name));
      shadowed.add(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return mentions.filter((mention) => !shadowed.has(mention.name));
}
