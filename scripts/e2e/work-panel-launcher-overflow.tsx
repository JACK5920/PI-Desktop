import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { composerDraftBridge } from "../../apps/desktop/src/features/chat/composer/plugins/draft-bridge";
import type { ComposerFileReference } from "../../apps/desktop/src/features/chat/composer/model";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

type Scenario = {
  count: number;
  width: number;
  height: number;
  explicitTab: boolean;
  theme: "light" | "dark";
  language: "en" | "zh-CN";
};

declare global {
  var launcherOverflowProbe: (scenario: Scenario) => Promise<{
    ok: true;
    rows: number;
    scrollHeight: number;
    clientHeight: number;
  }>;
  var branchReviewProbe: () => Promise<{
    ok: true;
    diffRequests: number;
    draft: string;
  }>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Mock only the native bridge; the real component, store actions, and CSS run.
window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async () => ({ ok: true, data: undefined }),
  on: () => () => undefined,
};
const host = document.createElement("div");
host.style.cssText = "position:absolute;inset:0 auto auto 0;display:flex";
document.body.append(host);
const root = createRoot(host);
const i18n = createInstance();
const ready = i18n.init({
  lng: "en",
  resources: {
    en: { translation: catalogs.en },
    "zh-CN": { translation: catalogs["zh-CN"] },
  },
  interpolation: { escapeValue: false },
});

function element(selector: string): HTMLElement {
  const node = host.querySelector<HTMLElement>(selector);
  check(node, `Missing ${selector}`);
  return node;
}

async function rendered() {
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function visibleRow(row: HTMLElement, list: HTMLElement) {
  const box = row.getBoundingClientRect();
  const viewport = list.getBoundingClientRect();
  check(box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1,
    "Tool row is not fully visible inside its scroll viewport");
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  check(hit && row.contains(hit), "Visible tool does not receive pointer hits");
}

globalThis.launcherOverflowProbe = async (scenario) => {
  await ready;
  await i18n.changeLanguage(scenario.language);
  document.documentElement.dataset.theme = scenario.theme;
  host.style.width = `${scenario.width}px`;
  host.style.height = `${scenario.height}px`;
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: "launcher-overflow",
      workPanelWidth: scenario.width,
      workPanelOpen: true,
      workPanelTabs: [],
      activeWorkPanelTabId: null,
      workPanelContexts: {},
      pluginViews: Array.from({ length: scenario.count }, (_, order) => ({
        pluginId: `fixture.tool-${order}`,
        viewId: "main",
        ref: `fixture.tool-${order}/main`,
        title: `${scenario.language === "en" ? "Tool" : "工具"} ${order} ${"Long localized tool name ".repeat(8)}`,
        pluginName: `Fixture ${order}`,
        order,
      })),
    });
    root.render(
      <I18nextProvider i18n={i18n}>
        <WorkPanel containerWidth={scenario.width + 450} sidebarCollapsed />
      </I18nextProvider>,
    );
  });
  if (scenario.explicitTab) {
    flushSync(() => element(".work-panel-new-tab").click());
  }
  await rendered();

  const list = element(".work-panel-launcher-list");
  const title = element(".work-panel-launcher-title");
  const rows = [...host.querySelectorAll<HTMLElement>(".work-panel-launcher-row")];
  const first = rows[0];
  const last = rows.at(-1);
  check(first && last, "Review row is missing");
  check(rows.length === scenario.count + 2, "Launcher lost or duplicated a host or plugin tool");
  const body = element(".work-panel-body").getBoundingClientRect();
  const launcher = element(".work-panel-launcher").getBoundingClientRect();
  check(launcher.top >= body.top - 1 && launcher.bottom <= body.bottom + 1,
    "Launcher grows outside the panel body");
  check(list.scrollWidth === list.clientWidth, "Long labels create horizontal scrolling");
  for (const row of rows) {
    check(row.getBoundingClientRect().height === 40, "Tool hit targets were compressed");
  }
  const overflows = rows.length * 40 + (rows.length - 1) * 2 > list.clientHeight;
  check((list.scrollHeight > list.clientHeight) === overflows,
    "The tool list does not own vertical overflow");
  const thumb = getComputedStyle(list, "::-webkit-scrollbar-thumb").backgroundColor;
  check(!["rgba(0, 0, 0, 0)", "transparent"].includes(thumb) && !/\s0\)$/.test(thumb),
    "The tool list hides its scroll affordance at rest");
  const titleTop = title.getBoundingClientRect().top;
  list.scrollTop = list.scrollHeight;
  await rendered();
  visibleRow(last, list);
  check(title.getBoundingClientRect().top === titleTop, "Scrolling moves the launcher title");

  // Browser focus must reveal off-screen rows without moving the panel shell.
  first.focus();
  await rendered();
  visibleRow(first, list);
  last.focus();
  await rendered();
  visibleRow(last, list);
  check(title.getBoundingClientRect().top === titleTop, "Keyboard focus moves the launcher title");
  check(host.scrollHeight <= host.clientHeight, "Tool navigation scrolls the outer shell");

  const result = { ok: true as const, rows: rows.length,
    scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
  if (scenario.count > 0) {
    const sourceTabId = useAppStore.getState().activeWorkPanelTabId;
    flushSync(() => last.click());
    await rendered();
    const state = useAppStore.getState();
    const destination = state.workPanelTabs.find((tab) => tab.id === state.activeWorkPanelTabId);
    check(destination?.resource === `fixture.tool-${scenario.count - 1}/main`,
      "The last tool does not open its own view");
    check(state.workPanelTabs.length === 1 && destination.id !== sourceTabId,
      "Opening a tool failed to replace the New launcher");
    flushSync(() => element(".work-panel-tab-close").click());
    await rendered();
    check(host.querySelectorAll(".work-panel-launcher-row").length === rows.length,
      "Closing the view did not restore all tools");
    check(useAppStore.getState().workPanelOpen, "Closing the final view collapsed the panel");
  }
  return result;
};

