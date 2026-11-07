import { describe, expect, it } from "vitest";
import {
  composeMentionPrompt,
  findAgentMentions,
  findSkillMentions,
  serializeComposerFileReferences,
  serializeInlineComposerFileReferences,
} from "./composer-trigger";

describe("agent mentions", () => {
  const agents = new Set(["explorer", "code-reviewer"]);

  it("finds only catalog mentions at word boundaries", () => {
    expect(findAgentMentions("look @explorer, not user@explorer or @unknown", agents)).toEqual([
      { start: 5, end: 14, name: "explorer" },
    ]);
  });

  it("serializes agent chips with safe token boundaries without changing file serialization", () => {
    expect(serializeInlineComposerFileReferences("look\ue010where", [
      { path: "explorer", kind: "agent", token: "\ue010" },
    ])).toBe("look @explorer where");
    expect(serializeInlineComposerFileReferences("see\ue011now", [
      { path: "src/a.ts", kind: "file", token: "\ue011" },
    ])).toBe("see@src/a.ts now");
    expect(serializeComposerFileReferences("plain", [{ path: "explorer", kind: "agent" }])).toBe("plain");
  });

  it("composes Skills before delegated agents and preserves the request", () => {
    const content = "/skill:review @code-reviewer inspect this";
    const skills = new Map([["skill:review", "review"]]);
    const prompt = composeMentionPrompt(
      content,
      findSkillMentions(content, skills),
      findAgentMentions(content, agents),
    );
    const [skillInstruction, agentInstruction, body] = prompt.split("\n\n");
    expect(skillInstruction).toContain('"review"');
    expect(agentInstruction).toContain('"code-reviewer"');
    expect(body).toBe("@code-reviewer inspect this");
  });
});
