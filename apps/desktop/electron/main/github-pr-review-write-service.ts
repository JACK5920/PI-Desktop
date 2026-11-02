import type {
  GitHubDiffSide,
  GitHubPrReviewLineCommentInput,
  GitHubPrReviewSubmissionInput,
  GitHubPrReviewWriteResult,
  GitHubPullRequestReviewEvent,
  GitHubRepository,
} from "@pi-desktop/shared";
import {
  createGitHubPrReviewService,
  GitHubPrReviewError,
  type GitHubFetch,
} from "./github-pr-review-service.ts";

const API_ROOT = "https://api.github.com";
const MAX_COMMENT_LENGTH = 20_000;

type DiffLineAnchor = { line: number; side: GitHubDiffSide; type: "add" | "del" | "context" };

function apiPath(repository: GitHubRepository, suffix: string): string {
  const segment = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
  if (!segment.test(repository.owner) || !segment.test(repository.name)
    || repository.fullName !== `${repository.owner}/${repository.name}`) {
    throw new GitHubPrReviewError("invalid_repository", "Unsupported GitHub repository");
  }
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;
}

function anchorsForPatch(patch: string | undefined): DiffLineAnchor[] {
  if (!patch) return [];
  const anchors: DiffLineAnchor[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of patch.split(/\r?\n/)) {
    if (text.startsWith("@@")) {
      const match = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      continue;
    }
    if (text.startsWith(" ")) {
      anchors.push({ line: oldLine++, side: "LEFT", type: "context" });
      anchors.push({ line: newLine++, side: "RIGHT", type: "context" });
    } else if (text.startsWith("+")) {
      anchors.push({ line: newLine++, side: "RIGHT", type: "add" });
    } else if (text.startsWith("-")) {
      anchors.push({ line: oldLine++, side: "LEFT", type: "del" });
    }
    if (anchors.length >= 2400) break;
  }
  return anchors;
}

function validateText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_COMMENT_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new GitHubPrReviewError("invalid_response", "Review text must be between 1 and 20,000 characters");
  }
  return value.trim();
}

function validatePullRequestNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new GitHubPrReviewError("invalid_response", "Invalid pull-request number");
  }
}

function validateHeadSha(value: string): void {
  if (!/^[a-f0-9]{7,128}$/i.test(value)) {
    throw new GitHubPrReviewError("invalid_response", "Invalid pull-request revision");
  }
}

function writeError(response: Response): GitHubPrReviewError {
  if (response.status === 401) return new GitHubPrReviewError("auth_required", "GitHub authorization expired or was revoked");
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    return new GitHubPrReviewError("rate_limited", "GitHub public API rate limit reached");
  }
  if (response.status === 403) return new GitHubPrReviewError("permission_denied", "GitHub denied this review action");
  if (response.status === 404) return new GitHubPrReviewError("not_found", "Repository or pull request is not available to this account");
  if (response.status === 409 || response.status === 422) return new GitHubPrReviewError("stale_revision", "The pull request changed; reload it before writing feedback");
  return new GitHubPrReviewError("write_failed", `GitHub review action failed (${response.status})`);
}

async function submit(fetchImpl: GitHubFetch, token: string, path: string, body: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_ROOT}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "PI-Desktop",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GitHubPrReviewError("unavailable", "Could not send the GitHub review action");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw writeError(response);
  }
  await response.body?.cancel();
}

export function createGitHubPrReviewWriteService(dependencies: {
  fetchImpl: GitHubFetch;
  getAccessToken: () => Promise<string | null>;
}) {
  async function currentDetail(repository: GitHubRepository, number: number, expectedHeadSha: string) {
    validatePullRequestNumber(number);
    validateHeadSha(expectedHeadSha);
    const token = await dependencies.getAccessToken();
    if (!token) throw new GitHubPrReviewError("auth_required", "Sign in to GitHub before posting a review");
    const authenticatedFetch: GitHubFetch = (url, init) => {
      const parsed = new URL(url);
      if (parsed.origin !== API_ROOT) throw new GitHubPrReviewError("invalid_repository", "Only GitHub.com API requests are supported");
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return dependencies.fetchImpl(url, { ...init, headers });
    };
    const detailService = createGitHubPrReviewService(authenticatedFetch);
    const detail = await detailService.detail(repository, number);
    if (detail.pullRequest.state !== "open") {
      throw new GitHubPrReviewError("stale_revision", "Only open pull requests can receive review feedback");
    }
    if (detail.pullRequest.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
      throw new GitHubPrReviewError("stale_revision", "The pull request changed; reload it before writing feedback");
    }
    return { detail, token };
  }

  async function comment(repository: GitHubRepository, input: GitHubPrReviewLineCommentInput): Promise<GitHubPrReviewWriteResult> {
    const body = validateText(input.body);
    if (typeof input.path !== "string" || !input.path || input.path.length > 512
      || !Number.isSafeInteger(input.line) || input.line < 1 || input.line > 10_000_000
      || (input.side !== "LEFT" && input.side !== "RIGHT")) {
      throw new GitHubPrReviewError("invalid_response", "Invalid review comment location");
    }
    const { detail, token } = await currentDetail(repository, input.number, input.headSha);
    const file = detail.files.find((candidate) => candidate.path === input.path);
    const anchor = file && anchorsForPatch(file.patch).find((candidate) =>
      candidate.line === input.line && candidate.side === input.side
      && (input.side === "RIGHT" ? candidate.type === "add" : candidate.type === "del"));
    if (!file || !anchor) throw new GitHubPrReviewError("stale_revision", "That changed line is no longer in the pull-request diff");
    await submit(dependencies.fetchImpl, token, apiPath(repository, `/pulls/${input.number}/comments`), {
      body,
      commit_id: detail.pullRequest.headSha,
      path: input.path,
      line: input.line,
      side: input.side,
    });
    return { htmlUrl: detail.pullRequest.htmlUrl };
  }

  async function review(repository: GitHubRepository, input: GitHubPrReviewSubmissionInput): Promise<GitHubPrReviewWriteResult> {
    const body = validateText(input.body);
    if (!(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as GitHubPullRequestReviewEvent[]).includes(input.event)) {
      throw new GitHubPrReviewError("invalid_response", "Invalid review action");
    }
    const { detail, token } = await currentDetail(repository, input.number, input.headSha);
    await submit(dependencies.fetchImpl, token, apiPath(repository, `/pulls/${input.number}/reviews`), {
      commit_id: detail.pullRequest.headSha,
      body,
      event: input.event,
    });
    return { htmlUrl: detail.pullRequest.htmlUrl };
  }

  return { comment, review };
}