globalThis.branchReviewProbe = async () => {
  console.log("BRANCH_PROBE:start");
  await ready;
  await i18n.changeLanguage("en");
  const sessionId = "branch-review-session";
  const line = { type: "add", text: "return value;", newLine: 2 };
  const diff = {
    repo: true,
    clean: false,
    currentBranch: "feature",
    baseOptions: [{ ref: "refs/heads/main", name: "main", commit: "base-commit" }],
    branchReview: {
      baseRef: "refs/heads/main",
      baseCommit: "base-commit",
      mergeBaseCommit: "merge-commit",
      headCommit: "head-commit",
    },
    files: [{
      path: "src/example.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      anchorRevision: "anchor-1",
      hunks: [{ header: "@@ -1,1 +1,2 @@", lines: [
        { type: "context", text: "function run()", oldLine: 1, newLine: 1 },
        line,
      ] }],
    }],
  };
  const draft = {
    draftKey: `session:${sessionId}`,
    sessionId,
    text: "Keep this draft",
    references: [] as ComposerFileReference[],
  };
  let diffRequests = 0;
  const channels: string[] = [];
  window.piDesktop = {
    channels: IPC,
    platform: "darwin",
    invoke: async (channel) => {
      channels.push(channel);
      if (channel === IPC.invoke.workspaceDiff) {
        diffRequests += 1;
        return { ok: true, data: diff };
      }
      return { ok: true, data: undefined };
    },
    on: () => () => undefined,
  };
  const unregister = composerDraftBridge.register({
    read: () => draft,
    focused: () => false,
    selection: () => ({ start: 0, end: draft.text.length }),
    write(text, references) {
      draft.text = text;
      draft.references = references;
    },
    async stage() { throw new Error("not used"); },
  });
  try {
    host.style.width = "720px";
    host.style.height = "600px";
    flushSync(() => {
      useAppStore.setState({
        activeSessionId: sessionId,
        workspace: { path: "/repo", name: "repo" },
        workPanelWidth: 720,
        workPanelOpen: true,
        workPanelTabs: [],
        activeWorkPanelTabId: null,
        workPanelContexts: {},
        pluginViews: [],
      });
      root.render(
        <I18nextProvider i18n={i18n}>
          <WorkPanel containerWidth={1170} sidebarCollapsed />
        </I18nextProvider>,
      );
    });
    console.log("BRANCH_PROBE:mounted");
    await rendered();
    console.log("BRANCH_PROBE:rendered-launcher");
    element('[data-work-panel-launcher-item="branch-review"]').click();
    console.log("BRANCH_PROBE:clicked-launcher");
    for (let frame = 0; frame < 300 && !host.querySelector(".branch-review-file"); frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    check(host.querySelector(".branch-review-file"), "Branch Review did not render the selected base diff");
    console.log("BRANCH_PROBE:diff-loaded");
    check(element(".branch-review-current-branch").textContent?.includes("feature"), "The current branch was not shown");
    check((host.querySelector<HTMLSelectElement>("#branch-review-base")?.value) === "refs/heads/main",
      "The default locally available base was not selected");
    const feedback = host.querySelector<HTMLButtonElement>(".branch-review-line.add .branch-review-line-feedback");
    check(feedback, "The changed line has no feedback action");
    feedback.click();
    console.log("BRANCH_PROBE:clicked-feedback");
    const expected = JSON.stringify({
      path: "src/example.ts",
      type: "add",
      workingTreeLine: 2,
      text: line.text,
    });
    // The API and draft bridge are Promise-driven; yield one event-loop task
    // rather than depending on another animation frame in a hidden window.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    console.log("BRANCH_PROBE:draft", draft.text);
    check(draft.text.includes(expected), "The selected diff feedback did not reach the editable draft");
    check(draft.text.startsWith("Keep this draft\n\n"), "The existing draft was not preserved");
    check(diffRequests === 2, "The feedback action must re-read the diff before appending");
    check(!channels.includes(IPC.invoke.agentPrompt), "Branch Review must not submit a turn");
    console.log("BRANCH_PROBE:complete");
    return { ok: true, diffRequests, draft: draft.text };
  } finally {
    unregister();
  }
};
