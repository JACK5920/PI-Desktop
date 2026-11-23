import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { getOmpSubagentConclusion } from "../src/components/omp-subagent-transcript.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("OMP result view prefers the delivered conclusion and falls back to the latest child answer", () => {
  const turns = [
    { task: "Inspect", rows: [{ kind: "answer", message: { content: "First finding" } }] },
    { task: "Follow up", rows: [
      { kind: "tool", message: { toolName: "read" } },
      { kind: "answer", message: { content: "Final finding\n\n- Verified" } },
    ] },
  ];

  assert.deepEqual(getOmpSubagentConclusion(turns, "## Delivered\r\n\r\nPASS"), {
    content: "## Delivered\n\nPASS",
    source: "delivery",
  });
  assert.deepEqual(getOmpSubagentConclusion(turns, "  "), {
    content: "Final finding\n\n- Verified",
    source: "transcript",
  });
  assert.equal(getOmpSubagentConclusion([{ task: "Still running", rows: [{ kind: "tool", message: {} }] }], ""), null);
});

test("long OMP conclusions occupy a dedicated full-height reader instead of a nested preview box", async () => {
  const panel = await read("../src/components/workpanel/OmpSubagentBatchTab.tsx");
  const reader = await read("../src/components/workpanel/OmpSubagentConclusionReader.tsx");
  const styles = await read("../src/styles/composer-menus.css");
  const zh = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");
  const en = await read("../../../packages/i18n/src/locales/en/index.ts");

  assert.match(panel, /role="tablist"[\s\S]*?subagentViewConclusion[\s\S]*?subagentViewExecution/);
  assert.match(panel, /role="tabpanel"[\s\S]*?omp-native-agent-conclusion-scroll/);
  assert.match(panel, /<SubagentTranscriptContent turns=\{transcriptTurns\}/);
  assert.match(panel, /<OmpSubagentConclusionReader/);
  assert.match(panel, /IconCopy/);
  assert.match(reader, /role="dialog" aria-modal="true"/);
  assert.match(reader, /event\.key === "Escape"/);
  assert.match(styles, /\.omp-native-agent-conclusion-scroll \{[^}]*flex: 1 1 0;[^}]*overflow-y: auto;/);
  assert.match(styles, /\.omp-subagent-conclusion-reader \{[^}]*width: min\(1440px, 94vw\);[^}]*height: min\(90vh, 1040px\);/);
  const detailPanelRule = styles.match(/\.omp-native-agent-detail-panel\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(detailPanelRule, /display: flex;[^}]*flex-direction: column;/);
  assert.match(styles, /\.omp-native-agent-panel-workspace \.omp-native-agent-transcript \{[^}]*height: 0;[^}]*flex: 1 1 0;[^}]*overflow-y: auto;/);
  assert.doesNotMatch(styles, /\.omp-native-agent-delivery-output\s*\{[^}]*max-height:\s*180px/);
  for (const locale of [zh, en]) {
    assert.match(locale, /subagentViewConclusion:/);
    assert.match(locale, /subagentViewExecution:/);
    assert.match(locale, /subagentConclusionExpand:/);
  }
});

test("OMP delivery view has an independent jump-to-bottom control when the report overflows", async () => {
  const panel = await read("../src/components/workpanel/OmpSubagentBatchTab.tsx");
  const styles = await read("../src/styles/work-panel.css");

  assert.match(panel, /const conclusionScrollRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(panel, /const \[showConclusionJump, setShowConclusionJump\] = useState\(false\)/);
  assert.match(panel, /onScroll=\{updateConclusionJump\}/);
  assert.match(panel, /detailView === "conclusion" && showConclusionJump \? <TooltipButton/);
  assert.match(panel, /onClick=\{jumpConclusionToBottom\}/);
  assert.match(panel, /conclusionScrollRef\.current[\s\S]*?scrollHeight[\s\S]*?clientHeight[\s\S]*?scrollTop/);
  assert.match(panel, /new ResizeObserver\(updateConclusionJump\)/);
  assert.match(styles, /\.subagent-result-jump \{[^}]*bottom: calc\(var\(--st-composer-dock-height, 68px\) \+ 8px\);/);
});
