import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Artifacts exposes recorded outputs with session-scoped preview and recovery actions", async () => {
  const component = await read("src/components/workpanel/ArtifactsTab.tsx");
  const api = await read("src/lib/api.ts");
  const ipc = await read("electron/main/ipc/artifacts-ipc.ts");
  const remoteSafety = await read("src/lib/remote-ipc-safety.ts");
  const protocol = await read("../../packages/shared/src/protocol.ts");
  assert.match(component, /api\.listArtifacts\(sessionId, 200, undefined, 0\)/);
  assert.match(component, /openFile\(artifact\.path\)/);
  assert.match(component, /api\.fsReveal\(artifact\.path, artifact\.sessionId\)/);
  assert.match(component, /navigator\.clipboard\.writeText\(path\)/);
  assert.match(component, /navigateTranscript\(\{ sessionId: artifact\.sessionId, messageId: artifact\.sourceMessageId/);
  assert.match(component, /onContextMenu=\{\(event\) => openFileMenu\(event, \{ path: artifact\.path \}\)\}/);
  assert.match(api, /IPC\.invoke\.artifactList/);
  assert.match(api, /listArtifacts: \(sessionId: string, limit = 200, turnId\?: string, offset = 0\)/);
  assert.match(api, /hasMore: boolean/);
  assert.match(component, /listArtifacts\(sessionId, 200, undefined, 0\)/);
  assert.match(component, /recordsCount/);
  assert.match(component, /filterCurrent/);
  assert.match(component, /result\.hasMore/);
  assert.match(protocol, /artifactList: "pi-desktop\/artifacts\/list"/);
  assert.match(ipc, /sessionId: input\.sessionId\.trim\(\), limit: Math\.min\(requested, 500\)/);
  assert.match(ipc, /host\.call\("artifacts\.list", params\)/);
  assert.match(remoteSafety, /IPC\.invoke\.artifactList/);
  assert.match(component, /artifactsSessionId === sessionId/);
  assert.match(component, /artifact\.source === "workspace_diff"/);
  assert.match(component, /artifact\.confidence === "unverified"/);
  assert.match(component, /disabled={!artifact\.existsNow}/);
});

test("turn artifact summary is shown inline and ledger records observed source evidence", async () => {
  const outcome = await read("src/components/TurnOutcomeCard.tsx");
  const events = await read("src/stores/slices/events-slice.ts");
  const artifacts = await read("../../crates/host-core/src/artifacts.rs");
  const schema = await read("../../crates/host-core/src/db/migrations.rs");
  const panel = await read("src/components/workpanel/WorkPanel.tsx");
  assert.match(outcome, /turn-artifacts-card/);
  assert.match(events, /api\.listArtifacts\(envelope\.sessionId, 500, terminalTurnId\)/);
  assert.match(artifacts, /"workspace_diff",\s*"observed"/);
  assert.match(artifacts, /previous_path/);
  assert.match(schema, /migrate_v32_to_v33/);
  assert.match(panel, /<ArtifactsTab \/>/);
});

test("turn card selects only latest persisted deliverables and prioritizes final-answer reports", async () => {
  const helper = await read("src/lib/turn-artifact-presentation.ts");
  const card = await read("src/components/TurnOutcomeCard.tsx");
  assert.match(helper, /latestByPath/);
  assert.match(helper, /artifact\.existsAfter/);
  assert.match(helper, /artifact\.existsNow/);
  assert.match(helper, /artifact\.confidence !== "unverified"/);
  assert.match(helper, /artifact\.source === "host_tool" \|\| artifact\.source === "workspace_diff"/);
  assert.match(helper, /normalizedFinalText\.includes\(path\)/);
  assert.match(helper, /REPORT_EXTENSIONS/);
  assert.match(card, /selectTurnDeliverables/);
  assert.match(card, /toolWorkPanelTab\("artifacts"\)/);
  assert.match(card, /openFileMenu\(event, \{ path: artifact\.path \}\)/);
  const menu = await read("src/hooks/use-chat-file-menu.tsx");
  const opener = await read("src/hooks/use-preview-target.ts");
  assert.match(menu, /openWithDefaultApplication/);
  assert.match(opener, /destination === "default-application"/);
  assert.match(opener, /api\.fsOpen\(resolved\.absolutePath, mimeType, sessionId\)/);
});

test("system-default Open With resolves the target through Host path guards", async () => {
  const ipc = await read("electron/main/ipc/workspace-ipc.ts");
  const opener = ipc.slice(ipc.indexOf("handle(IPC.invoke.fsOpen"), ipc.indexOf("handle(IPC.invoke.fsIndex"));
  assert.match(opener, /remoteFileWorkspace\(input\.sessionId\)[\s\S]{0,220}remote paths cannot be opened/);
  assert.match(opener, /resolveRealOpenablePath\([\s\S]{0,220}allowAnyAbsolute: true/);
  assert.match(opener, /stat\(target\)\)\.isFile\(\)/);
  assert.match(opener, /shell\.openPath\(stripWinLongPrefix\(openPath\)\)/);
});

test("line-level feedback is shown only in Review and remains a Composer draft", async () => {
  const card = await read("src/components/ReviewChangeCard.tsx");
  const review = await read("src/components/workpanel/ReviewTab.tsx");
  assert.match(review, /allowLineFeedback/);
  assert.match(card, /allowLineFeedback && sessionId && localToolsAllowed/);
  assert.match(card, /composerDraftBridge\.appendTextForSession\(sessionId, messageText\)/);
  assert.doesNotMatch(card, /\.sendMessage\(|\.submit\(/);
});
