/**
 * Model-recovery helpers for the managed OMP engine.
 *
 * OMP restores a conversation's saved model when it opens a session file. When
 * the upstream catalog renames or drops that model (for example
 * `workbuddy/hy4free` -> `workbuddy/hy4flash-free`), `open_session` throws
 * `Could not restore model <provider>/<modelId>` and every later command keeps
 * failing on the same session, so the model picker cannot even open. These
 * helpers turn that opaque string into a structured, actionable failure.
 */

import { normalizeOmpTranscriptSnapshot } from "../../../src/lib/omp-transcript-sync.mjs";

export type OmpModelRef = { provider: string; modelId: string };

export type OmpModelCandidate = { provider: string; id: string; name?: string };

/** Matches both restore failures and an explicit model that no longer exists. */
const MODEL_REFERENCE_PATTERN =
  /(?:Could not restore model|Model not found)\s*[:：]?\s*["'`]?([^\s"'`]+)/i;

export function isRestoreModelFailure(message: string): boolean {
  return MODEL_REFERENCE_PATTERN.test(message ?? "");
}

/**
 * Split a `provider/modelId` reference. OMP model IDs frequently contain
 * slashes (`openrouter/anthropic/claude-...`), so the first slash is only a
 * fallback: whenever the reference starts with a provider the live catalog
 * actually reports, that provider wins and the remainder stays the model ID.
 */
export function parseModelReference(
  raw: string,
  knownProviders: readonly string[] = [],
): OmpModelRef | null {
  const value = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!value) return null;
  const provider = [...knownProviders]
    .filter((candidate) => candidate && value.startsWith(`${candidate}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (provider) {
    const modelId = value.slice(provider.length + 1);
    return modelId ? { provider, modelId } : null;
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function extractRestoreModelFailure(
  message: string,
  knownProviders: readonly string[] = [],
): OmpModelRef | null {
  const match = MODEL_REFERENCE_PATTERN.exec(message ?? "");
  return match ? parseModelReference(match[1], knownProviders) : null;
}

/** Catalog models that can replace a missing model inside the same provider. */
export function selectModelCandidates(
  catalog: unknown,
  provider: string,
  limit = 8,
): OmpModelCandidate[] {
  const source = catalog && typeof catalog === "object" && !Array.isArray(catalog)
    ? (catalog as Record<string, unknown>).models
    : catalog;
  const models = Array.isArray(source) ? source : [];
  const seen = new Set<string>();
  const candidates: OmpModelCandidate[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object" || Array.isArray(model)) continue;
    const entry = model as Record<string, unknown>;
    if (typeof entry.provider !== "string" || entry.provider !== provider) continue;
    if (typeof entry.id !== "string" || !entry.id) continue;
    const key = `${entry.provider}::${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      provider: entry.provider,
      id: entry.id,
      ...(typeof entry.name === "string" && entry.name.trim() ? { name: entry.name } : {}),
    });
    if (candidates.length >= Math.max(1, limit)) break;
  }
  return candidates;
}

export function catalogProviders(catalog: unknown): string[] {
  const source = catalog && typeof catalog === "object" && !Array.isArray(catalog)
    ? (catalog as Record<string, unknown>).models
    : catalog;
  if (!Array.isArray(source)) return [];
  return [
    ...new Set(
      source.flatMap((model) =>
        model && typeof model === "object" && typeof (model as Record<string, unknown>).provider === "string"
          ? [(model as Record<string, unknown>).provider as string]
          : [],
      ),
    ),
  ];
}

/** Failure categories the renderer can act on rather than blindly retrying. */
export type OmpFailureClassification = {
  code: string;
  retriable: boolean;
  model?: OmpModelRef;
};

const ACCOUNT_RESTRICTED_PATTERN =
  /\b403\b|forbidden|permission|restricted|access denied|not allowed|unsupported region|region not supported/i;
const AUTH_FAILED_PATTERN =
  /\b401\b|unauthori[sz]ed|authentication|invalid[ _-]?api[ _-]?key|api[ _-]?key|credential|token (?:is )?invalid|oauth/i;
const RETRIABLE_PATTERN =
  /\b429\b|rate[ _-]?limit|too many requests|\bHTTP\s*5\d\d\b|\bstatus(?:\s*code)?\s*[:=]?\s*5\d\d\b|econn(reset|refused|aborted)|etimedout|timed? ?out|fetch failed|network error|socket hang up|enotfound|eai_again|temporarily unavailable/i;

/**
 * Classify an OMP error. HTTP status is authoritative when OMP reports it;
 * text matching is only a fallback for transport failures. Only transport
 * shapes are retriable: authentication, permission and missing-model failures
 * need a user action, and a bare "try again" sentence is not evidence.
 */
