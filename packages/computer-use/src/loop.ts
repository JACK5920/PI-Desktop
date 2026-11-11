/**
 * The bounded perceive-decide-act loop (ADR 0342 §9).
 *
 * Electron-independent on purpose: everything the loop needs — observing,
 * acting, asking the bound model, drawing the cursor — arrives as an injected
 * dependency, so the schema, the validation, the step limits, and the stop
 * conditions are testable against scripted model answers without a provider,
 * a window, or a running app.
 *
 * The loop decides nothing about authority. It cannot widen a scope, raise a
 * budget, or retry past a refusal: the host re-checks every action anyway, and
 * a refusal here is final for that step.
 */
import {
  COMPUTER_MAX_STEPS_LIMIT,
  COMPUTER_USE_DEFAULTS,
  type ComputerAction,
  type ComputerActResult,
  type ComputerCursorEvent,
  type ComputerInspection,
  type ComputerLoopActivity,
  type ComputerRunOutcome,
  type ComputerRunResult,
  type ComputerStepRecord,
  type ComputerUseVerification,
} from "@pi-desktop/shared";

import { parseLoopAnswer, validateAnswerAction, type LoopAnswer } from "./answer.js";
import {
  buildDecisionRequest,
  windowLabel,
  type DecisionRequest,
  type Observation,
} from "./prompt.js";

export type ComputerLoopDeps = {
  /**
   * Fresh accessibility tree, grant view, window list, and capture when pixels
   * are allowed. A `targetId` asks the host to bind that window first; the host
   * re-applies every refusal, so this is a request, not a move.
   */
  observe: (targetId?: string) => Promise<Observation>;
  /** One host action. It throws a coded error when the host refuses. */
  act: (action: ComputerAction, expectedRevision: number) => Promise<ComputerActResult>;
  /** One request to the bound model. Returns raw text; the loop parses it. */
  decide: (request: DecisionRequest) => Promise<string>;
  onStep?: (step: ComputerStepRecord) => void;
  onCursor?: (event: ComputerCursorEvent) => void;
  onActivity?: (activity: ComputerLoopActivity) => void;
};

export type ComputerLoopInput = {
  instruction: string;
  maxSteps?: number;
  observeOnly?: boolean;
};

/** Consecutive unusable model answers before the loop gives up. */
const MAX_INVALID_ANSWERS = 2;
/** Consecutive identical refusals before the loop stops trying. */
const MAX_REPEATED_REFUSALS = 2;

/**
 * Outcomes that end the run whatever step produced them: the grant itself is
 * gone, so there is nothing left to retry against.
 */
const GRANT_LEVEL_OUTCOMES: ReadonlySet<ComputerRunOutcome> = new Set<ComputerRunOutcome>([
  "revoked",
  "expired",
  "budget-exhausted",
]);

/** Outcomes a host refusal maps to, so the caller sees why work stopped. */
const TERMINAL_CODES: Record<string, ComputerRunOutcome> = {
  COMPUTER_GRANT_EXPIRED: "expired",
  COMPUTER_NO_GRANT: "revoked",
  COMPUTER_GRANT_IN_USE: "revoked",
  COMPUTER_BUDGET_EXHAUSTED: "budget-exhausted",
  COMPUTER_SELF_TARGET_REFUSED: "failed",
  COMPUTER_SECURE_INPUT_REFUSED: "failed",
  COMPUTER_TARGET_DENYLISTED: "failed",
  COMPUTER_TARGET_UNAVAILABLE: "failed",
  COMPUTER_PLATFORM_UNSUPPORTED: "failed",
  COMPUTER_OS_PERMISSION_MISSING: "failed",
  COMPUTER_TARGET_ELEVATED: "failed",
  COMPUTER_SCOPE_VIOLATION: "failed",
};

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("COMPUTER_")) return code;
  }
  return "COMPUTER_ACTION_REJECTED";
}

