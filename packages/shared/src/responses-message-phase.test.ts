import { describe, expect, it } from "vitest";
import {
  isResponsesCommentary,
  responsesAnswerText,
  responsesTextPhase,
  splitResponsesCommentary,
} from "./responses-message-phase.js";

const signature = (phase: string, id = "msg_1") => JSON.stringify({ v: 1, id, phase });
const text = (length: number, signatureValue?: string) => ({
  type: "text" as const,
  length,
  ...(signatureValue ? { signature: signatureValue } : {}),
});

describe("Responses message phase", () => {
  it("recognizes only versioned phase signatures with an item id", () => {
    expect(responsesTextPhase(signature("commentary"))).toBe("commentary");
    expect(responsesTextPhase(signature("final_answer"))).toBe("final_answer");
    expect(responsesTextPhase("opaque-provider-signature")).toBeUndefined();
    expect(responsesTextPhase('{"v":1,"phase":"commentary"}')).toBeUndefined();
    expect(responsesTextPhase(signature("analysis"))).toBeUndefined();
    expect(isResponsesCommentary(signature("commentary"))).toBe(true);
  });

  it("splits multiple commentary ranges using UTF-16 lengths and leaves other blocks in place", () => {
    const first = "🌊Status.";
    const commentary = " checking";
    const answer = " Answer.";
    const content = first + commentary + answer;
    const replay = {
      version: 1 as const,
      blocks: [
        text(first.length, signature("commentary", "msg_progress")),
        { type: "thinking" as const, length: 4, signature: "thinking-sig" },
        text(commentary.length, signature("commentary", "msg_progress_2")),
        text(answer.length),
      ],
    };
    const split = splitResponsesCommentary(content, replay);
    expect(split?.commentary).toEqual([
      { offset: 0, text: first },
      { offset: first.length, text: commentary },
    ]);
    expect(split?.answer).toBe(answer);
    expect(responsesAnswerText(content, replay)).toBe(answer);
  });

  it("keeps legacy, malformed, or incomplete replay text unchanged", () => {
    const content = "Check. Answer.";
    const noCommentary = { version: 1 as const, blocks: [text(content.length)] };
    const malformed = { version: 1 as const, blocks: [text(content.length + 1, signature("commentary"))] };
    expect(splitResponsesCommentary(content, noCommentary)).toBeUndefined();
    expect(splitResponsesCommentary(content, malformed)).toBeUndefined();
    expect(splitResponsesCommentary(content, undefined)).toBeUndefined();
    expect(responsesAnswerText(content, malformed)).toBe(content);
    expect(responsesAnswerText(content, undefined)).toBe(content);
  });

  it("treats commentary-only rows as an empty answer", () => {
    const content = "Checking.";
    const replay = { version: 1 as const, blocks: [text(content.length, signature("commentary"))] };
    expect(responsesAnswerText(content, replay)).toBe("");
  });
});
