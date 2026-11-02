/** Shared public types grouped by the owning application domain. */
// --- Work panel (review / browser / files / plugin views) ---

export type DiffLineType = "add" | "del" | "context";

export type DiffLine = {
  type: DiffLineType;
  text: string;
  /** 1-based line number in the base side, when present in the hunk. */
  oldLine?: number;
  /** 1-based line number in the working-tree side, when present in the hunk. */
  newLine?: number;
};

export type DiffHunk = {
  /** Raw `@@ -a,b +c,d @@ …` header line. */
  header: string;
  lines: DiffLine[];
};

export type ReviewChangeOperation = "write" | "edit" | "delete";
export type ReviewChangeStatus = "added" | "modified" | "deleted";
export type ReviewChangeState = "active" | "rolledBack";

/**
 * Durable, message-owned change evidence returned by a workspace mutation.
 * Unlike WorkspaceDiff, this record remains valid after a git commit.
 */
export type ReviewChange = {
  version: 1;
  snapshotId: string;
  messageId: string;
  path: string;
  operation: ReviewChangeOperation;
  status: ReviewChangeStatus;
  state: ReviewChangeState;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary?: boolean;
  truncated?: boolean;
  reversible: boolean;
};

export type ReviewRollbackStatus =
  | "rolledBack"
  | "alreadyRolledBack"
  | "conflict"
  | "unavailable";

export type ReviewRollbackResult = {
  status: ReviewRollbackStatus;
  snapshotId: string;
  messageId?: string;
  path?: string;
};

export type DiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
  /** Patch exceeded the per-file cap; hunks are omitted. */
  tooLarge?: boolean;
  /** Revision token for rejecting feedback against a changed file diff. */
  anchorRevision?: string;
  hunks: DiffHunk[];
};

export type WorkspaceDiffBaseOption = {
  /** Full local or remote-tracking ref, e.g. `refs/remotes/origin/main`. */
  ref: string;
  /** Human-readable name shown in the base selector. */
  name: string;
  /** Commit currently resolved by the ref. */
  commit: string;
};

export type WorkspaceBranchReview = {
  baseRef: string;
  baseCommit: string;
  mergeBaseCommit: string;
  headCommit: string;
};

export type WorkspaceDiffBaseError = "invalid_base" | "no_merge_base" | "no_head";

export type WorkspaceDiffRequestOptions = {
  /** Full local or remote-tracking ref selected by the user. */
  baseRef?: string;
  /** Include selectable refs and compare against the default base when omitted. */
  includeBases?: boolean;
};

export type WorkspaceDiff = {
  /** Workspace root is a git work tree. */
  repo: boolean;
  /** No pending changes (only meaningful when repo). */
  clean: boolean;
  files: DiffFile[];
  /** File list hit the cap; more changes exist than listed. */
  truncated?: boolean;
  /** Current checked-out branch, or `detached` when HEAD is detached. */
  currentBranch?: string;
  /** Available local and remote-tracking bases; never fetched automatically. */
  baseOptions?: WorkspaceDiffBaseOption[];
  /** Selected merge-base comparison identity for Branch Review. */
  branchReview?: WorkspaceBranchReview;
  /** Why no branch diff is available for the requested base. */
  baseError?: WorkspaceDiffBaseError;
};

export type BrowserAction = "back" | "forward" | "reload" | "stop";

export type BrowserState = {
  /** Main-owned origin for retained browser resource tabs. */
  sessionId?: string;
  tabId?: string;
  /** Navigation failure; the previous document must not be presented as ready. */
  loadError?: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};