/** Retry only a named target that the host says is temporarily unavailable. */
async function observeWithTargetRetry(
  deps: ComputerLoopDeps,
  targetId?: string,
): Promise<Observation> {
  const attempts = targetId ? 3 : 1;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await deps.observe(targetId);
    } catch (error) {
      if (errorCode(error) !== "COMPUTER_TARGET_UNAVAILABLE" || attempt + 1 >= attempts) throw error;
      // Stay pinned to the exact host-issued id. Never fall back to the
      // foreground window or silently select a different target.
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

/** Resolve a model switch request only against this observation's host-issued windows. */
function resolveSwitchTarget(observation: Observation, requested: string): string | undefined {
  const windows = observation.windows ?? [];
  const exact = windows.find((window) => window.targetId === requested);
  if (exact) return exact.targetId;

  // Compatibility for models that copied the old rendered `id label — title`
  // string into the id field. Accept only the exact display string generated
  // from one item in this observation; never prefix-match or parse arbitrary
  // text into a target, and always pass the canonical opaque id to Host.
  const copiedDisplay = windows.find((window) => {
    const title = window.title.trim() ? ` — ${window.title}` : "";
    return requested === `${window.targetId} ${window.appName}${title}`;
  });
  return copiedDisplay?.targetId;
}

/** A short, value-free description of what a step acted on. */
function describeTarget(action: ComputerAction, label?: string): string | undefined {
  if (label) return label;
  if (action.uid) return `element ${action.uid}`;
  if (action.point) return `point ${Math.round(action.point.x)},${Math.round(action.point.y)}`;
  return undefined;
}

function summarize(
  outcome: ComputerRunOutcome,
  steps: readonly ComputerStepRecord[],
  modelSummary?: string,
  errorCodeValue?: string,
): string {
  // Reading is not doing: observations and window switches never appear as
  // something the agent changed on the user's machine.
  const ran = steps.filter((step) => step.action !== "observe" && step.action !== "switch");
  const actions = ran.filter((step) => step.action !== "done" && step.action !== "ask");
  const done = actions.filter((step) => step.ok);
  const lines: string[] = [];
  lines.push(
    actions.length === 0
      ? "No action was dispatched."
      : `Dispatched ${done.length} of ${actions.length} action${actions.length === 1 ? "" : "s"}: ${done
          .map((step) => (step.target ? `${step.action} on ${step.target}` : step.action))
          .join("; ") || "none succeeded"}.`,
  );
  switch (outcome) {
    case "done":
      break;
    case "step-limit":
      lines.push("Stopped at the step limit for this call; the task may be unfinished.");
      break;
    case "budget-exhausted":
      lines.push("Stopped because the grant's action budget ran out.");
      break;
    case "revoked":
      lines.push("Stopped because the grant was revoked or is no longer held by this session.");
      break;
    case "expired":
      lines.push("Stopped because the grant expired.");
      break;
    case "needs-user":
      lines.push("Stopped to ask the user a question.");
      break;
    case "unverified":
      lines.push("Stopped without claiming completion because current UIA evidence could not be verified; no input action was replayed.");
      break;
    case "failed":
      lines.push(`Stopped after a refusal${errorCodeValue ? ` (${errorCodeValue})` : ""}.`);
      break;
  }
  if (modelSummary) {
    // Labelled, length-bounded, and parsed — never pasted in as the result.
    lines.push(`Model's account: ${modelSummary}`);
  }
  return lines.join(" ");
}

/** Compare only the safe accessibility shape; values and captured pixels never enter this diff. */
function observationSignature(observation: Observation): string {
  return JSON.stringify({
    targetId: observation.grant.targetId,
    bounds: observation.inspection.bounds,
    fidelity: observation.inspection.fidelity,
    truncated: observation.inspection.truncated,
    secureInput: observation.inspection.secureInput,
    nodes: observation.inspection.nodes.map((node) => ({
      // `identity`, never `uid`. The cua backend re-mints uid from a fresh
      // snapshot on every read, so including it made both observations differ
      // every time — `observed-no-change` could never be reached and the loop
      // lost its only signal that an action did nothing.
      identity: node.identity ?? node.uid,
      role: node.role,
      label: node.label,
      hasValue: node.hasValue,
      enabled: node.enabled,
      focused: node.focused,
      // `bounds` and `parent` are omitted on purpose: the cua backend reports
      // bounds as absent, and `parent` is an array index that shifts whenever a
      // node is inserted, which would report "changed" for an unrelated edit.
      actions: node.actions,
    })),
  });
}

/**
 * What must still match for a cited element to count as "the same element,
 * unchanged".
 *
 * Deliberately value-free and index-free: `bounds` is absent on the cua backend
 * and `parent` is an array index that shifts when any node is inserted, so
 * including either would fail the check for reasons unrelated to the cited
 * element.
 */
function nodeSignature(node: ComputerInspection["nodes"][number]): string {
  return JSON.stringify({
    role: node.role,
    label: node.label,
    hasValue: node.hasValue,
    enabled: node.enabled,
    focused: node.focused,
    actions: node.actions,
  });
}

/**
 * The current CUA identity fallback is a role/ordinal path. When two siblings
 * expose the same accessibility shape, that path cannot prove which physical
 * control survived an insertion or reorder. Refuse completion evidence for
 * that ambiguous case rather than treating an indistinguishable sibling as the
 * cited element.
 */
function hasAmbiguousIdentity(
  node: ComputerInspection["nodes"][number],
  nodes: readonly ComputerInspection["nodes"][number][],
): boolean {
  if (!node.identity) return false;
  const separator = node.identity.lastIndexOf("/");
  const parentPath = separator < 0 ? "" : node.identity.slice(0, separator);
  return nodes.some((candidate) => {
    if (candidate.identity === node.identity || candidate.role !== node.role || !candidate.identity) return false;
    const candidateSeparator = candidate.identity.lastIndexOf("/");
    const candidateParent = candidateSeparator < 0 ? "" : candidate.identity.slice(0, candidateSeparator);
    return (
      candidateParent === parentPath &&
      nodeSignature(candidate) === nodeSignature(node)
    );
  });
}

/**
 * The verification recorded on the most recent action the agent actually
 * dispatched, ignoring reads.
 *
 * `unverified-by-design` keys off this: only an `observed-no-change` read-back
 * proves the tree really did stay still, which is the one situation where
 * "UIA cannot express this" is a fact rather than an excuse.
 */
function lastDispatchedVerification(
  steps: readonly ComputerStepRecord[],
): ComputerUseVerification | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.action === "observe" || step.action === "switch") continue;
    if (step.action === "done" || step.action === "ask") continue;
    return step.verification;
  }
  return undefined;
}

