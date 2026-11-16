import type { ArtifactSummary } from "./api";
import type { UiMessage } from "@pi-desktop/shared";

const REPORT_EXTENSIONS = /\.(?:md|mdx|docx?|pdf|xlsx?|csv|pptx?)$/i;
const REPORT_WORDS = /(?:report|summary|audit|review|测评|报告|总结|审计|评审)/i;

function latestPerPath(artifacts: ArtifactSummary[]): ArtifactSummary[] {
  const latestByPath = new Map<string, ArtifactSummary>();
  for (const artifact of artifacts) {
    const previous = latestByPath.get(artifact.path);
    if (!previous || Date.parse(artifact.updatedAt) > Date.parse(previous.updatedAt)) {
      latestByPath.set(artifact.path, artifact);
    }
  }
  return [...latestByPath.values()];
}

/** Latest still-present, evidence-backed file state for the default library view. */
export function selectCurrentArtifacts(artifacts: ArtifactSummary[]): ArtifactSummary[] {
  return latestPerPath(artifacts).filter((artifact) =>
    artifact.existsAfter && artifact.existsNow &&
    artifact.confidence !== "unverified" &&
    (artifact.source === "host_tool" || artifact.source === "workspace_diff") &&
    artifact.op !== "delete",
  );
}

/**
 * Turn history is an append-only event ledger. For the completion card we show
 * current deliverables only: latest event per path, still present, and backed
 * by a confirmed write or an observed workspace diff. Legacy index rows are
 * intentionally excluded because they cannot prove this turn wrote the file.
 */
export function selectTurnDeliverables(
  artifacts: ArtifactSummary[],
  messages: UiMessage[],
  maxItems = 6,
): { artifacts: ArtifactSummary[]; total: number } {
  const candidates = selectCurrentArtifacts(artifacts);
  const finalText = messages.filter((message) => message.role === "assistant")
    .map((message) => message.content).join("\n");
  const normalizedFinalText = finalText.replace(/[\\/]+/g, "/").toLocaleLowerCase();
  const isNamedInFinal = (artifact: ArtifactSummary) => {
    const path = artifact.path.replace(/[\\/]+/g, "/").toLocaleLowerCase();
    const name = path.split("/").at(-1) ?? path;
    return normalizedFinalText.includes(path) || (name.length >= 5 && normalizedFinalText.includes(name));
  };

  candidates.sort((a, b) => {
    const aNamed = isNamedInFinal(a);
    const bNamed = isNamedInFinal(b);
    if (aNamed !== bNamed) return aNamed ? -1 : 1;
    const aReport = REPORT_EXTENSIONS.test(a.path) || REPORT_WORDS.test(a.path);
    const bReport = REPORT_EXTENSIONS.test(b.path) || REPORT_WORDS.test(b.path);
    if (aReport !== bReport) return aReport ? -1 : 1;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });

  return { artifacts: candidates.slice(0, Math.max(0, maxItems)), total: candidates.length };
}
