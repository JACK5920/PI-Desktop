/** Shared public types grouped by the owning application domain. */
import type { Mode } from "./common.js";
import type { GlobalPermissionMode } from "./permissions.js";

/** Approval-proposal discriminator (D198). Plan and Goal share one host
 * approval pipeline; `kind` selects prompts, artifact directory and copy. */
export type ProposalKind = "plan" | "goal";

export const PROPOSAL_KINDS = ["plan", "goal"] as const;

export function normalizeProposalKind(
  value: unknown,
  fallback: ProposalKind = "plan",
): ProposalKind {
  return value === "goal" || value === "plan" ? value : fallback;
}

/** The proposal kind a mode submits, or `null` for freely executing modes. */
export function proposalKindForMode(mode: Mode): ProposalKind | null {
  return mode === "plan" || mode === "goal" ? mode : null;
}

/** The operating mode that owns a proposal kind. */
export function modeForProposalKind(kind: ProposalKind): Mode {
  return kind;
}

export type PlanningState = "inactive" | "planning" | "awaiting_approval";
export type PlanApprovalAction = "approve" | "reject";
export type PlanApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "interrupted";

/** Compatibility name for the proposal-shaped approval wire record. */
export type PlanProposalStatus = PlanApprovalStatus;

export type PlanArtifact = {
  /** Workspace-relative path of the host-created plan artifact. */
  relativePath: string;
  sha256: string;
  sizeBytes: number;
};

export type PlanExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "interrupted";

export type PlanExecutionFinishStatus = Extract<
  PlanExecutionState,
  "completed" | "interrupted"
>;

export type PlanProposal = {
  /** Durable approval/proposal identity. */
  id: string;
  sessionId: string;
  /** Durable host turn ID owning the SubmitPlan/SubmitGoal call. */
  turnId: string;
  /** Exact SubmitPlan/SubmitGoal tool-call ID used to create this approval. */
  toolCallId: string;
  /** Which contract this approval carries; legacy rows read back as `plan`. */
  kind: ProposalKind;
  title: string;
  /** Exact Markdown snapshot submitted for approval. */
  markdown: string;
  question: string;
  artifact?: PlanArtifact;
  /** Host schema/version for this proposal snapshot. */
  version: number;
  status: PlanProposalStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  errorCode?: string;
  executionId?: string;
  executionState?: PlanExecutionState;
  /** Persisted snapshot alias retained by the host for compatibility. */
  plan: string;
};

/** Descriptor persisted by the host after approval and consumed by Main. */
export type PlanExecution = {
  id: string;
  proposalId: string;
  sessionId: string;
  /** Which contract was approved; drives the execution instruction. */
  kind: ProposalKind;
  /** Exact approved Markdown snapshot. */
  plan: string;
  title: string;
  question: string;
  artifact: PlanArtifact;
  targetPermissionMode: GlobalPermissionMode;
  state: PlanExecutionState;
};

export type GoalLifecycleStatus =
  | "active"
  | "paused"
  | "completed"
  | "blocked"
  | "interrupted"
  | "cleared";

/** Default execution-round budget, including the initial approved round. */
export const GOAL_DEFAULT_ROUNDS_PER_CYCLE = 8;
export const GOAL_MAX_ROUNDS_PER_CYCLE = 32;
export const GOAL_DEFAULT_TOKENS_PER_CYCLE = 250_000;
export const GOAL_DEFAULT_DURATION_MS_PER_CYCLE = 60 * 60 * 1_000;
export const GOAL_MIN_DURATION_MS_PER_CYCLE = 60 * 1_000;
export const GOAL_MAX_DURATION_MS_PER_CYCLE = 24 * 60 * 60 * 1_000;

export type GoalCriterionReport = {
  criterion: string;
  status: "met" | "unmet";
  /** Concrete verification output or artifact references supporting the claim. */
  evidence: string[];
};