/**
 * The kind of the most recent action the agent actually dispatched.
 *
 * It matters for the completion gate: a write's result is the content of a
 * field, and the accessibility tree never publishes a field's content. So
 * after a write there is nothing in the tree that can support the result,
 * and an empty evidence list is the only honest answer -- not a sign that the
 * model forgot to cite.
 */
function lastDispatchedActionKind(
  steps: readonly ComputerStepRecord[],
): ComputerStepRecord["action"] | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.action === "observe" || step.action === "switch") continue;
    if (step.action === "done" || step.action === "ask") continue;
    return step.action;
  }
  return undefined;
}

function validateCompletionEvidence(
  evidence: readonly string[],
  decisionObservation: Observation,
  currentObservation: Observation,
): boolean {
  if (evidence.length === 0) return false;
  // The UI may have changed while the model was responding. Re-check the
  // Host-bound target and cited value-free nodes, without failing completion
  // because an unrelated control elsewhere in the window changed.
  if (
    decisionObservation.grant.targetId !== currentObservation.grant.targetId ||
    decisionObservation.inspection.fidelity !== currentObservation.inspection.fidelity ||
    decisionObservation.inspection.truncated !== currentObservation.inspection.truncated ||
    decisionObservation.inspection.secureInput !== currentObservation.inspection.secureInput ||
    JSON.stringify(decisionObservation.inspection.bounds) !== JSON.stringify(currentObservation.inspection.bounds)
  ) return false;
  // The model cites `uid` because that is what it was shown, but a uid only
  // means anything within one observation: the cua backend re-mints every uid
  // from a fresh snapshot on each read. So the lookup is two-step — resolve the
  // cited uid in the observation the model decided from, then follow that
  // node's identity into the current one.
  //
  // Before this, both maps were keyed by uid and their key sets never
  // intersected, so this function returned false unconditionally: `done` could
  // not succeed on the cua backend at all.
  const decisionByUid = new Map(decisionObservation.inspection.nodes.map((node) => [node.uid, node]));
  const currentByIdentity = new Map(
    currentObservation.inspection.nodes.map((node) => [node.identity ?? node.uid, node]),
  );
  return evidence.every((uid) => {
    const before = decisionByUid.get(uid);
    if (before === undefined) return false;
    if (
      hasAmbiguousIdentity(before, decisionObservation.inspection.nodes) ||
      hasAmbiguousIdentity(before, currentObservation.inspection.nodes)
    ) return false;
    const current = currentByIdentity.get(before.identity ?? before.uid);
    return current !== undefined && nodeSignature(before) === nodeSignature(current);
  });
}

/**
 * The identities of the nodes whose accessibility shape differs between two
 * observations.
 *
 * `observationSignature` answers "did anything change at all". This answers
 * "what changed", which is the difference between two cases that look alike
 * from the outside:
 *
 *  - a click on a button whose own label changes -- the change is in the
 *    element the model acted on, so the element is the evidence;
 *  - a write into a text field -- the field itself reports the same thing it
 *    always reports (`has-value`, no content), and only an adjacent node
 *    changes (a character count). The field's content is not published, so
 *    there is nothing in the tree that supports the result.
 */
function changedNodeIdentities(before: Observation, after: Observation): Set<string> {
  const changed = new Set<string>();
  const afterByIdentity = new Map(
    after.inspection.nodes.map((node) => [node.identity ?? node.uid, node]),
  );
  for (const node of before.inspection.nodes) {
    const identity = node.identity ?? node.uid;
    const current = afterByIdentity.get(identity);
    if (!current || nodeSignature(node) !== nodeSignature(current)) {
      changed.add(identity);
    }
  }
  return changed;
}

