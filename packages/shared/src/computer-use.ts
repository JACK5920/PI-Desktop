/**
 * Public, host-authoritative contracts for computer use (ADR 0349).
 *
 * Nothing here carries authority by itself. The grant is minted by host-core —
 * since ADR 0350 automatically, over the whole desktop — and every field a
 * caller could forge (the bound window, the revision, the budget) is re-read
 * from the host before an action runs. These types exist so main, the
 * renderer, and the loop agree on the shape of what the host already decided.
 */

/** Settings-level capture choice. `a11y-only` never takes a pixel. */
export type ComputerCaptureMode = "a11y-only" | "a11y-and-pixels";

/**
 * Per-grant input policy. `autonomous-in-scope` is the default (ADR 0350):
 * every step runs inside the budget, the idle expiry, and Stop.
 *
 * `confirm-each` is specified to raise an approval card per input step and is
 * **not implemented** — stage 1 never built the card, so selecting it narrows
 * nothing today. It stays in the contract because the card is still the plan.
 */
export type ComputerInputPolicy = "confirm-each" | "autonomous-in-scope";

/**
 * What a grant reaches. `desktop` is the automatic grant: any window the host
 * does not refuse, one at a time, rebindable without the user choosing again.
 * `window` pins the single window a caller named and refuses to move.
 */
export type ComputerGrantScope = "desktop" | "window";

/** One `{ providerId, modelId }` the user picked, as in `imageGeneration`. */
export type ComputerModelBinding = { providerId: string; modelId: string };

/** Which model drives the native Computer loop. Missing keeps legacy dedicated-model behavior. */
export type ComputerUseModelSource = "dedicated" | "conversation";

/** User-overridable application-level policy guards. Missing values keep the existing defaults. */
export type ComputerUseRestrictions = {
  /** One switch that disables the guards below without erasing their individual values. */
  disableAll?: boolean;
  blockSelfTarget?: boolean;
  blockSecureInput?: boolean;
  enforceDenylist?: boolean;
  blockElevatedTargets?: boolean;
};

export type ComputerUseSettings = {
  enabled: boolean;
  /** `conversation` follows the host session's selected chat model; absent means `dedicated`. */
  modelSource?: ComputerUseModelSource;
  /** Absent means unconfigured; the tool refuses rather than falling back. */
  model?: ComputerModelBinding | null;
  defaultInputPolicy?: ComputerInputPolicy;
  defaultCapture?: ComputerCaptureMode;
  /**
   * User-added application identifiers that may never be targeted. The
   * built-in credential-surface entries live in host-core and are not listed
   * here, because a settings write must not be able to remove them.
   */
  denylist?: string[];
  /** Hard ceiling on input actions per grant; the host clamps its own bound. */
  actionBudget?: number;
  /** Idle milliseconds before a grant closes itself. */
  idleExpiryMs?: number;
  restrictions?: ComputerUseRestrictions;
};

/** Resolve the model binding without ever falling back across the selected source. */
export function computerUseModelBindingForSource(
  settings: Pick<ComputerUseSettings, "model" | "modelSource"> | null | undefined,
  conversationModel?: { providerId?: string | null; modelId?: string | null } | null,
): ComputerModelBinding | null {
  if (!settings || (settings.modelSource ?? "dedicated") === "dedicated") {
    return settings?.model ?? null;
  }
  if (!conversationModel?.providerId || !conversationModel.modelId) return null;
  return { providerId: conversationModel.providerId, modelId: conversationModel.modelId };
}

export const COMPUTER_USE_DEFAULTS = {
  inputPolicy: "autonomous-in-scope",
  capture: "a11y-only",
  /** One instruction rarely needs more; a runaway loop should hit this. */
  actionBudget: 40,
  idleExpiryMs: 15 * 60_000,
  /** Clamp for a single `Computer` call, independent of the grant budget. */
  maxStepsPerCall: 12,
} as const satisfies {
  inputPolicy: ComputerInputPolicy;
  capture: ComputerCaptureMode;
  actionBudget: number;
  idleExpiryMs: number;
  maxStepsPerCall: number;
};

/**
 * Ceiling on one `Computer` call. The loop makes a model request per step, so
 * the default RPC timeout would cut a legitimate multi-step task short.
 */
