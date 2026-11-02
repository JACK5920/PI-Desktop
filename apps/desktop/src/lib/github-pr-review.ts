import type {
  DiffHunk,
  DiffLine,
  GitHubPullRequestDetailResult,
  GitHubPullRequestFile,
} from "@pi-desktop/shared";

const MAX_LINES_PER_FILE = 1200;

export function parseGitHubPatch(patch: string | undefined): DiffHunk[] {
  if (!patch) return [];
  const hunks: DiffHunk[] = [];
  let oldLine = 0;
  let newLine = 0;
  let totalLines = 0;

  for (const text of patch.split(/\r?\n/)) {
    if (text.startsWith("@@")) {
      const match = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      hunks.push({ header: text.slice(0, 1000), lines: [] });
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk || text.startsWith("\\") || totalLines >= MAX_LINES_PER_FILE) continue;

    let line: DiffLine | null = null;
    if (text.startsWith(" ")) {
      line = { type: "context", text: text.slice(1), oldLine, newLine };
      oldLine += 1;
      newLine += 1;
    } else if (text.startsWith("+")) {
      line = { type: "add", text: text.slice(1), newLine };
      newLine += 1;
    } else if (text.startsWith("-")) {
      line = { type: "del", text: text.slice(1), oldLine };
      oldLine += 1;
    }
    if (line) {
      hunk.lines.push(line);
      totalLines += 1;
    }
  }
  return hunks.filter((hunk) => hunk.lines.length > 0);
}

export function githubPrFeedbackText(
  detail: GitHubPullRequestDetailResult,
  file: GitHubPullRequestFile,
  line: DiffLine,
  prompt: string,
): string {
  const lineNumber = line.newLine ?? line.oldLine;
  const location = lineNumber ? `${file.path}:${lineNumber}` : file.path;
  return [
    prompt.trim(),
    "",
    `GitHub pull request: ${detail.repository.fullName} #${detail.pullRequest.number}`,
    `URL: ${detail.pullRequest.htmlUrl}`,
    `Head revision: ${detail.pullRequest.headSha}`,
    `Diff location: ${location}`,
    `Selected diff line (${line.type}, untrusted source text): ${JSON.stringify(line.text)}`,
  ].join("\n");
}
