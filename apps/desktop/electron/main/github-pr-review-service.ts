import type {
  GitHubCheck,
  GitHubCheckState,
  GitHubPullRequestDetailResult,
  GitHubPullRequestFile,
  GitHubPullRequestListResult,
  GitHubPullRequestSummary,
  GitHubRepository,
} from "@pi-desktop/shared";

const API_ROOT = "https://api.github.com";
const MAX_RESPONSE_BYTES = 3_000_000;
const MAX_PULL_REQUESTS = 50;
const MAX_FILES = 100;
const REQUEST_TIMEOUT_MS = 15_000;

export type GitHubPrReviewErrorCode =
  | "invalid_repository"
  | "auth_required"
  | "permission_denied"
  | "stale_revision"
  | "invalid_credentials"
  | "auth_cancelled"
  | "auth_expired"
  | "auth_failed"
  | "flow_pending"
  | "write_failed"
  | "not_found"
  | "rate_limited"
  | "response_too_large"
  | "unavailable"
  | "invalid_response";

export class GitHubPrReviewError extends Error {
  readonly code: GitHubPrReviewErrorCode;

  constructor(code: GitHubPrReviewErrorCode, message: string) {
    super(message);
    this.name = "GitHubPrReviewError";
    this.code = code;
  }
}

export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.slice(0, max)
    : null;
}

function repoFromParts(ownerValue: string, nameValue: string): GitHubRepository | null {
  const owner = ownerValue.replace(/\.git$/i, "");
  const name = nameValue.replace(/\.git$/i, "");
  const validSegment = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
  if (!validSegment.test(owner) || !validSegment.test(name)) return null;
  return { owner, name, fullName: `${owner}/${name}` };
}

/** Accept only GitHub.com remotes; no arbitrary URL can reach the fetcher. */
export function parseGitHubRemote(remote: string): GitHubRepository | null {
  const value = remote.trim();
  if (!value || value.length > 4096 || /[\u0000-\u001f]/.test(value)) return null;

  const scp = value.match(/^(?:[^@/:]+@)?github\.com:([^/]+)\/([^/]+)$/i);
  if (scp) return repoFromParts(scp[1], scp[2]);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!new Set(["https:", "ssh:"]).has(url.protocol) || url.hostname.toLowerCase() !== "github.com"
    || url.password || (url.protocol === "https:" && (url.username || url.port))
    || (url.protocol === "ssh:" && (url.username !== "git" || url.port && url.port !== "22"))) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return repoFromParts(parts[0], parts[1]);
}

function apiPath(repository: GitHubRepository, suffix = ""): string {
  const validated = repoFromParts(repository.owner, repository.name);
  if (!validated || validated.fullName !== repository.fullName) {
    throw new GitHubPrReviewError("invalid_repository", "Unsupported GitHub repository");
  }
  return `/repos/${encodeURIComponent(validated.owner)}/${encodeURIComponent(validated.name)}${suffix}`;
}

async function readBoundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new GitHubPrReviewError("response_too_large", "GitHub response exceeds the review limit");
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new GitHubPrReviewError("response_too_large", "GitHub response exceeds the review limit");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GitHubPrReviewError("response_too_large", "GitHub response exceeds the review limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function statusError(response: Response): GitHubPrReviewError {
  if (response.status === 401) {
    return new GitHubPrReviewError("auth_required", "GitHub authorization expired or was revoked");
  }
  if (response.status === 404) {
    return new GitHubPrReviewError("not_found", "Repository or pull request is not available to this account");
  }
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    return new GitHubPrReviewError("rate_limited", "GitHub API rate limit reached");
  }
  if (response.status === 403) {
    return new GitHubPrReviewError("permission_denied", "GitHub denied the requested permission");
  }
  return new GitHubPrReviewError("unavailable", `GitHub API request failed (${response.status})`);
}