/**
 * True when the tree changed somewhere the model cannot cite.
 *
 * The change has to exist -- otherwise the result may be real but the window
 * did not move at all -- and the element the last action acted on must NOT be
 * among the changed ones. When the acted-on element is the one that changed,
 * its new state is the evidence and the model has to cite it; when the change
 * is somewhere else, the acted-on element reports exactly what it always
 * reports and the result is not expressible in the tree.
 */
function changedWhereResultIsNotExpressible(
  before: Observation,
  after: Observation,
  actedIdentity: string | undefined,
): boolean {
  if (!actedIdentity) return false;
  const changed = changedNodeIdentities(before, after);
  if (changed.size === 0) return false;
  return !changed.has(actedIdentity);
}

/**
 * True when the model cited the element the last action consumed.
 *
 * A menu item disappears the moment it is clicked — that is what closing a
 * menu means. The model then cites a uid that no longer resolves, and the
 * completion evidence check refuses a click that plainly landed.
 *
 * The bar stays strict: the citation must name the element the last
 * dispatched action acted on, that element must have been present in the
 * observation the model decided from, and it must be gone now. A model
 * cannot reach this by citing something it never saw.
 */
function citedElementConsumed(
  evidence: readonly string[],
  decisionObservation: Observation,
  currentObservation: Observation,
  actedIdentity: string | undefined,
): boolean {
  if (evidence.length === 0 || !actedIdentity) return false;
  const decisionByUid = new Map(decisionObservation.inspection.nodes.map((node) => [node.uid, node]));
  const cited = evidence.map((uid) => decisionByUid.get(uid)).filter((node) => node !== undefined);
  if (cited.length !== evidence.length) return false;
  if (!cited.every((node) => (node.identity ?? node.uid) === actedIdentity)) return false;
  const currentByIdentity = new Map(
    currentObservation.inspection.nodes.map((node) => [node.identity ?? node.uid, node]),
  );
  return !currentByIdentity.has(actedIdentity);
}


/**
 * Detect an action the model already dispatched against the same target.
 *
 * A value write is not observable in the tree the model sees: the element list
 * renders `has-value`, never the value itself, so the model cannot tell "my
 * write landed" from "my write never happened". A real run answered that by
 * writing the same value into the same field thirteen times, each write
 * re-minting the uid and making the tree look different again.
 *
 * The guard covers only writes, never clicks, keys or scrolls: repeating
 * those can be exactly what the task needs.
 *
 * The key deliberately does not include the action kind. `set_value` and
 * `type_text` put the same characters into the same field, so a model that
 * alternates between them is still writing the same value over and over.
 *
 * Measured: a model asked to type one line into a document alternated
 * `type_text` and `set_value` with the same text for eight steps, because
 * the element list never shows the field's content -- the model could not
 * tell a landed write from a lost one, and it kept looking for one.
 *
 * The price is that a task that genuinely means "write this text twice" is
 * refused the second time. That is the right side to err on: the model
 * cannot see the field's content, so it cannot tell the two cases apart
 * either, and a repeated write is far more often a lost write than a
 * deliberate repetition.
 */
function repeatedWriteKey(action: ComputerAction, node: ComputerInspection["nodes"][number] | undefined): string | undefined {
  if (action.kind !== "set_value" && action.kind !== "type_text") return undefined;
  if (!node) return undefined;
  const identity = node.identity ?? node.uid;
  const payload = action.text ?? "";
  return JSON.stringify([identity, payload]);
}


