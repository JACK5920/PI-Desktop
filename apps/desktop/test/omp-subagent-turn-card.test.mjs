import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [topology, card, panel, styles] = await Promise.all([
  read("../src/features/chat/transcript/SubagentDetail.tsx"),
  read("../src/features/chat/transcript/OmpSubagentTurnCard.tsx"),
  read("../src/components/workpanel/OmpSubagentBatchTab.tsx"),
  read("../src/styles/composer-menus.css"),
]);
const workPanelStyles = await read("../src/styles/work-panel.css");
const messageStyles = await read("../src/styles/messages.css");

test("OMP Task calls in one topology are collapsed into one group at their first position", () => {
  assert.match(topology, /buildOmpSubagentTurnGroup\(items, \[\.\.\.ompRoster\]\)/);
  assert.match(topology, /const topologyEntries = useMemo\(\(\) => \{/);
  assert.match(topology, /if \(!groupInserted\)\s*\{\s*entries\.push\(\{ kind: "omp-group" \}\)/);
  assert.match(topology, /entry\.kind === "omp-group"[\s\S]*?<OmpSubagentTurnCard/);
  assert.match(card, /data-testid="omp-subagent-turn-card"/);
  assert.match(card, /group\.agents\.map/);
});

test("each child retains its exact parent Task call when opening the detail panel", () => {
  assert.match(card, /openOmpSubagentBatchTab\(toolCallId, String\(agent\.id\), label\)/);
  assert.match(card, /const tabId = `omp-subagent-batch:\$\{toolCallId\}:\$\{agent\.id\}`/);
});

test("OMP detail transcript owns the nested scroll input and fixed-shell height chain", () => {
  assert.match(panel, /className="subagent-transcript-scroll omp-native-agent-transcript" data-scroll-owner="follow"/);
  assert.match(panel, /ref=\{scrollRef\}[\s\S]*?onScroll=\{handleScroll\}/);
  assert.match(styles, /\.omp-native-agent-panel-workspace \{[^}]*min-height: 0;[^}]*flex: 1 1 0;[^}]*height: 0;[^}]*overflow: hidden;/);
  assert.match(styles, /\.omp-native-agent-transcript-view \{[^}]*display: flex;[^}]*min-height: 0;[^}]*height: 0;[^}]*flex: 1 1 0;[^}]*overflow: hidden;/);
  assert.match(styles, /\.omp-native-agent-panel-workspace \.omp-native-agent-transcript \{[^}]*min-height: 0;[^}]*height: 0;[^}]*flex: 1 1 0;[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;/);
  assert.match(styles, /\.omp-native-agent-live-status > span:nth-child\(2\) \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(messageStyles, /\.subagent-topology-node-status \{[\s\S]*?flex: 0 0 14ch;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/);
  assert.match(workPanelStyles, /\.subagent-transcript-composer \{\s*flex: none;/);
});