export const COMPUTER_CALL_TIMEOUT_MS = 10 * 60_000;
export const COMPUTER_MAX_STEPS_LIMIT = 40;
/** Bound on the tree a single `inspect` returns, so one call cannot flood. */
export const COMPUTER_MAX_NODES = 400;
/**
 * Bound on the window list one observation shows the loop. A desktop grant can
 * see every window, and a machine with a hundred of them must not turn one
 * observation into a context flood.
 */
export const COMPUTER_MAX_WINDOWS = 40;
/** Bound on one element label, so a hostile window cannot pad the context. */
export const COMPUTER_MAX_LABEL_CHARS = 200;
/** Bound on text the loop may type in one step. */
export const COMPUTER_MAX_TEXT_CHARS = 2_000;

export function validateComputerUseSettings(value: unknown): ComputerUseSettings {
  const invalid = (): never => {
    throw Object.assign(new Error("computerUse settings are invalid"), {
      errorCode: "INVALID_PARAMS",
    });
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  const allowed = [
    "enabled",
    "modelSource",
    "model",
    "defaultInputPolicy",
    "defaultCapture",
    "denylist",
    "actionBudget",
    "idleExpiryMs",
    "restrictions",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid();
  if (typeof input.enabled !== "boolean") return invalid();

  const cleanId = (item: unknown, maxLength = 256): string => {
    if (typeof item !== "string" || !item.trim() || item.trim() !== item || item.length > maxLength) {
      return invalid();
    }
    return item;
  };

  const result: ComputerUseSettings = { enabled: input.enabled };

  if (input.modelSource !== undefined) {
    if (input.modelSource !== "dedicated" && input.modelSource !== "conversation") return invalid();
    result.modelSource = input.modelSource;
  }

  if (input.model !== undefined && input.model !== null) {
    if (!input.model || typeof input.model !== "object" || Array.isArray(input.model)) return invalid();
    const model = input.model as Record<string, unknown>;
    if (Object.keys(model).some((key) => !["providerId", "modelId"].includes(key))) return invalid();
    result.model = { providerId: cleanId(model.providerId), modelId: cleanId(model.modelId) };
  } else if (input.model === null) {
    result.model = null;
  }

  if (input.defaultInputPolicy !== undefined) {
    if (input.defaultInputPolicy !== "confirm-each" && input.defaultInputPolicy !== "autonomous-in-scope") {
      return invalid();
    }
    result.defaultInputPolicy = input.defaultInputPolicy;
  }
  if (input.defaultCapture !== undefined) {
    if (input.defaultCapture !== "a11y-only" && input.defaultCapture !== "a11y-and-pixels") return invalid();
    result.defaultCapture = input.defaultCapture;
  }
  if (input.denylist !== undefined) {
    if (!Array.isArray(input.denylist) || input.denylist.length > 200) return invalid();
    result.denylist = input.denylist.map((entry) => cleanId(entry));
  }
  if (input.actionBudget !== undefined) {
    if (
      typeof input.actionBudget !== "number"
      || !Number.isSafeInteger(input.actionBudget)
      || input.actionBudget < 1
    ) {
      return invalid();
    }
    result.actionBudget = input.actionBudget;
  }
  if (input.idleExpiryMs !== undefined) {
    if (
      typeof input.idleExpiryMs !== "number"
      || !Number.isSafeInteger(input.idleExpiryMs)
      || input.idleExpiryMs < 30_000
    ) {
      return invalid();
    }
    result.idleExpiryMs = input.idleExpiryMs;
  }
  if (input.restrictions !== undefined) {
    if (!input.restrictions || typeof input.restrictions !== "object" || Array.isArray(input.restrictions)) return invalid();
    const restrictions = input.restrictions as Record<string, unknown>;
    const restrictionKeys = [
      "disableAll",
      "blockSelfTarget",
      "blockSecureInput",
      "enforceDenylist",
      "blockElevatedTargets",
    ];
    if (Object.keys(restrictions).some((key) => !restrictionKeys.includes(key))) return invalid();
    if (Object.values(restrictions).some((flag) => typeof flag !== "boolean")) return invalid();
    result.restrictions = restrictions as ComputerUseRestrictions;
  }
  return result;
}

/** Why a listed target cannot be used. Listed, never silently dropped. */
export type ComputerTargetRefusal = "self" | "denylisted" | "elevated" | "no-accessibility";

export type ComputerTarget = {
  targetId: string;
  appName: string;
  title: string;
  /** Bundle id, process name, or WM class — whatever the platform can prove. */
  appKey: string;
  bounds: ComputerRect;
  refusedReason?: ComputerTargetRefusal;
};

export type ComputerRect = { x: number; y: number; width: number; height: number };

/**
 * How much of the real UI the platform backend can see. A backend that can
 * only enumerate top-level windows reports `partial` so an empty result is not
 * mistaken for an empty window.
 */
export type ComputerFidelity = "full" | "partial" | "none";

export type ComputerPermissionState = "granted" | "denied" | "not-requested" | "unsupported";

export type ComputerCapabilities = {
  platform: "darwin" | "win32" | "linux" | "other";
  backend: "macos-ax" | "windows-uia" | "linux-atspi" | "unsupported";
  fidelity: ComputerFidelity;
  /** Native inspection/synthesis permission (macOS Accessibility, AT-SPI bus). */
  accessibility: ComputerPermissionState;
  /** Desktop app's own TCC grant, for display only; never authorizes native input. */
  applicationAccessibility?: ComputerPermissionState;
  /** Window capture permission, as far as the host can tell before trying. */
  capture: ComputerPermissionState;
  /** `wayland` refuses input by contract; `x11` is best effort. */
  sessionType?: "x11" | "wayland" | "unknown";
  /** Present when the backend exists but cannot act — e.g. Wayland input. */
  inputUnsupportedReason?: string;
};

/** Only the macOS backend currently implements an explicit OS trust request. */
export function needsAccessibilityRequest(capabilities: ComputerCapabilities): boolean {
  const permission = capabilities.applicationAccessibility ?? capabilities.accessibility;
  return capabilities.platform === "darwin"
    && capabilities.backend === "macos-ax"
    && (permission === "not-requested" || permission === "denied");
}

export type ComputerGrantView = {
  grantId: string;
  /**
   * Bumped whenever the measured geometry or identity of the bound window
   * changes — including when a `desktop` grant rebinds to another window, so
   * every `uid` and `basis` from the previous window stops validating.
   */
  revision: number;
  /** Absent on a host that predates ADR 0350; treat that as `window`. */
  scope?: ComputerGrantScope;
  /** The window the grant is bound to right now, never the whole scope. */
  targetId: string;
  targetLabel: string;
  appKey: string;
  bounds: ComputerRect;
  inputPolicy: ComputerInputPolicy;
  capture: ComputerCaptureMode;
  /** Input actions left before the grant closes itself. */
  remainingBudget: number;
  /** Session that owns the grant; a second session is refused, not queued. */
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  state: "active" | "revoked" | "expired";
};

export type ComputerNode = {
  uid: string;
  /**
   * Identity that survives a new observation.
   *
   * `uid` is a dispatch handle: the cua backend mints `{snapshot}:{row}`, so it
   * changes every time the window is read. That is what lets the driver refuse
   * a stale handle — but it also means `uid` cannot answer "is this the same
   * element as before". Anything comparing two observations must use this.
   *
   * Absent only for a backend that cannot compute it; callers fall back to
   * `uid`, which is the pre-identity behaviour.
   */
  identity?: string;
  role: string;
  /** Accessible name, truncated. Absent when the platform exposes none. */
  label?: string;
  /** Whether a value exists — never the value itself (ADR 0349 §3). */
  hasValue: boolean;
  enabled: boolean;
  focused: boolean;
  bounds?: ComputerRect;
  /** Index of the parent in the same array; absent for the scope root. */
  parent?: number;
  /** Platform actions this element offers, already filtered to ours. */
  actions: ComputerActionKind[];
};

export type ComputerInspection = {
  grantId: string;
  revision: number;
  bounds: ComputerRect;
  fidelity: ComputerFidelity;
  nodes: ComputerNode[];
  /** True when the tree hit `COMPUTER_MAX_NODES` and was cut. */
  truncated: boolean;
  /** Set when the platform reports a secure input state right now. */
  secureInput: boolean;
};

export type ComputerActionKind =
  | "click"
  | "double_click"
  | "right_click"
  | "hover"
  | "drag"
  | "set_value"
  | "type_text"
  | "press_keys"
  | "scroll"
  | "select";

/**
 * The geometry a capture was taken against. A coordinate action carries it so
 * the host can refuse when its own re-measurement disagrees, instead of
 * clicking whatever now occupies those pixels.
 */
export type ComputerBasis = { revision: number; bounds: ComputerRect };

export type ComputerAction = {
  kind: ComputerActionKind;
  /** Element identity from the current inspection. Preferred over `point`. */
  uid?: string;
  /** Scope-relative coordinate; requires `basis` and is clamped to bounds. */
  point?: { x: number; y: number };
  /** Destination for a scoped drag; `point` is its start. */
  to?: { x: number; y: number };
  basis?: ComputerBasis;
  text?: string;
  /** Normalized chord list, e.g. `["cmd+a", "delete"]`. */
  keys?: string[];
  scroll?: { dx: number; dy: number };
  option?: string;
};
export type ComputerActResult = {
  grantId: string;
  revision: number;
  remainingBudget: number;
  /** What the backend actually dispatched, for the audit trail and the log. */
  dispatched: "accessibility-action" | "window-event" | "system-input";
  /**
   * Whether a content write was confirmed by reading the field back.
   *
   * A write's result is the content of a field, and the accessibility tree
   * never publishes a field's content, so the caller cannot confirm it from
   * the tree. The backend can: it reads the field back and compares it with
   * what was written, and only the verdict crosses this boundary.
   *
   * Absent when the backend could not tell -- which is not a failure.
   */
  verified?: boolean;
};


export type ComputerUseVerification =
  | "observation-only"
  | "observed"
  | "dispatched"
  | "observed-change"
  | "observed-no-change"
  /**
   * The action was not dispatched: the loop had already sent the same write
   * to the same element and did not send it twice. The model has to be able
   * to tell this apart from a dispatched action, because the element list
   * never shows a field's content -- without the distinction the model keeps
   * retrying the same write until the step limit.
   */
  | "skipped-duplicate"
  | "model-confirmed"
  /**
   * The action ran, the accessibility tree really did not change, and the
   * result is one UIA cannot express (a selection, a scroll position, focus).
   * Reported as self-reported rather than as verified: the alternative is an
   * agent that either retries forever or lies about having evidence.
   */
  | "unverified-by-design"
  | "unverified"
  | "refused";

/** One step the loop completed, as reported back to the user-facing summary. */
export type ComputerStepRecord = {
  index: number;
  /** `switch` is a desktop-grant rebind: a read, never an input action. */
  action: ComputerActionKind | "observe" | "switch" | "done" | "ask";
  /** Element label or coordinate description; never a typed value. */
  target?: string;
  ok: boolean;
  errorCode?: string;
  /**
   * Why the host refused, in the host's own words.
   *
   * The refusal code alone says that something was denied, never what: a
   * rejected chord and an unsupported target both answer
   * `COMPUTER_ACTION_REJECTED`, and a model that cannot tell them apart
   * retries variants of the same action until the step limit. The host's
   * message is diagnostic text by contract -- it names keys, control types
   * and counts, and carries no window text, typed value or pixels -- so it
   * is what lets the model choose a different action instead of a different
   * spelling of the same one.
   */
  reason?: string;
  verification?: ComputerUseVerification;
  /** Number of exact current-observation UIDs cited by a `done` answer. */
  evidenceCount?: number;
};

export type ComputerRunOutcome =
  | "done"
  | "step-limit"
  | "budget-exhausted"
  | "revoked"
  | "expired"
  | "needs-user"
  | "unverified"
  | "failed";

export type ComputerRunResult = {
  outcome: ComputerRunOutcome;
  /** Assembled from the steps that ran, not copied from model prose. */
  summary: string;
  steps: ComputerStepRecord[];
  /** Present when `outcome` is `needs-user`: what the model wants to ask. */
  question?: string;
  errorCode?: string;
  verification?: "model-confirmed" | "unverified-by-design" | "unverified" | "observation-only";
};

/** Sanitized, ephemeral UI status. It is not written to the transcript or audit log. */
export type ComputerRunPhase = "starting" | "observing" | "thinking" | "acting" | "verifying" | "asking" | "completed" | "unverified" | "failed";

/** Recent input steps omit entered text and model-generated prose by construction. */
export type ComputerActivityStep = {
  index: number;
  action: ComputerActionKind | "switch" | "done";
  target?: string;
  ok: boolean;
  errorCode?: string;
  verification?: ComputerUseVerification;
  evidenceCount?: number;
};

export type ComputerRunActivity = {
  grantId: string;
  phase: ComputerRunPhase;
  stepIndex?: number;
  action?: ComputerActionKind | "switch";
  target?: string;
  errorCode?: string;
  verification?: ComputerUseVerification;
  /** A requested screenshot may be unavailable even when accessibility works. */
  captureStatus?: "captured" | "unavailable";
  recentSteps: ComputerActivityStep[];
};

/** A loop progress update before the outer runner attaches the Host grant id. */
export type ComputerLoopActivity = Omit<ComputerRunActivity, "grantId" | "recentSteps">;

/**
 * Draw commands for the cursor overlay. The overlay is a click-through window
 * that visualizes where the agent is acting; it carries no authority, so these
 * payloads are screen coordinates and a label, never an element reference.
 */
export type ComputerCursorEvent =
  | { kind: "show"; grantId: string; bounds: ComputerRect; displayBounds?: ComputerRect }
  | { kind: "move"; grantId: string; x: number; y: number; label?: string }
  | { kind: "press"; grantId: string; x: number; y: number; action: ComputerActionKind }
  | { kind: "type"; grantId: string; x: number; y: number; chars: number }
  | { kind: "hide"; grantId: string };

/** Agent-facing `Computer` tool arguments. No target, no uid, no coordinate. */
export type ComputerToolArgs = {
  instruction: string;
  maxSteps?: number;
  /** Describe the scope without acting. Needs no input-policy approval. */
  observeOnly?: boolean;
};

export function validateComputerToolArgs(value: unknown): ComputerToolArgs {
  const invalid = (message: string): never => {
    throw Object.assign(new Error(message), { errorCode: "INVALID_PARAMS" });
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Computer expects an object with an instruction");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["instruction", "maxSteps", "observeOnly"].includes(key))) {
    return invalid("Computer received an unknown argument");
  }
  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
  if (!instruction || instruction.length > 4_000) {
    return invalid("Computer expects a non-empty instruction under 4000 characters");
  }
  const args: ComputerToolArgs = { instruction };
  if (input.maxSteps !== undefined) {
    if (
      typeof input.maxSteps !== "number"
      || !Number.isInteger(input.maxSteps)
      || input.maxSteps < 1
      || input.maxSteps > COMPUTER_MAX_STEPS_LIMIT
    ) {
      return invalid(`Computer maxSteps must be an integer between 1 and ${COMPUTER_MAX_STEPS_LIMIT}`);
    }
    args.maxSteps = input.maxSteps;
  }
  if (input.observeOnly !== undefined) {
    if (typeof input.observeOnly !== "boolean") return invalid("Computer observeOnly must be a boolean");
    args.observeOnly = input.observeOnly;
  }
  return args;
}

/**
 * Schema version of the `computer.*` RPC surface this build understands.
 *
 * The Electron bundle and the `host-core` sidecar are versioned separately,
 * so an update can leave them out of step. Every shape change to the RPC
 * payload - a renamed field, a changed enum, a new required argument - is a
 * breaking change, and the mismatch has to be visible before an action runs
 * rather than as a puzzling failure in the middle of a run.
 *
 * The host declares the range it supports; `host-core` reports the version
 * it speaks. A version outside the range is refused.
 */
export const COMPUTER_RPC_SCHEMA_MIN = 1;
export const COMPUTER_RPC_SCHEMA_MAX = 1;

/** What `host-core` reports about the contract it speaks. */
export type ComputerRpcSchema = {
  schemaVersion: number;
  hostCoreVersion?: string;
};

/**
 * Whether a host-reported schema version is one this build can talk to.
 *
 * A host that reports nothing at all is treated as incompatible rather than
 * as compatible: an older sidecar that predates the version field is exactly
 * the case this check exists to catch.
 */
export function isComputerRpcSchemaCompatible(version: unknown): boolean {
  if (typeof version !== "number" || !Number.isInteger(version)) return false;
  return version >= COMPUTER_RPC_SCHEMA_MIN && version <= COMPUTER_RPC_SCHEMA_MAX;
}

/**
 * A message a caller can show the user when the two sides do not match.
 *
 * It names both versions and what to do, because the failure is a build
 * mismatch and the fix is not something the user can reason out from a
 * stack trace.
 */
export function computerRpcSchemaMismatchMessage(
  reported: unknown,
  hostCoreVersion?: string,
): string {
  const shown = typeof reported === "number" ? String(reported) : "unknown";
  const side = hostCoreVersion ? ` (host-core ${hostCoreVersion})` : "";
  return (
    `The Computer Use RPC contract does not match this build: host-core speaks schema ${shown}${side}, ` +
    `this build supports ${COMPUTER_RPC_SCHEMA_MIN}-${COMPUTER_RPC_SCHEMA_MAX}. ` +
    `Update PI-Desktop so the app and its host-core sidecar are the same version.`
  );
}