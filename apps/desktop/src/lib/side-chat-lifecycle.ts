import { formatUserSelectionQuote } from "./transcript-selection";

export type SideChatLifecycleStatus =
  | "draft"
  | "forking"
  | "sending"
  | "ready"
  | "closed";

export type SideChatLifecycle = {
  operationId: number;
  status: SideChatLifecycleStatus;
  childSessionId?: string;
  draftText: string;
  submittedDraftText?: string;
  error?: string;
};

export type SideChatSendStart = {
  state: SideChatLifecycle;
  operationId: number;
  shouldFork: boolean;
};

/** Append selected transcript text to the compact side-chat draft without replacing it. */
export function appendSideChatDraftText(
  draftText: string,
  excerpt: string,
  sourceAttribution: string,
): string {
  const quote = formatUserSelectionQuote(excerpt, sourceAttribution);
  if (!quote) return draftText;
  const separator = draftText.length === 0
    ? ""
    : draftText.endsWith("\n") ? "\n" : "\n\n";
  return `${draftText}${separator}${quote}`;
}

/** Quote a child answer without applying the shorter transcript-selection cap. */
export function formatSideChatResultQuote(
  answer: string,
  sourceAttribution: string,
): string {
  const normalized = answer.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  const quote = normalized
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const attribution = sourceAttribution.replace(/[\r\n]+/g, " ").trim();
  return attribution ? `${quote}\n\n— ${attribution}` : quote;
}

export function beginSideChatSend(
  lifecycle: SideChatLifecycle,
  promptText: string,
): SideChatSendStart | null {
  if (
    lifecycle.status === "closed" ||
    lifecycle.status === "forking" ||
    lifecycle.status === "sending" ||
    !promptText.trim()
  ) {
    return null;
  }
  const operationId = lifecycle.operationId + 1;
  return {
    operationId,
    shouldFork: !lifecycle.childSessionId,
    state: {
      ...lifecycle,
      operationId,
      status: lifecycle.childSessionId ? "sending" : "forking",
      draftText: promptText,
      submittedDraftText: promptText,
      error: undefined,
    },
  };
}

export function editSideChatDraft(
  lifecycle: SideChatLifecycle,
  draftText: string,
): SideChatLifecycle {
  if (lifecycle.status === "closed") return lifecycle;
  return { ...lifecycle, draftText };
}

export function resolveSideChatFork(
  lifecycle: SideChatLifecycle,
  operationId: number,
  childSessionId: string,
): SideChatLifecycle | null {
  if (
    lifecycle.status !== "forking" ||
    lifecycle.operationId !== operationId ||
    !childSessionId
  ) {
    return null;
  }
  return {
    ...lifecycle,
    childSessionId,
    status: "sending",
    error: undefined,
  };
}

export function failSideChatFork(
  lifecycle: SideChatLifecycle,
  operationId: number,
  error: string,
): SideChatLifecycle | null {
  if (
    lifecycle.status !== "forking" ||
    lifecycle.operationId !== operationId
  ) {
    return null;
  }
  return {
    ...lifecycle,
    status: "ready",
    submittedDraftText: undefined,
    error,
  };
}

export function resolveSideChatSend(
  lifecycle: SideChatLifecycle,
  operationId: number,
  accepted: boolean,
  error?: string,
): SideChatLifecycle | null {
  if (
    lifecycle.status !== "sending" ||
    lifecycle.operationId !== operationId
  ) {
    return null;
  }
  const submittedDraftText = lifecycle.submittedDraftText;
  return {
    ...lifecycle,
    status: "ready",
    draftText:
      accepted && lifecycle.draftText === submittedDraftText
        ? ""
        : lifecycle.draftText,
    submittedDraftText: undefined,
    error: accepted ? undefined : error ?? "The request was not accepted.",
  };
}

export function closeSideChatLifecycle(
  lifecycle: SideChatLifecycle,
): SideChatLifecycle {
  return {
    ...lifecycle,
    operationId: lifecycle.operationId + 1,
    status: "closed",
    submittedDraftText: undefined,
  };
}
