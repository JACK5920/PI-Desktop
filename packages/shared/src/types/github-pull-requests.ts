export type GitHubRepository = {
  owner: string;
  name: string;
  fullName: string;
};

export type GitHubPullRequestSummary = {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  author: string;
  htmlUrl: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  updatedAt: string;
};

export type GitHubPullRequestFileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "changed";

export type GitHubPullRequestFile = {
  path: string;
  previousPath?: string;
  status: GitHubPullRequestFileStatus;
  additions: number;
  deletions: number;
  patch?: string;
};

export type GitHubCheckState =
  | "success"
  | "failure"
  | "pending"
  | "none"
  | "unavailable";

export type GitHubCheck = {
  name: string;
  state: "success" | "failure" | "pending";
};

export type GitHubPullRequestReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type GitHubDiffSide = "LEFT" | "RIGHT";

export type GitHubPrReviewAuthStatus = {
  configured: boolean;
  connected: boolean;
  pending: boolean;
  login?: string;
  expiresAt?: number;
};

export type GitHubPrReviewAppCredentials = {
  clientId: string;
  clientSecret: string;
};

export type GitHubPrReviewLineCommentInput = {
  sessionId: string;
  number: number;
  headSha: string;
  path: string;
  line: number;
  side: GitHubDiffSide;
  body: string;
};

export type GitHubPrReviewSubmissionInput = {
  sessionId: string;
  number: number;
  headSha: string;
  event: GitHubPullRequestReviewEvent;
  body: string;
};

export type GitHubPrReviewWriteResult = {
  htmlUrl: string;
};

export type GitHubPullRequestListResult = {
  repository: GitHubRepository;
  pullRequests: GitHubPullRequestSummary[];
};

export type GitHubPullRequestDetailResult = {
  repository: GitHubRepository;
  pullRequest: GitHubPullRequestSummary;
  files: GitHubPullRequestFile[];
  filesTruncated: boolean;
  checksState: GitHubCheckState;
  checks: GitHubCheck[];
};
