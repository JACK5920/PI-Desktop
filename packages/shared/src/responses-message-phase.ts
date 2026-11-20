import type { AssistantProviderReplay } from "./types/messages.js";

/** Read only phase markers emitted by the Responses adapter; other signatures are opaque. */
export function responsesTextPhase(
  signature: unknown,
): "commentary" | "final_answer" | undefined {
  if (typeof signature !== "string" || !signature.startsWith("{")) return undefined;
  try {
    const item = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown } | null;
    if (
      item?.v === 1 && typeof item.id === "string" && item.id.length > 0 &&
      (item.phase === "commentary" || item.phase === "final_answer")
    ) return item.phase;
  } catch {
    // Provider signatures from other adapters are opaque and may not be JSON.
  }
  return undefined;
}

export function isResponsesCommentary(signature: unknown): boolean {
  return responsesTextPhase(signature) === "commentary";
}

export type ResponsesCommentarySplit = {
  /** Progress ranges and their UTF-16 offsets in the original text. */
  commentary: { offset: number; text: string }[];
  /** Original text with explicitly marked commentary ranges removed. */
  answer: string;
};

/**
 * Split a persisted assistant row only when replay lengths account for the
 * complete text and an explicit commentary marker exists. Old/incomplete rows
 * remain untouched rather than relying on wording heuristics.
 */
export function splitResponsesCommentary(
  content: unknown,
  replay: AssistantProviderReplay | undefined,
): ResponsesCommentarySplit | undefined {
  if (typeof content !== "string" || !replay || replay.version !== 1 || !Array.isArray(replay.blocks)) {
    return undefined;
  }
  const commentary: ResponsesCommentarySplit["commentary"] = [];
  let offset = 0;
  let answerStart = 0;
  let answer = "";
  for (const block of replay.blocks) {
    if (
      !block || (block.type !== "text" && block.type !== "thinking") ||
      !Number.isSafeInteger(block.length) || block.length < 0 ||
      (block.signature !== undefined && typeof block.signature !== "string")
    ) return undefined;
    // Thinking is stored separately from content and does not advance offsets.
    if (block.type === "thinking") continue;
    const end = offset + block.length;
    if (end > content.length) return undefined;
    if (end > offset && isResponsesCommentary(block.signature)) {
      answer += content.slice(answerStart, offset);
      answerStart = end;
      commentary.push({ offset, text: content.slice(offset, end) });
    }
    offset = end;
  }
  if (offset !== content.length || answerStart === 0) return undefined;
  return { commentary, answer: answer + content.slice(answerStart) };
}

/** Return only a marked final answer; preserve legacy or malformed text verbatim. */
export function responsesAnswerText(
  content: string,
  replay: AssistantProviderReplay | undefined,
): string {
  return splitResponsesCommentary(content, replay)?.answer ?? content;
}
