import type { DiffFile, DiffLine, WorkspaceDiff } from "@pi-desktop/shared";

export type BranchReviewFeedbackInput = {
  sessionId: string;
  baseRef: string;
  path: string;
  anchorRevision: string;
  line: DiffLine;
  prompt: string;
};

export type BranchReviewFeedbackResult = "added" | "stale";

export function branchReviewFeedbackText(
  path: string,
  line: DiffLine,
  prompt: string,
): string {
  const excerpt = JSON.stringify({
    path,
    type: line.type,
    ...(line.oldLine === undefined ? {} : { baseLine: line.oldLine }),
    ...(line.newLine === undefined ? {} : { workingTreeLine: line.newLine }),
    text: line.text,
  });
  return `${prompt}\n${excerpt}\n`;
}

function findFile(diff: WorkspaceDiff, path: string): DiffFile | undefined {
  return diff.files.find((candidate) => candidate.path === path);
}

/** Re-read the selected base before adding feedback so stale line anchors never drift. */
export async function addBranchReviewFeedback(
  input: BranchReviewFeedbackInput,
  dependencies: {
    loadDiff: (baseRef: string) => Promise<WorkspaceDiff>;
    appendDraft: (sessionId: string, text: string) => void;
  },
): Promise<BranchReviewFeedbackResult> {
  if (!input.sessionId) throw new Error("A conversation is required to add review feedback");
  const current = await dependencies.loadDiff(input.baseRef);
  const file = current.branchReview?.baseRef === input.baseRef
    ? findFile(current, input.path)
    : undefined;
  if (!file || file.anchorRevision !== input.anchorRevision) return "stale";

  dependencies.appendDraft(
    input.sessionId,
    branchReviewFeedbackText(input.path, input.line, input.prompt),
  );
  return "added";
}
