import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";
import type { ArtifactSummary } from "./api";
import { selectCurrentArtifacts, selectTurnDeliverables } from "./turn-artifact-presentation";

const message = (content: string): UiMessage => ({
  id: "assistant-final",
  role: "assistant",
  content,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const artifact = (overrides: Partial<ArtifactSummary> & Pick<ArtifactSummary, "id" | "path">): ArtifactSummary => {
  const { id, path, ...fields } = overrides;
  return {
    sessionId: "session-1",
    sessionTitle: null,
    op: "create",
    turnId: "turn-1",
    toolCallId: null,
    source: "workspace_diff",
    confidence: "observed",
    existsAfter: true,
    existsNow: true,
    sizeBytes: 30,
    sha256: null,
    previousPath: null,
    turnStatus: "completed",
    updatedAt: "2026-11-13T10:00:00.000Z",
    id,
    path,
    ...fields,
  };
};

describe("selectTurnDeliverables", () => {
  it("does not read conversation bodies when no deliverables can be shown", () => {
    const unreadMessage = {
      id: "assistant-final",
      role: "assistant",
      createdAt: "2026-01-01T00:00:00.000Z",
      get content(): string { throw new Error("unexpected transcript body read"); },
    } as UiMessage;

    expect(selectTurnDeliverables([], [unreadMessage])).toEqual({ artifacts: [], total: 0 });
  });

  it("uses latest path state, excludes deleted/unverified/legacy rows, and ranks cited reports first", () => {
    const selected = selectTurnDeliverables([
      artifact({ id: "old", path: "src/answer.ts", updatedAt: "2026-11-13T09:00:00.000Z" }),
      artifact({ id: "deleted", path: "src/answer.ts", op: "delete", existsAfter: false, updatedAt: "2026-11-13T10:01:00.000Z" }),
      artifact({ id: "report", path: "output/measurement-report.md" }),
      artifact({ id: "temp", path: "output/temp.txt", op: "delete", existsAfter: false }),
      artifact({ id: "legacy", path: "old/manual.docx", source: "legacy_index", confidence: "unverified" }),
      artifact({ id: "source", path: "src/feature.ts" }),
    ], [message("交付报告：output/measurement-report.md")]);

    expect(selected.total).toBe(2);
    expect(selected.artifacts.map((item) => item.id)).toEqual(["report", "source"]);
  });

  it("does not treat a filename mentioned by the assistant as persistence evidence", () => {
    const selected = selectTurnDeliverables([
      artifact({ id: "missing", path: "reports/final.md", existsAfter: false, existsNow: false }),
      artifact({ id: "unverified", path: "reports/claimed.md", confidence: "unverified" }),
    ], [message("I created reports/final.md and reports/claimed.md")]);
    expect(selected.total).toBe(0);
    expect(selected.artifacts).toEqual([]);
  });
});

describe("selectCurrentArtifacts", () => {
  it("does not duplicate old file versions and excludes the path after its latest delete", () => {
    const current = selectCurrentArtifacts([
      artifact({ id: "old-version", path: "src/kept.ts", updatedAt: "2026-11-13T08:00:00.000Z" }),
      artifact({ id: "new-version", path: "src/kept.ts", op: "edit", updatedAt: "2026-11-13T09:00:00.000Z" }),
      artifact({ id: "before-delete", path: "src/removed.ts", updatedAt: "2026-11-13T08:00:00.000Z" }),
      artifact({ id: "after-delete", path: "src/removed.ts", op: "delete", existsAfter: false, existsNow: false, updatedAt: "2026-11-13T09:00:00.000Z" }),
    ]);
    expect(current.map((item) => item.id)).toEqual(["new-version"]);
  });
});
