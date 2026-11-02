import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type {
  GitHubDiffSide,
  GitHubPrReviewLineCommentInput,
  GitHubPrReviewSubmissionInput,
} from "@pi-desktop/shared";
import {
  createGitHubPrReviewService,
  type GitHubFetch,
  GitHubPrReviewError,
  parseGitHubRemote,
} from "../github-pr-review-service.ts";
import { createGitHubPrReviewAuthService, type GitHubPrSecretStore } from "../github-pr-review-auth.ts";
import { createGitHubPrReviewWriteService } from "../github-pr-review-write-service.ts";
import type { IpcRegistrar } from "./types";

const execFileAsync = promisify(execFile);

type GitHubPrReviewIpcDependencies = {
  registrar: IpcRegistrar;
  sessionProjects: ReadonlyMap<string, string | null>;
  fetchImpl: GitHubFetch;
  secrets: GitHubPrSecretStore;
  openExternal: (url: string) => Promise<void>;
  readOrigin?: (path: string) => Promise<string>;
};

async function originForWorkspace(path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: path,
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 8192,
      encoding: "utf8",
      shell: false,
    });
    return stdout.trim();
  } catch {
    // Git stderr can contain the remote URL (including credentials); keep the
    // failure generic and never log or forward it to the Renderer.
    throw new GitHubPrReviewError("invalid_repository", "This workspace has no public GitHub origin");
  }
}

async function repositoryForSession(
  input: unknown,
  sessionProjects: ReadonlyMap<string, string | null>,
  readOrigin: (path: string) => Promise<string>,
) {
  const sessionId = input && typeof input === "object"
    ? (input as { sessionId?: unknown }).sessionId
    : undefined;
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 512) {
    throw Object.assign(new Error("session id required"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  }
  if (sessionId.startsWith("remote:")) {
    throw new GitHubPrReviewError("invalid_repository", "GitHub PR Review requires a local workspace");
  }
  const path = sessionProjects.get(sessionId);
  if (!path) throw new GitHubPrReviewError("invalid_repository", "This conversation has no local GitHub workspace");
  const repository = parseGitHubRemote(await readOrigin(path));
  if (!repository) throw new GitHubPrReviewError("invalid_repository", "Only public github.com repositories are supported");
  return repository;
}

export function registerGitHubPrReviewIpc({
  registrar,
  sessionProjects,
  fetchImpl,
  secrets,
  openExternal,
  readOrigin = originForWorkspace,
}: GitHubPrReviewIpcDependencies): void {
  const auth = createGitHubPrReviewAuthService({ secrets, fetchImpl, openExternal });
  const authenticatedFetch: GitHubFetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.origin !== "https://api.github.com") {
      throw new GitHubPrReviewError("invalid_repository", "Only GitHub.com API requests are supported");
    }
    const token = await auth.accessToken();
    if (!token) return fetchImpl(url, init);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetchImpl(url, { ...init, headers });
  };
  const service = createGitHubPrReviewService(authenticatedFetch);
  const writeService = createGitHubPrReviewWriteService({ fetchImpl, getAccessToken: () => auth.accessToken() });

  registrar.handle(IPC.invoke.githubPrReviewAuthStatus, () => auth.status());
  registrar.handle(IPC.invoke.githubPrReviewAuthConfigure, (input: unknown) => auth.configure(input));
  registrar.handle(IPC.invoke.githubPrReviewAuthStart, () => auth.start());
  registrar.handle(IPC.invoke.githubPrReviewAuthWait, () => auth.wait());
  registrar.handle(IPC.invoke.githubPrReviewAuthCancel, () => auth.cancel());
  registrar.handle(IPC.invoke.githubPrReviewAuthDisconnect, () => auth.disconnect());
  registrar.handle(IPC.invoke.githubPrReviewAuthClearConfiguration, () => auth.clearConfiguration());

  registrar.handle(IPC.invoke.githubPullRequestList, async (input: unknown = {}) => {
    const repository = await repositoryForSession(input, sessionProjects, readOrigin);
    return service.list(repository);
  });
  registrar.handle(IPC.invoke.githubPullRequestDetail, async (input: unknown = {}) => {
    const repository = await repositoryForSession(input, sessionProjects, readOrigin);
    const number = input && typeof input === "object"
      ? (input as { number?: unknown }).number
      : undefined;
    if (!Number.isSafeInteger(number) || Number(number) < 1) {
      throw Object.assign(new Error("pull-request number must be a positive integer"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return service.detail(repository, Number(number));
  });

  registrar.handle(IPC.invoke.githubPrReviewComment, async (input: unknown = {}) => {
    const repository = await repositoryForSession(input, sessionProjects, readOrigin);
    const request = parseLineCommentInput(input);
    return writeService.comment(repository, request);
  });

  registrar.handle(IPC.invoke.githubPrReviewSubmit, async (input: unknown = {}) => {
    const repository = await repositoryForSession(input, sessionProjects, readOrigin);
    const request = parseReviewSubmissionInput(input);
    return writeService.review(repository, request);
  });
}

function invalidArgument(message: string): never {
  throw Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseLineCommentInput(input: unknown): GitHubPrReviewLineCommentInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalidArgument("review comment must be an object");
  const value = input as Record<string, unknown>;
  if (!hasExactKeys(value, ["sessionId", "number", "headSha", "path", "line", "side", "body"])
    || typeof value.sessionId !== "string" || typeof value.number !== "number"
    || typeof value.headSha !== "string" || typeof value.path !== "string"
    || typeof value.line !== "number" || (value.side !== "LEFT" && value.side !== "RIGHT")
    || typeof value.body !== "string") return invalidArgument("review comment fields are invalid");
  return {
    sessionId: value.sessionId,
    number: value.number,
    headSha: value.headSha,
    path: value.path,
    line: value.line,
    side: value.side as GitHubDiffSide,
    body: value.body,
  };
}

function parseReviewSubmissionInput(input: unknown): GitHubPrReviewSubmissionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalidArgument("review submission must be an object");
  const value = input as Record<string, unknown>;
  if (!hasExactKeys(value, ["sessionId", "number", "headSha", "event", "body"])
    || typeof value.sessionId !== "string" || typeof value.number !== "number"
    || typeof value.headSha !== "string" || typeof value.body !== "string"
    || (value.event !== "COMMENT" && value.event !== "APPROVE" && value.event !== "REQUEST_CHANGES")) {
    return invalidArgument("review submission fields are invalid");
  }
  return {
    sessionId: value.sessionId,
    number: value.number,
    headSha: value.headSha,
    event: value.event,
    body: value.body,
  };
}