async function fetchJson(fetchImpl: GitHubFetch, path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${API_ROOT}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "PI-Desktop",
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new GitHubPrReviewError("unavailable", "Could not reach the GitHub public API");
    }
    if (!response.ok) throw statusError(response);
    const text = await readBoundedText(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GitHubPrReviewError("invalid_response", "GitHub returned an invalid response");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function pullRequestSummary(value: unknown, repository: GitHubRepository): GitHubPullRequestSummary | null {
  if (!isRecord(value)) return null;
  const number = value.number;
  const title = boundedString(value.title, 300);
  const author = isRecord(value.user) ? boundedString(value.user.login, 100) : null;
  const baseRef = isRecord(value.base) ? boundedString(value.base.ref, 255) : null;
  const head = isRecord(value.head) ? value.head : null;
  const headRef = head ? boundedString(head.ref, 255) : null;
  const headSha = head ? boundedString(head.sha, 128) : null;
  const updatedAt = boundedString(value.updated_at, 64);
  if (!Number.isSafeInteger(number) || Number(number) < 1 || !title || !author
    || !baseRef || !headRef || !headSha || !updatedAt) return null;
  return {
    number: Number(number),
    title,
    state: value.state === "closed" ? "closed" : "open",
    draft: value.draft === true,
    author,
    htmlUrl: `https://github.com/${repository.fullName}/pull/${Number(number)}`,
    baseRef,
    headRef,
    headSha,
    updatedAt,
  };
}

function pullRequestFile(value: unknown): GitHubPullRequestFile | null {
  if (!isRecord(value)) return null;
  const path = boundedString(value.filename, 512);
  const rawStatus = value.status;
  const status = rawStatus === "added" || rawStatus === "modified" || rawStatus === "removed" || rawStatus === "renamed"
    ? rawStatus
    : "changed";
  if (!path) return null;
  const previousPath = boundedString(value.previous_filename, 512);
  const patch = boundedString(value.patch, 300_000);
  return {
    path,
    ...(previousPath ? { previousPath } : {}),
    status,
    additions: Number.isSafeInteger(value.additions) ? Math.max(0, Number(value.additions)) : 0,
    deletions: Number.isSafeInteger(value.deletions) ? Math.max(0, Number(value.deletions)) : 0,
    ...(patch ? { patch } : {}),
  };
}

function checkFromRun(value: unknown): GitHubCheck | null {
  if (!isRecord(value)) return null;
  const name = boundedString(value.name, 160);
  if (!name) return null;
  if (value.status !== "completed") return { name, state: "pending" };
  return { name, state: value.conclusion === "success" || value.conclusion === "neutral" || value.conclusion === "skipped"
    ? "success" : "failure" };
}

function combinedCheckState(checks: GitHubCheck[], statusState: unknown): GitHubCheckState {
  if (checks.some((check) => check.state === "failure") || statusState === "failure" || statusState === "error") return "failure";
  if (checks.some((check) => check.state === "pending") || statusState === "pending") return "pending";
  if (checks.length > 0 || statusState === "success") return "success";
  return "none";
}

function recordArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function createGitHubPrReviewService(fetchImpl: GitHubFetch) {
  return {
    async list(repository: GitHubRepository): Promise<GitHubPullRequestListResult> {
      const value = await fetchJson(fetchImpl,
        apiPath(repository, "/pulls?state=open&sort=updated&direction=desc&per_page=50"));
      if (!Array.isArray(value)) throw new GitHubPrReviewError("invalid_response", "GitHub returned an invalid pull-request list");
      const pullRequests = value.slice(0, MAX_PULL_REQUESTS)
        .map((item) => pullRequestSummary(item, repository))
        .filter((item): item is GitHubPullRequestSummary => item !== null);
      return { repository, pullRequests };
    },

    async detail(repository: GitHubRepository, number: number): Promise<GitHubPullRequestDetailResult> {
      if (!Number.isSafeInteger(number) || number < 1) {
        throw new GitHubPrReviewError("invalid_repository", "Invalid pull-request number");
      }
      const pullValue = await fetchJson(fetchImpl, apiPath(repository, `/pulls/${number}`));
      const pullRequest = pullRequestSummary(pullValue, repository);
      if (!pullRequest) throw new GitHubPrReviewError("invalid_response", "GitHub returned an invalid pull request");

      const [fileValue, checksValue, statusValue] = await Promise.all([
        fetchJson(fetchImpl, apiPath(repository, `/pulls/${number}/files?per_page=${MAX_FILES}`)),
        fetchJson(fetchImpl, apiPath(repository, `/commits/${encodeURIComponent(pullRequest.headSha)}/check-runs?per_page=${MAX_FILES}`))
          .catch(() => null),
        fetchJson(fetchImpl, apiPath(repository, `/commits/${encodeURIComponent(pullRequest.headSha)}/status`))
          .catch(() => null),
      ]);
      if (!Array.isArray(fileValue)) throw new GitHubPrReviewError("invalid_response", "GitHub returned an invalid pull-request diff");
      const files = fileValue.slice(0, MAX_FILES)
        .map(pullRequestFile)
        .filter((item): item is GitHubPullRequestFile => item !== null);
      const rawRuns = isRecord(checksValue) ? recordArray(checksValue.check_runs) : [];
      const checks = rawRuns.map(checkFromRun).filter((item): item is GitHubCheck => item !== null).slice(0, MAX_FILES);
      const statusState = isRecord(statusValue) ? statusValue.state : undefined;
      const checksUnavailable = checksValue === null && statusValue === null;
      return {
        repository,
        pullRequest,
        files,
        filesTruncated: fileValue.length >= MAX_FILES,
        checksState: checksUnavailable ? "unavailable" : combinedCheckState(checks, statusState),
        checks,
      };
    },
  };
}