export type GoalProgressReport = {
  outcome: "continue" | "complete" | "blocked";
  summary: string;
  criteria: GoalCriterionReport[];
};

/** Host-owned mutable execution state, separate from the immutable contract. */
export type GoalLifecycle = {
  proposalId: string;
  sessionId: string;
  /** Immutable title from the approved contract, included for restart rehydration. */
  title: string;
  status: GoalLifecycleStatus;
  currentExecutionId?: string;
  cycle: number;
  /** Persisted Host start time for displaying live elapsed time while active. */
  cycleStartedAt?: number;
  roundInCycle: number;
  runCount: number;
  maxRounds: number;
  maxTokens: number;
  maxDurationMs: number;
  /** Last finite token limit, retained when token cutoff is disabled. */
  tokenBudgetUnlimited?: boolean;
  tokensUsed: number;
  elapsedMs: number;
  stopReason?: string;
  latestReport?: GoalProgressReport;
  updatedAt: string;
  version: number;
};

/** Transient provider-reported usage for the current Goal execution. */
export type GoalProgressEvent = {
  sessionId: string;
  proposalId: string;
  executionId: string;
  turnId: string;
  /** Cycle total, including earlier settled rounds and this active turn. */
  tokensUsed: number;
};

export type GoalControlAction = "pause" | "resume" | "clear";

export type GoalControlRequest = {
  sessionId: string;
  proposalId: string;
  action: GoalControlAction;
};

export type GoalControlResult = {
  goal: GoalLifecycle;
  execution?: PlanExecution;
};

export type GoalBudget = {
  maxRounds: number;
  /** Last finite token limit, retained while token limiting is disabled. */
  maxTokens: number;
  maxDurationMs: number;
  tokenBudgetUnlimited: boolean;
};

export type GoalBudgetUpdateRequest = {
  sessionId: string;
  proposalId: string;
  budget: GoalBudget;
};

export type GoalBudgetUpdateResult = {
  goal: GoalLifecycle;
};

export type PlanExecutionDescriptor = PlanExecution;
export type ApprovedPlanExecution = PlanExecution;

export type PlanningStateEvent = {
  sessionId: string;
  state: PlanningState;
  /** Absent only for `inactive` transitions that carry no proposal. */
  kind?: ProposalKind;
  proposalId?: string;
  title?: string;
  markdown?: string;
  question?: string;
  artifact?: PlanArtifact;
  version?: number;
  plan?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  executionId?: string;
  executionState?: PlanExecutionState;
  proposal?: PlanProposal;
  goal?: GoalLifecycle | null;
};

export type PlansPendingResult = {
  plans: PlanProposal[];
  state?: PlanningState;
  /** Contract kind the session is currently negotiating, when any (D198). */
  kind?: ProposalKind;
  /** Session-specific active/latest lifecycle when `sessionId` was requested. */
  goal?: GoalLifecycle | null;
  /** Latest non-cleared lifecycle per session when the query was global. */
  goals?: GoalLifecycle[];
};

export type PlansQueuedExecutionsResult = {
  executions: PlanExecution[];
};

type PlanResolveIdentity = {
  proposalId: string;
  /** Identity fields must match the live host approval row exactly. */
  sessionId: string;
  turnId: string;
  toolCallId: string;
  version?: number;
};

export type PlanResolveRequest =
  | (PlanResolveIdentity & {
      action: "approve";
      targetPermissionMode: GlobalPermissionMode;
    })
  | (PlanResolveIdentity & {
      action: "reject";
      targetPermissionMode?: never;
    });

export type PlanResolutionResult = {
  ok: boolean;
  proposal: PlanProposal;
  state: PlanningState;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  execution?: PlanExecution;
  goal?: GoalLifecycle | null;
};

/** Current host state for one immutable plan/goal submission in a history page. */
export type PlanHistoryEntry = { proposal: PlanProposal; superseded: boolean };
