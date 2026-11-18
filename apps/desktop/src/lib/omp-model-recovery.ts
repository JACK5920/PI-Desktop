/**
 * Renderer-side view of the structured OMP recovery error produced by Main.
 * Main embeds `{ provider, modelId, candidates }` in the error details; this
 * module validates that payload before the error card renders actions.
 */

export type OmpRecoveryCandidate = { provider: string; id: string; name?: string };

export type OmpModelRecoveryInfo = {
  code: "MODEL_UNAVAILABLE" | "PROVIDER_UNAVAILABLE";
  provider?: string;
  modelId?: string;
  candidates: OmpRecoveryCandidate[];
};

const RECOVERY_CODES = new Set(["MODEL_UNAVAILABLE", "PROVIDER_UNAVAILABLE"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readOmpModelRecovery(
  code: string | null | undefined,
  details: unknown,
): OmpModelRecoveryInfo | null {
  if (!code || !RECOVERY_CODES.has(code)) return null;
  const raw = details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const candidate = entry as Record<string, unknown>;
        const provider = text(candidate.provider);
        const id = text(candidate.id);
        if (!provider || !id) return [];
        return [{ provider, id, ...(text(candidate.name) ? { name: text(candidate.name) } : {}) }];
      })
    : [];
  return {
    code: code as OmpModelRecoveryInfo["code"],
    ...(text(raw.provider) ? { provider: text(raw.provider) } : {}),
    ...(text(raw.modelId) ? { modelId: text(raw.modelId) } : {}),
    candidates,
  };
}