export async function runComputerLoop(
  input: ComputerLoopInput,
  deps: ComputerLoopDeps,
): Promise<ComputerRunResult> {
  const steps: ComputerStepRecord[] = [];
  // The caller's own ceiling, clamped by the shared limit. The grant's action
  // budget is enforced by the host and can cut a run shorter than this.
  const maxSteps = Math.max(
    1,
    Math.min(input.maxSteps ?? COMPUTER_USE_DEFAULTS.maxStepsPerCall, COMPUTER_MAX_STEPS_LIMIT),
  );
  let invalidAnswers = 0;
  let lastRefusal: string | undefined;
  let repeatedRefusals = 0;
  let index = 0;
  // Writes already dispatched, keyed by target identity + action + payload.
  // A write the model cannot see succeed is the one it will happily repeat.
  const dispatchedWrites = new Set<string>();
  // Whether the host confirmed the most recent content write by reading the
  // field back, and which step that confirmation belongs to. `undefined` means
  // the backend could not tell.
  //
  // The confirmation is bound to its step. A run-scoped flag would carry an
  // old verdict forward: a confirmed write followed by a click that did
  // nothing would still let the model close with an empty evidence list and
  // be told the result was confirmed.
  let writeConfirmed: { step: number } | undefined;

  const record = (step: ComputerStepRecord) => {
    steps.push(step);
    deps.onStep?.(step);
  };
  // Identity of the element the last dispatched action acted on. A menu item
  // disappears the moment it is clicked, so the model ends up citing a uid
  // that no longer resolves; this is what lets the loop recognise that case
  // instead of refusing a click that plainly landed.
  let lastActedIdentity: string | undefined;
  const updateStepVerification = (stepIndex: number, action: ComputerStepRecord["action"], verification: ComputerUseVerification) => {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i].index === stepIndex && steps[i].action === action) {
        // A refused step has no read-back to report. The action never
        // reached the application, so the tree that follows says nothing
        // about it -- writing "observed-change" onto a refusal would claim
        // the application reacted to something it never received.
        if (!steps[i].ok) return;
        steps[i] = { ...steps[i], verification };
        deps.onStep?.(steps[i]);
        return;
      }
    }
  };

  let observation: Observation;
  try {
    deps.onActivity?.({ phase: "observing", stepIndex: 0 });
    observation = await observeWithTargetRetry(deps);
  } catch (error) {
    const code = errorCode(error);
    deps.onActivity?.({ phase: "failed", errorCode: code });
    return {
      outcome: TERMINAL_CODES[code] ?? "failed",
      summary: summarize("failed", steps, undefined, code),
      steps,
      errorCode: code,
    };
  }

  if (input.observeOnly) {
    record({ index: 0, action: "observe", ok: true, verification: "observed" });
    const elements = observation.inspection.nodes.length;
    return {
      outcome: "done",
      verification: "observation-only",
      summary: `Observed ${observation.grant.targetLabel}: ${elements} accessible element${
        elements === 1 ? "" : "s"
      }${observation.inspection.truncated ? " (list truncated)" : ""}${
        observation.inspection.fidelity === "partial" ? ", partial accessibility fidelity" : ""
      }.`,
      steps,
    };
  }

  deps.onCursor?.({ kind: "show", grantId: observation.grant.grantId, bounds: observation.grant.bounds });

  try {
    while (index < maxSteps) {
      const request = buildDecisionRequest(input.instruction, observation, steps);
      let answer: LoopAnswer;
      deps.onActivity?.({ phase: "thinking", stepIndex: index + 1 });
      const raw = await deps.decide(request);
      const parsed = parseLoopAnswer(raw);
      if (!parsed.ok) {
        invalidAnswers += 1;
        record({
          index,
          action: "done",
          ok: false,
          errorCode: "COMPUTER_ACTION_REJECTED",
          // The shape travels with the refusal so a later diagnosis can tell a
          // typo in `kind` from a wholly different schema. It is keys and types
          // only — the model's prose never reaches this record.
          target: parsed.shape ? `${parsed.reason} (${parsed.shape})` : parsed.reason,
          verification: "refused",
        });
        if (invalidAnswers >= MAX_INVALID_ANSWERS) {
          return {
            outcome: "failed",
            summary: summarize("failed", steps, undefined, "COMPUTER_ACTION_REJECTED"),
            steps,
            errorCode: "COMPUTER_ACTION_REJECTED",
          };
        }
        // An unusable model response did not perform an action. Retry it
        // against the same observation instead of burning the action-step
        // budget; MAX_INVALID_ANSWERS still bounds malformed-output retries.
        continue;
      }
      answer = parsed.answer;

      if (answer.kind === "done") {
        const decisionObservation = observation;
        deps.onActivity?.({ phase: "observing", stepIndex: index + 1 });
        observation = await observeWithTargetRetry(deps, decisionObservation.grant.targetId);
        deps.onActivity?.({ phase: "verifying", stepIndex: index + 1 });
        if (validateCompletionEvidence(answer.evidence, decisionObservation, observation)) {
          record({
            index,
            action: "done",
            ok: true,
            verification: "model-confirmed",
            evidenceCount: answer.evidence.length,
          });
          return {
            outcome: "done",
            verification: "model-confirmed",
            summary: `${summarize("done", steps, answer.summary)} Completion cites ${answer.evidence.length} element(s) from the latest accessibility observation; this is model-confirmed UIA evidence, not independent semantic proof.`,
            steps,
          };
        }

        // A result UIA cannot express — a text selection, a scroll position,
        // keyboard focus, the content of a text field — leaves nothing the
        // model can cite: the element list shows that the field holds a
        // value, never which value. Without this the model has two options,
        // both bad: retry until the step limit, or cite an unrelated node and
        // claim evidence it does not have.
        //
        // The bar is deliberately specific: the agent must cite nothing, must
        // have actually dispatched something, and that action's read-back must
        // be honest about what the tree did. That is a self-report, and it is
        // labelled as one — never as verified.
        //
        // Both read-backs qualify. A tree that did not change is the case
        // this was written for: the result is real but invisible. A tree that
        // did change is the case measured on a text field: the write landed
        // and the tree changed, but the changed thing is the field's content,
        // which UIA does not publish -- so there is still nothing to cite,
        // and refusing the completion would only make the model guess at a
        // node it did not act on.
        // The host confirmed the content write by reading the field back.
        // That is a stronger fact than anything in the tree: the tree never
        // publishes a field's content, so the model cannot cite it, and the
        // write is nonetheless known to have landed exactly as asked.
        // The confirmation only speaks for the step it belongs to, and only
        // while that step is still the most recent dispatched action.
        const lastStep = steps.length ? steps[steps.length - 1] : undefined;
        const confirmationStillApplies =
          writeConfirmed !== undefined &&
          lastStep !== undefined &&
          lastStep.index === writeConfirmed.step &&
          lastStep.ok &&
          (lastStep.action === "set_value" || lastStep.action === "type_text");
        if (answer.evidence.length === 0 && confirmationStillApplies) {
          record({
            index,
            action: "done",
            ok: true,
            verification: "model-confirmed",
          });
          deps.onActivity?.({
            phase: "verifying",
            stepIndex: index + 1,
            verification: "model-confirmed",
          });
          return {
            outcome: "done",
            verification: "model-confirmed",
            summary: `${summarize("done", steps, answer.summary)} The host read the field back and confirmed it holds exactly the text that was written; the field's content is not published in the element list, so there is no element to cite.`,
            steps,
          };
        }

        const lastVerification = lastDispatchedVerification(steps);
        const lastKind = lastDispatchedActionKind(steps);
        const wroteContent = lastKind === "set_value" || lastKind === "type_text";
        const resultIsNotExpressible =
          lastVerification === "observed-no-change" ||
          (lastVerification === "observed-change" &&
            (wroteContent ||
              changedWhereResultIsNotExpressible(
                decisionObservation,
                observation,
                lastActedIdentity,
              )));
        if (
          answer.evidence.length === 0 &&
          steps.some((step) => step.ok && step.action !== "observe" && step.action !== "switch") &&
          resultIsNotExpressible
        ) {
          record({
            index,
            action: "done",
            ok: false,
            verification: "unverified-by-design",
          });
          deps.onActivity?.({
            phase: "unverified",
            stepIndex: index + 1,
            verification: "unverified-by-design",
          });
          const changed = lastVerification === "observed-change";
          return {
            outcome: "unverified",
            verification: "unverified-by-design",
            summary: `${summarize("unverified", steps, answer.summary)} The action was dispatched and the accessibility tree ${
              changed ? "changed, but not in a way that publishes the result" : "did not change"
            }; this outcome is self-reported because UIA cannot express the result.`,
            steps,
          };
        }

        // The cited element is gone because the action consumed it. A menu
        // item disappears the moment it is clicked — that is what closing a
        // menu means — so the model cites a uid that can no longer resolve and
        // the evidence check refuses a click that plainly landed.
        //
        // The bar stays as strict as the no-change case: the action must have
        // been dispatched, and the cited elements must all have existed in
        // the observation the model decided from and be absent now. A model
        // cannot reach this by citing something it never saw.
        if (
          steps.some((step) => step.ok && step.action !== "observe" && step.action !== "switch" && step.action !== "done" && step.action !== "ask") &&
          citedElementConsumed(answer.evidence, decisionObservation, observation, lastActedIdentity)
        ) {
          record({
            index,
            action: "done",
            ok: false,
            verification: "unverified-by-design",
            evidenceCount: answer.evidence.length,
          });
          deps.onActivity?.({
            phase: "unverified",
            stepIndex: index + 1,
            verification: "unverified-by-design",
          });
          return {
            outcome: "unverified",
            verification: "unverified-by-design",
            summary: `${summarize("unverified", steps, answer.summary)} The action was dispatched and the element it acted on is gone from the accessibility tree, as a clicked menu item is; this outcome is self-reported because UIA cannot show the result.`,
            steps,
          };
        }

        invalidAnswers += 1;
        record({ index, action: "done", ok: false, verification: "unverified", target: "missing or stale UIA evidence" });
        deps.onActivity?.({ phase: "observing", stepIndex: index + 1, verification: "unverified" });
        if (invalidAnswers >= MAX_INVALID_ANSWERS) {
          return {
            outcome: "unverified",
            verification: "unverified",
            summary: summarize("unverified", steps, answer.summary),
            steps,
          };
        }
        // The fresh Host observation above is read-only; never replay a click,
        // keystroke, or other possibly non-idempotent action.
        continue;
      }
      if (answer.kind === "ask") {
        invalidAnswers = 0;
        deps.onActivity?.({ phase: "asking", stepIndex: index + 1 });
        record({ index, action: "ask", ok: true, target: answer.question });
        return {
          outcome: "needs-user",
          summary: summarize("needs-user", steps),
          steps,
          question: answer.question,
        };
      }

      if (answer.kind === "switch") {
        invalidAnswers = 0;
        const targetId = resolveSwitchTarget(observation, answer.window);
        const label = targetId
          ? windowLabel(observation, targetId) ?? `window ${targetId}`
          : `window ${answer.window}`;
        try {
          if (!targetId) {
            throw Object.assign(new Error("switch target is not an exact id or displayed entry from the current observation"), {
              code: "COMPUTER_TARGET_UNAVAILABLE",
            });
          }
          // Switching to the window already in focus changes nothing, and it
          // is not a failure: the model asked to be there and the host is
          // there. Recorded as a refusal it told the model the switch had
          // failed, and a model that could not find its window answered by
          // switching again and again until the step limit ran out.
          //
          // It still counts as no progress. A model that keeps switching to
          // the window it is already on is not going to get anywhere, and the
          // run ends on the second one instead of burning every step.
          if (targetId === observation.grant.targetId) {
            record({ index, action: "switch", ok: true, target: label, verification: "observed" });
            repeatedRefusals += 1;
            lastRefusal = undefined;
            if (repeatedRefusals >= MAX_REPEATED_REFUSALS) {
              return {
                outcome: "failed",
                summary: summarize("failed", steps, undefined, "COMPUTER_TARGET_UNAVAILABLE"),
                steps,
                errorCode: "COMPUTER_TARGET_UNAVAILABLE",
              };
            }
            index += 1;
            continue;
          }
          deps.onActivity?.({ phase: "acting", stepIndex: index + 1, action: "switch", target: label });
          observation = await observeWithTargetRetry(deps, targetId);
          record({ index, action: "switch", ok: true, target: label, verification: "observed" });
          // The overlay frames the window being worked on, so it moves too.
          deps.onCursor?.({
            kind: "show",
            grantId: observation.grant.grantId,
            bounds: observation.grant.bounds,
          });
          repeatedRefusals = 0;
          lastRefusal = undefined;
        } catch (error) {
          const code = errorCode(error);
          record({ index, action: "switch", ok: false, errorCode: code, target: label, verification: "refused" });
          const terminal = TERMINAL_CODES[code];
          if (terminal && GRANT_LEVEL_OUTCOMES.has(terminal)) {
            return {
              outcome: terminal,
              summary: summarize(terminal, steps, undefined, code),
              steps,
              errorCode: code,
            };
          }
          // A window the host refuses is not the end of the task: the model is
          // told, and may do something else with its remaining steps.
          repeatedRefusals = code === lastRefusal ? repeatedRefusals + 1 : 1;
          lastRefusal = code;
          if (repeatedRefusals >= MAX_REPEATED_REFUSALS) {
            return {
              outcome: "failed",
              summary: summarize("failed", steps, undefined, code),
              steps,
              errorCode: code,
            };
          }
        }
        index += 1;
        continue;
      }

      invalidAnswers = 0;
      const validated = validateAnswerAction(answer.action, observation.inspection);
      if (!validated.ok) {
        record({
          index,
          action: answer.action.kind,
          ok: false,
          errorCode: "COMPUTER_ACTION_REJECTED",
          target: validated.reason,
          verification: "refused",
        });
        repeatedRefusals = validated.reason === lastRefusal ? repeatedRefusals + 1 : 1;
        lastRefusal = validated.reason;
        if (repeatedRefusals >= MAX_REPEATED_REFUSALS) {
          return {
            outcome: "failed",
            summary: summarize("failed", steps, undefined, "COMPUTER_ACTION_REJECTED"),
            steps,
            errorCode: "COMPUTER_ACTION_REJECTED",
          };
        }
        index += 1;
        observation = await observeWithTargetRetry(deps, observation.grant.targetId);
        continue;
      }

      const target = describeTarget(validated.action, validated.node?.label);
      const bounds = validated.node?.bounds;
      // A write the model already dispatched against this same element with
      // this same payload is not dispatched twice. The tree it reads back
      // never shows the value, so it would otherwise keep rewriting the same
      // field until the step limit. The step is still recorded, and the
      // history tells the model it already happened.
      const writeKey = repeatedWriteKey(validated.action, validated.node);
      if (writeKey && dispatchedWrites.has(writeKey)) {
        record({
          index,
          action: validated.action.kind,
          ok: true,
          ...(target ? { target } : {}),
          // The step is reported as skipped, not as dispatched. The element
          // list never shows a field's content, so the model cannot tell a
          // landed write from a lost one; if the history says "dispatched"
          // for a write that was not sent, the model looks for the one that
          // works and keeps going until the step limit.
          verification: "skipped-duplicate",
        });
        index += 1;
        // Re-read the window anyway. The model has to see the state the
        // skipped write left behind, otherwise it has nothing to decide on
        // and repeats the same request.
        observation = await observeWithTargetRetry(deps, observation.grant.targetId);
        continue;
      }

      deps.onActivity?.({
        phase: "acting",
        stepIndex: index + 1,
        action: validated.action.kind,
        ...(target ? { target } : {}),
      });
      if (bounds) {
        deps.onCursor?.({
          kind: "move",
          grantId: observation.grant.grantId,
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          ...(target ? { label: target } : {}),
        });
      } else if (validated.action.point) {
        deps.onCursor?.({
          kind: "move",
          grantId: observation.grant.grantId,
          x: observation.grant.bounds.x + validated.action.point.x,
          y: observation.grant.bounds.y + validated.action.point.y,
          ...(target ? { label: target } : {}),
        });
      }

      try {
        const actResult = await deps.act(validated.action, observation.inspection.revision);
        if (writeKey) dispatchedWrites.add(writeKey);
        // The host can confirm a content write by reading the field back,
        // because the tree the model reads never shows what a field holds.
        // The verdict is what crosses the boundary -- never the content.
        if (actResult.verified === true) writeConfirmed = { step: index };
        if (actResult.verified === false) writeConfirmed = undefined;
        if (validated.node) lastActedIdentity = validated.node.identity ?? validated.node.uid;
        const point = bounds
          ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
          : validated.action.point
            ? {
                x: observation.grant.bounds.x + validated.action.point.x,
                y: observation.grant.bounds.y + validated.action.point.y,
              }
            : undefined;
        if (point) {
          deps.onCursor?.(
            validated.action.kind === "set_value"
              ? {
                  kind: "type",
                  grantId: observation.grant.grantId,
                  x: point.x,
                  y: point.y,
                  chars: validated.action.text?.length ?? 0,
                }
              : {
                  kind: "press",
                  grantId: observation.grant.grantId,
                  x: point.x,
                  y: point.y,
                  action: validated.action.kind,
                },
          );
        }
        record({ index, action: validated.action.kind, ok: true, ...(target ? { target } : {}), verification: "dispatched" });
        repeatedRefusals = 0;
        lastRefusal = undefined;
      } catch (error) {
        const code = errorCode(error);
        record({
          index,
          action: validated.action.kind,
          ok: false,
          errorCode: code,
          ...(target ? { target } : {}),
          verification: "refused",
        });
        const terminal = TERMINAL_CODES[code];
        if (terminal) {
          return {
            outcome: terminal,
            summary: summarize(terminal, steps, undefined, code),
            steps,
            errorCode: code,
          };
        }
        repeatedRefusals = code === lastRefusal ? repeatedRefusals + 1 : 1;
        lastRefusal = code;
        if (repeatedRefusals >= MAX_REPEATED_REFUSALS) {
          return {
            outcome: "failed",
            summary: summarize("failed", steps, undefined, code),
            steps,
            errorCode: code,
          };
        }
      }

      index += 1;
      const beforeObservation = observation;
      deps.onActivity?.({ phase: "observing", stepIndex: index, verification: "dispatched" });
      try {
        observation = await deps.observe();
        const verification = observationSignature(beforeObservation) === observationSignature(observation)
          ? "observed-no-change"
          : "observed-change";
        updateStepVerification(index - 1, validated.action.kind, verification);
        deps.onActivity?.({ phase: "observing", stepIndex: index, verification });
      } catch (error) {
        updateStepVerification(index - 1, validated.action.kind, "unverified");
        throw error;
      }
      // Always capture the state after a dispatched action, including the
      // final action at the per-call limit. Otherwise a caller can receive a
      // step-limit result without the action's outcome ever being observed.
      if (index >= maxSteps) break;
    }

    return { outcome: "step-limit", summary: summarize("step-limit", steps), steps };
  } catch (error) {
    const code = errorCode(error);
    const outcome = TERMINAL_CODES[code] ?? "failed";
    return {
      outcome,
      summary: summarize(outcome, steps, undefined, code),
      steps,
      errorCode: code,
    };
  } finally {
    deps.onCursor?.({ kind: "hide", grantId: observation.grant.grantId });
  }
}