export function classifyOmpFailure(
  message: string,
  upstreamCode?: string,
  upstreamRetriable?: boolean,
  httpStatus?: number,
): OmpFailureClassification {
  const text = message ?? "";
  const model = extractRestoreModelFailure(text);
  if (model || /provider .*not found|unknown provider|provider unavailable/i.test(text)) {
    if (model) return { code: "MODEL_UNAVAILABLE", retriable: false, model };
    return { code: "PROVIDER_UNAVAILABLE", retriable: false };
  }
  if (httpStatus === 401 || httpStatus === 407) return { code: "AUTH_FAILED", retriable: false };
  if (httpStatus === 403) return { code: "ACCOUNT_RESTRICTED", retriable: false };
  if (httpStatus === 408 || httpStatus === 429 || (typeof httpStatus === "number" && httpStatus >= 500)) {
    return { code: upstreamCode || "OMP_RUNTIME_ERROR", retriable: true };
  }
  if (ACCOUNT_RESTRICTED_PATTERN.test(text)) return { code: "ACCOUNT_RESTRICTED", retriable: false };
  if (AUTH_FAILED_PATTERN.test(text)) return { code: "AUTH_FAILED", retriable: false };
  if (RETRIABLE_PATTERN.test(text)) return { code: upstreamCode || "OMP_RUNTIME_ERROR", retriable: true };
  return { code: upstreamCode || "OMP_RUNTIME_ERROR", retriable: upstreamRetriable === true };
}

/**
 * Switch to a session file without paying the write-back cost of an explicit
 * model. OMP records a supplied model as the session's saved model, so the
 * pair is only sent when the plain switch proves the saved model is gone.
 */
export async function switchSessionWithModelFallback<T>(
  send: (fields: Record<string, unknown>) => Promise<T>,
  sessionPath: string,
  model: OmpModelRef | null,
): Promise<T> {
  try {
    return await send({ sessionPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!model || !isRestoreModelFailure(message)) throw error;
    return send({ sessionPath, provider: model.provider, modelId: model.modelId });
  }
}

type OmpCommand = (type: string, fields?: Record<string, unknown>) => Promise<unknown>;

/**
 * Move an RPC child back onto a mapped session file, then optionally read and
 * validate that file's transcript. Extracted from `OmpRpcRuntime` so the
 * switch-fallback, identity check and `readMessages` behavior can be tested
 * without spawning the engine.
 */
export async function restoreMappedSessionFile(
  command: OmpCommand,
  sessionFile: string,
  model: OmpModelRef | null,
  options: { readMessages?: boolean } = {},
  verifySessionPath: (state: unknown) => Promise<boolean> = async () => true,
): Promise<unknown[]> {
  const switched = await switchSessionWithModelFallback(
    (fields) => command("switch_session", fields),
    sessionFile,
    model,
  );
  const switchData = switched && typeof switched === "object"
    ? (switched as { data?: unknown }).data as Record<string, unknown> | undefined
    : undefined;
  if (switchData?.cancelled === true) throw new Error("OMP cancelled restoring the parent session");
  const state = await command("get_state");
  const stateData = state && typeof state === "object" ? (state as { data?: unknown }).data : undefined;
  if (!(await verifySessionPath(stateData))) throw new Error("OMP restored a different parent session");
  if (options.readMessages === false) return [];
  // Read after the switch so the transcript reflects everything OMP flushed or
  // a pre-switch hook wrote, not a pre-fork copy that may already be stale.
  const messages = await command("get_messages");
  const messagesData = messages && typeof messages === "object" ? (messages as { data?: unknown }).data : messages;
  const normalized = normalizeOmpTranscriptSnapshot(messagesData);
  if (!normalized.ok) throw new Error(`OMP 父会话内容无法安全同步到 PI：${normalized.reason}`);
  return normalized.messages;
}

/**
 * Error object shaped for the IPC `wrap` helper: `errorCode` becomes the
 * renderer error code and `data` becomes its `details` payload.
 */
export class OmpSessionModelError extends Error {
  readonly errorCode: string;
  readonly data: Record<string, unknown>;

  constructor(code: string, message: string, data: Record<string, unknown>) {
    super(message);
    this.name = "OmpSessionModelError";
    this.errorCode = code;
    this.data = data;
  }
}

export function buildModelUnavailableError(
  ref: OmpModelRef,
  candidates: OmpModelCandidate[],
): OmpSessionModelError {
  return new OmpSessionModelError(
    "MODEL_UNAVAILABLE",
    `Could not restore model ${ref.provider}/${ref.modelId}`,
    { provider: ref.provider, modelId: ref.modelId, candidates, retriable: false },
  );
}

export function buildProviderUnavailableError(ref: OmpModelRef): OmpSessionModelError {
  return new OmpSessionModelError(
    "PROVIDER_UNAVAILABLE",
    `Provider ${ref.provider} is no longer available for model ${ref.modelId}`,
    { provider: ref.provider, modelId: ref.modelId, candidates: [], retriable: false },
  );
}
