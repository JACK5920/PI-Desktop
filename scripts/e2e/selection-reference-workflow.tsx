import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { AppState } from "../../apps/desktop/src/stores/app-state";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { ComposerAnnotationAttachments } from "../../apps/desktop/src/features/chat/composer/ComposerAnnotationAttachments";
import { composerDraftBridge } from "../../apps/desktop/src/features/chat/composer/plugins/draft-bridge";
import { SideChatTab } from "../../apps/desktop/src/components/workpanel/SideChatTab";
import { TranscriptSelectionToolbar } from "../../apps/desktop/src/features/chat/transcript/TranscriptSelectionToolbar";
import { MessageAnnotationSummary } from "../../apps/desktop/src/features/chat/transcript/MessageAnnotationSummary";
import { SourceAnnotationMarkers } from "../../apps/desktop/src/features/chat/transcript/SourceAnnotationMarkers";
import {
  buildAnnotatedPrompt,
  parseAnnotatedPrompt,
  pendingSourceAnnotationsForMessage,
  requestTextWithoutAnnotations,
} from "../../apps/desktop/src/lib/response-annotations";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import { listableSessions } from "../../apps/desktop/src/lib/session-origin";

declare global {
  var selectionReferenceProbe: () => Promise<unknown>;
}

const assert = (value: unknown, message: string): asserts value => {
  if (!value) throw new Error(message);
};
const EMPTY_ANNOTATIONS: AppState["responseAnnotations"][string] = [];

function selectText(node: Text, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  if (!selection) throw new Error("Chromium selection is unavailable");
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function selectRange(startNode: Text, start: number, endNode: Text, end: number): void {
  const range = document.createRange();
  range.setStart(startNode, start);
  range.setEnd(endNode, end);
  const selection = window.getSelection();
  if (!selection) throw new Error("Chromium selection is unavailable");
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function beginSelectionDrag(target: Element): void {
  target.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true,
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
  }));
}

function finishSelectionDrag(target: Element): void {
  target.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true,
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 0,
  }));
}

async function waitForToolbar(expectedExcerpt?: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  const expected = expectedExcerpt ?? window.getSelection()?.toString().trim();
  while (performance.now() < deadline) {
    const toolbar = document.querySelector<HTMLElement>('[data-testid="selection-reference-toolbar"]');
    if (toolbar && (!expected || toolbar.dataset.selectionExcerpt === expected)) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error(`Selection toolbar did not appear after the selection settled; expected=${expected}; selected=${window.getSelection()?.toString()}`);
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (!button) {
    const toolbars = [...document.querySelectorAll<HTMLElement>(".transcript-selection-toolbar")]
      .map((toolbar) => toolbar.textContent?.trim());
    throw new Error(`Missing button: ${name}; selection=${window.getSelection()?.toString()}; toolbars=${JSON.stringify(toolbars)}`);
  }
  return button;
}

function textareaNamed(name: string): HTMLTextAreaElement {
  const textarea = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].find(
    (candidate) => candidate.getAttribute("aria-label") === name || candidate.labels?.[0]?.textContent?.trim() === name,
  );
  if (!textarea) throw new Error(`Missing textarea: ${name}`);
  return textarea;
}

function textareaById(id: string): HTMLTextAreaElement {
  const textarea = document.getElementById(id);
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error(`Missing textarea: ${id}`);
  return textarea;
}

function textNodeWithin(root: Element, value: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Text && node.data.includes(value)) return node;
  }
  throw new Error(`Missing transcript text: ${value}`);
}

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("Textarea value setter is unavailable");
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

let i18n: ReturnType<typeof createInstance>;
let userNode: Text;
let assistantNode: Text;
let assistantAnchorNode: Text;
let otherAssistantNode: Text;
let streamingAssistantNode: Text;
let submittedPrompt = "";

function Fixture() {
  const annotations = useAppStore((state) => state.responseAnnotations.parent ?? EMPTY_ANNOTATIONS);
  const [transcriptRoot, setLocalTranscriptRoot] = useState<HTMLElement | null>(null);
  const [sourceHost, setSourceHost] = useState<HTMLElement | null>(null);
  const [sideChatId, setSideChatId] = useState<string | null>(null);
  const captureTranscriptRoot = useCallback((element: HTMLElement | null) => {
    if (element) setLocalTranscriptRoot(element);
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      <main className="selection-reference-fixture">
        <section aria-label="Transcript" className="transcript-fixture">
          <div ref={captureTranscriptRoot}>
            <div
              data-selection-message-id="user-prompt"
              data-selection-session-id="parent"
              data-selection-role="user"
              data-selection-eligible="true"
            ><span ref={(element) => { if (element?.firstChild instanceof Text) userNode = element.firstChild; }}>Please compare the current branch with the accepted result.</span></div>
            <div
              className="message-row assistant"
              data-selection-message-id="answer-parent"
              data-selection-session-id="parent"
              data-selection-role="assistant"
              data-selection-eligible="true"
            ><div className="message-bubble" ref={setSourceHost}><div className="prose-chat"><span ref={(element) => { if (element?.firstChild instanceof Text) assistantNode = element.firstChild; }}>The accepted branch keeps the </span><strong ref={(element) => { if (element?.firstChild instanceof Text) assistantAnchorNode = element.firstChild; }}>original session active</strong><span> while review stays beside it.</span></div><SourceAnnotationMarkers annotations={pendingSourceAnnotationsForMessage(annotations, "answer-parent")} contentHost={sourceHost} /></div></div>
            <div
              data-selection-message-id="answer-other"
              data-selection-session-id="parent"
              data-selection-role="assistant"
              data-selection-eligible="true"
            ><span ref={(element) => { if (element?.firstChild instanceof Text) otherAssistantNode = element.firstChild; }}>A different answer must never replace the captured excerpt.</span></div>
            <div
              className="assistant-turn-fragment streaming"
              data-selection-message-id="answer-streaming"
              data-selection-session-id="parent"
              data-selection-role="assistant"
              data-selection-eligible="true"
            ><span ref={(element) => { if (element?.firstChild instanceof Text) streamingAssistantNode = element.firstChild; }}>This visible answer is still streaming.</span></div>
          </div>
        </section>
        {transcriptRoot ? (
          <TranscriptSelectionToolbar
            transcriptRoot={transcriptRoot}
            sessionId="parent"
            onAskInSideChat={(selection) => {
              const id = useAppStore.getState().openSideChat(
                selection.sessionId,
                selection.messageId,
                selection.excerpt,
              );
              if (id) setSideChatId(id);
            }}
          />
        ) : null}
        <section className="annotation-composer-fixture" aria-label="Composer references">
          <ComposerAnnotationAttachments />
        </section>
        {submittedPrompt ? (
          <section className="sent-annotation-fixture" aria-label="Sent annotated message">
            <p>{requestTextWithoutAnnotations(submittedPrompt)}</p>
            <MessageAnnotationSummary annotations={parseAnnotatedPrompt(submittedPrompt)?.annotations ?? []} />
          </section>
        ) : null}
        <section className="annotation-answer-fixture" aria-label="Assistant answer">
          <Markdown
            source={'The source is :codex-annotation{index="1"}; [fake](pi-annotation:1).'}
            responseAnnotations={annotations}
            annotationSessionId="parent"
          />
        </section>
        {sideChatId ? <SideChatTab sideChatId={sideChatId} /> : null}
      </main>
    </I18nextProvider>
  );
}

globalThis.selectionReferenceProbe = async () => {
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });

  const parentMessages = [
    {
      id: "user-prompt",
      role: "user" as const,
      content: "Please compare the current branch with the accepted result.",
      createdAt: "2026-11-04T00:00:00.000Z",
    },
    {
      id: "answer-parent",
      role: "assistant" as const,
      content: "The accepted branch keeps the original session active while review stays beside it.",
      status: "complete" as const,
      createdAt: "2026-11-04T00:00:01.000Z",
    },
    {
      id: "answer-other",
      role: "assistant" as const,
      content: "A different answer must never replace the captured excerpt.",
      status: "complete" as const,
      createdAt: "2026-11-04T00:00:02.000Z",
    },
  ];
  const parentSession = { id: "parent", source: "local", title: "Parent conversation" };
  let liveDraft = {
    draftKey: "parent",
    sessionId: "parent",
    text: "Existing main draft",
    references: [] as never[],
  };
  const unregisterDraft = composerDraftBridge.register({
    read: () => liveDraft,
    focused: () => false,
    selection: () => ({ start: liveDraft.text.length, end: liveDraft.text.length }),
    write: (value, references) => { liveDraft = { ...liveDraft, text: value, references }; },
    stage: async () => { throw new Error("File staging is outside this text-only fixture"); },
  });
  const originalPromoteSideChat = api.promoteSideChat;
  api.promoteSideChat = async () => ({ ok: true });

  let forkCount = 0;
  const sends: Array<{ content: string; childSessionId: string }> = [];
  const selectedSessions: string[] = [];
  const pendingResolvers: Array<(accepted: boolean) => void> = [];
  const permissionResolutions: Array<{ sessionId: string; requestId: string; decision: string }> = [];
  const askResolutions: Array<{ sessionId: string; requestId: string; answers: Array<string[] | null> }> = [];
  useAppStore.setState({
    activeSessionId: "parent",
    sessions: [parentSession] as AppState["sessions"],
    messages: parentMessages as AppState["messages"],
    retainedTranscripts: { parent: parentMessages } as AppState["retainedTranscripts"],
    responseAnnotations: {},
    sideChats: {},
    showToast: () => undefined,
    forkAssistantMessageInSession: (async (parentSessionId, messageId, excerpt) => {
      assert(parentSessionId === "parent", "side chat fork used a different parent session");
      assert(messageId.startsWith("answer-"), "side chat fork did not use an assistant message anchor");
      forkCount += 1;
      const childSessionId = `side-chat-child-${forkCount}`;
      useAppStore.setState((state) => ({
        sessions: [...state.sessions, {
          id: childSessionId,
          source: "local",
          title: `Side chat ${forkCount}`,
          sideChat: {
            parentSessionId,
            sourceMessageId: messageId,
            excerpt: excerpt ?? quote,
            promoted: false,
          },
        } as AppState["sessions"][number]],
        retainedTranscripts: { ...state.retainedTranscripts, [childSessionId]: [] },
      }));
      return childSessionId;
    }) as AppState["forkAssistantMessageInSession"],
    sendPrompt: (async (content, _draft, childSessionId) => {
      if (!childSessionId) return false;
      sends.push({ content, childSessionId });
      const sideChatId = Object.values(useAppStore.getState().sideChats).find(
        (sideChat) => sideChat.childSessionId === childSessionId,
      )?.id;
      if (!sideChatId) throw new Error("side-chat child has no registered projection");
      useAppStore.setState((state) => {
        const sideChat = state.sideChats[sideChatId];
        if (!sideChat) return {};
        return {
          runningSessions: { ...state.runningSessions, [childSessionId]: true },
          pendingPermissions: {
            [childSessionId]: [{
              requestId: `permission-${forkCount}`,
              sessionId: childSessionId,
              toolCallId: `permission-tool-${forkCount}`,
              toolName: "write_file",
              argsPreview: { path: "/workspace/result.txt" },
              risk: "high",
              reason: "Fixture request for the side-chat child.",
            }],
          },
          pendingAsks: {
            [childSessionId]: [{
              requestId: `ask-${forkCount}`,
              sessionId: childSessionId,
              toolCallId: `ask-tool-${forkCount}`,
              questions: [{ question: "Continue this child-session task?", options: ["Proceed"] }],
            }],
          },
          sideChats: {
            ...state.sideChats,
            [sideChatId]: {
              ...sideChat,
              messages: [{
                id: `assistant-streaming-${forkCount}`,
                role: "assistant",
                content: "Streaming side answer",
                status: "streaming",
                createdAt: "2026-11-04T00:00:03.000Z",
              } as AppState["messages"][number]],
            },
          },
        };
      });
      return await new Promise<boolean>((resolve) => {
        pendingResolvers.push((accepted) => {
          useAppStore.setState((state) => {
            const sideChat = state.sideChats[sideChatId];
            if (!sideChat) return {};
            return {
              runningSessions: { ...state.runningSessions, [childSessionId]: false },
              sideChats: {
                ...state.sideChats,
                [sideChatId]: {
                  ...sideChat,
                  messages: [
                    {
                      id: `user-side-${forkCount}`,
                      role: "user",
                      content,
                      createdAt: "2026-11-04T00:00:03.000Z",
                    } as AppState["messages"][number],
                    {
                      id: `assistant-side-${forkCount}`,
                      role: "assistant",
                      content: "Side result for the selected excerpt.",
                      status: "complete",
                      createdAt: "2026-11-04T00:00:04.000Z",
                    } as AppState["messages"][number],
                  ],
                },
              },
            };
          });
          resolve(accepted);
        });
      });
    }) as AppState["sendPrompt"],
    selectSession: (async (id) => {
      selectedSessions.push(id);
      useAppStore.setState({ activeSessionId: id });
    }) as AppState["selectSession"],
    promoteSideChat: async () => ({ ok: true }),
    resolvePermission: (async (sessionId, requestId, decision) => {
      permissionResolutions.push({ sessionId, requestId, decision });
      useAppStore.setState((state) => ({
        pendingPermissions: {
          ...state.pendingPermissions,
          [sessionId]: (state.pendingPermissions[sessionId] ?? []).filter((item) => item.requestId !== requestId),
        },
      }));
    }) as AppState["resolvePermission"],
    resolveAsk: (async (sessionId, resolution) => {
      askResolutions.push({ sessionId, requestId: resolution.requestId, answers: resolution.answers });
      useAppStore.setState((state) => ({
        pendingAsks: {
          ...state.pendingAsks,
          [sessionId]: (state.pendingAsks[sessionId] ?? []).filter((item) => item.requestId !== resolution.requestId),
        },
      }));
    }) as AppState["resolveAsk"],
  });

  const host = document.createElement("div");
  host.style.cssText = "position:relative;width:900px;min-height:760px;padding:24px;box-sizing:border-box";
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<Fixture />));
  await settle();

  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { copied.push(value); } },
  });

  try {
    const userStart = "Please compare ".length;
    clearSelection();
    beginSelectionDrag(userNode.parentElement ?? userNode);
    selectText(userNode, userStart, userStart + "the current branch".length);
    await settle();
    assert(!host.querySelector('[data-testid="selection-reference-toolbar"]'), "selection toolbar covered the transcript during pointer drag");
    finishSelectionDrag(userNode.parentElement ?? userNode);
    await waitForToolbar("the current branch");
    await settle();
    assert(host.querySelector('[data-testid="selection-reference-toolbar"]'), "user text selection did not show the toolbar");
    selectText(userNode, 0, "Please compare".length);
    selectText(userNode, 0, "Please compare the".length);
    await waitForToolbar("Please compare the");
    assert(window.getSelection()?.toString() === "Please compare the", `test changed selection to ${window.getSelection()?.toString()}`);
    assert(
      host.querySelector('[data-testid="selection-reference-toolbar"]'),
      "selection toolbar did not follow the new stable transcript selection",
    );
    assert(
      host.querySelector<HTMLElement>('[data-testid="selection-reference-toolbar"]')?.dataset.selectionExcerpt === "Please compare the",
      "selection toolbar retained a stale excerpt after rapid keyboard selection changes",
    );
    assert(
      host.querySelector('[data-testid="selection-reference-toolbar"]')?.textContent?.includes("Add to chat"),
      "selection toolbar lost its actions after selection changed",
    );
    selectText(streamingAssistantNode, 5, "visible answer".length + 5);
    await waitForToolbar();
    assert(
      host.querySelector('[data-testid="selection-reference-toolbar"]'),
      "visible text in an active streaming assistant answer did not open selection actions",
    );
    selectText(userNode, userStart, userStart + "the current branch".length);
    await waitForToolbar();
    buttonNamed("Copy selection").click();
    await settle();
    assert(copied[0] === "the current branch", "selection Copy did not write the exact captured excerpt");

    clearSelection();
    selectText(userNode, userStart, userStart + "the current branch".length);
    await waitForToolbar();
    buttonNamed("Add to chat").click();
    await settle();
    assert(liveDraft.text.includes("> the current branch"), "selected user text was not appended as a quote");
    assert(liveDraft.text.includes("From your message"), "selected user quote lacks its source attribution");
    assert(liveDraft.text.startsWith("Existing main draft"), "selected text replaced the existing Composer draft");

    const quote = "The accepted branch keeps the original session active";
    selectRange(assistantNode, 0, assistantAnchorNode, assistantAnchorNode.length);
    await waitForToolbar();
    assert(buttonNamed("Ask in side chat"), "completed assistant selection lacks the side-chat action");
    buttonNamed("Add to chat").focus();
    buttonNamed("Add to chat").click();
    await settle();
    const commentInput = textareaNamed("Add a note to this excerpt (optional)");
    const annotationEditor = host.querySelector<HTMLElement>("[data-testid='selection-annotation-editor']");
    const editorRect = annotationEditor?.getBoundingClientRect();
    assert(editorRect, "annotation editor has no measurable layout");
    assert(editorRect.left >= 0 && editorRect.right <= window.innerWidth, "annotation editor extends beyond the viewport width");
    assert(editorRect.top >= 0 && editorRect.bottom <= window.innerHeight, "annotation editor extends beyond the viewport height");
    const annotationEditorActions = [...annotationEditor.querySelectorAll<HTMLButtonElement>(".transcript-selection-annotation-actions button")];
    assert(annotationEditorActions.length === 2, "annotation editor does not show both cancel and save actions");
    assert(
      annotationEditorActions.every((button) => button.getBoundingClientRect().width >= 52),
      "annotation editor text actions are squeezed into icon-sized controls",
    );
    setTextareaValue(commentInput, "Focus on why the parent stays selected.");
    const otherStart = 0;
    selectText(otherAssistantNode, otherStart, "A different answer".length);
    await settle();
    buttonNamed("Attach excerpt").click();
    await settle();
    let annotation = useAppStore.getState().responseAnnotations.parent?.[0];
    assert(annotation, "annotation disappeared before citation rendering");
    assert(annotation?.excerpt === quote, `comment editor used a later selection instead of its captured excerpt; expected=${quote}; actual=${annotation?.excerpt}`);
    const sourceRow = host.querySelector<HTMLElement>('[data-selection-message-id="answer-parent"]');
    const expectedAnchorStart = sourceRow?.textContent?.indexOf(quote);
    assert(annotation.anchorStart === expectedAnchorStart, "annotation did not retain the exact source offset across inline formatting");
    assert(annotation.anchorEnd === (expectedAnchorStart ?? 0) + quote.length, "annotation did not retain the exact source range end");
    assert(annotation.comment === "Focus on why the parent stays selected.", "saved annotation comment is missing");

    await settle();
    const sourceMarker = host.querySelector<HTMLButtonElement>('[data-testid="source-annotation-marker"]');
    assert(sourceMarker, "pending Composer annotation has no marker at its source message before sending");
    assert(sourceMarker.parentElement?.classList.contains("is-anchored"), "exact source offsets did not position the marker at the quoted passage");
    sourceMarker.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await settle();
    assert(host.querySelector(".source-annotation-popover")?.textContent?.includes(quote), "hovering the source marker did not preview the referenced text");
    sourceMarker.focus();
    await settle();
    assert(sourceMarker.getAttribute("aria-expanded") === "true", "keyboard focus did not open the source marker preview");
    sourceMarker.blur();
    const savedAnnotations = useAppStore.getState().responseAnnotations.parent ?? [];
    useAppStore.setState((state) => ({
      responseAnnotations: {
        ...state.responseAnnotations,
        parent: [{ ...annotation, comment: "<img src=x onerror=alert(1)>" }],
      },
    }));
    await settle();
    const hostileMarker = host.querySelector<HTMLButtonElement>('[data-testid="source-annotation-marker"]');
    hostileMarker?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await settle();
    const hostilePreview = host.querySelector<HTMLElement>(".source-annotation-popover");
    assert(hostilePreview?.textContent?.includes("<img src=x onerror=alert(1)>"), "source preview did not retain hostile-looking comment text literally");
    assert(!hostilePreview?.querySelector("img"), "source preview interpreted an annotation comment as HTML");
    useAppStore.setState((state) => ({
      responseAnnotations: {
        ...state.responseAnnotations,
        parent: [{ sourceMessageId: annotation.sourceMessageId, excerpt: annotation.excerpt, comment: annotation.comment, id: annotation.id }],
      },
    }));
    await settle();
    assert(
      host.querySelector('[data-testid="source-annotation-marker"]')?.parentElement?.classList.contains("is-message-level"),
      "a legacy reference without offsets did not use the message-level marker",
    );
    useAppStore.setState((state) => ({
      responseAnnotations: {
        ...state.responseAnnotations,
        parent: [{ ...annotation, anchorStart: (annotation.anchorStart ?? 0) + 1 }],
      },
    }));
    await settle();
    assert(
      host.querySelector('[data-testid="source-annotation-marker"]')?.parentElement?.classList.contains("is-message-level"),
      "a stale source anchor was guessed instead of falling back to the message-level rail",
    );
    useAppStore.setState((state) => ({ responseAnnotations: { ...state.responseAnnotations, parent: savedAnnotations } }));
    await settle();

    const referencesChip = buttonNamed("References (1)");
    referencesChip.focus();
    referencesChip.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await settle();
    assert(host.querySelector('[data-testid="composer-annotation-preview"]')?.textContent?.includes(quote), "keyboard focus did not preview the pending reference in the Composer");
    referencesChip.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await settle();
    const composerPreview = host.querySelector<HTMLElement>('[data-testid="composer-annotation-preview"]');
    assert(composerPreview, "hovering the Composer reference control did not open its preview");
    composerPreview.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await settle();
    assert(host.querySelector('[data-testid="composer-annotation-preview"]'), "moving the pointer into the Composer preview dismissed it");
    const composerHoverBridge = getComputedStyle(referencesChip.parentElement!, "::before");
    assert(composerHoverBridge.pointerEvents !== "none" && Number.parseFloat(composerHoverBridge.height) >= 8, "Composer hover preview has no hit-test bridge across the trigger gap");
    referencesChip.click();
    await settle();
    assert(!host.querySelector('[data-testid="composer-annotation-preview"]'), "opening the reference manager left the hover preview open underneath it");
    assert(host.querySelector(".composer-annotation-review"), "clicking the reference control did not open the reference manager");
    assert(host.textContent?.includes(quote), "annotation review does not show the captured excerpt");
    const referenceReview = host.querySelector<HTMLElement>(".composer-annotation-review");
    const reviewRect = referenceReview?.getBoundingClientRect();
    assert(reviewRect, "Composer reference review has no measurable layout");
    assert(reviewRect.left >= 0 && reviewRect.right <= window.innerWidth, "Composer reference review extends beyond the viewport width");
    const annotationReviewActions = [...referenceReview.querySelectorAll<HTMLButtonElement>(".composer-annotation-actions > button")];
    assert(annotationReviewActions.length === 2, "Composer reference review does not expose edit and remove controls");
    assert(
      annotationReviewActions.every((button) => {
        const rect = button.getBoundingClientRect();
        return button.textContent?.trim() === "" &&
          button.querySelector("svg") !== null &&
          Boolean(button.getAttribute("aria-label")) &&
          rect.width >= rect.height * 0.9 &&
          rect.width <= rect.height * 1.2;
      }),
      "Composer reference review actions should be compact icon controls with accessible labels",
    );
    buttonNamed("Edit note").click();
    await settle();
    const annotationEditActions = [
      ...referenceReview.querySelectorAll<HTMLButtonElement>(".composer-annotation-edit .composer-annotation-actions button"),
    ];
    assert(annotationEditActions.length === 2, "Composer annotation editor does not show cancel and save actions");
    assert(
      annotationEditActions.every((button) => button.getBoundingClientRect().width >= 52),
      "Composer annotation editor text actions are squeezed into icon-sized controls",
    );
    setTextareaValue(textareaById("composer-annotation-comment-" + annotation.id), "Keep the parent visible while the child runs.");
    buttonNamed("Attach excerpt").click();
    await settle();
    annotation = useAppStore.getState().responseAnnotations.parent?.[0];
    assert(annotation?.comment === "Keep the parent visible while the child runs.", "Composer annotation edit was not saved");

    submittedPrompt = buildAnnotatedPrompt("Please explain the selected result.", [annotation]);
    flushSync(() => root.render(<Fixture />));
    const sentSummary = host.querySelector<HTMLDetailsElement>('[data-testid="message-annotation-summary"]');
    assert(sentSummary, "sent user message omitted its stored reference summary");
    sentSummary.querySelector("summary")?.click();
    await settle();
    assert(sentSummary.textContent?.includes(quote), "expanded sent reference summary omitted the saved excerpt");
    assert(sentSummary.textContent?.includes("Keep the parent visible while the child runs."), "expanded sent reference summary omitted its comment");
    assert(!sentSummary.textContent?.includes("response-annotations"), "sent reference summary leaked the machine envelope");

    const annotatedPrompt = submittedPrompt;
    assert(requestTextWithoutAnnotations(annotatedPrompt) === "Please explain the selected result.", "generated annotation envelope changed the visible request");
    assert(annotatedPrompt.includes("selected excerpts are included in your model-visible context"), "annotation envelope does not explicitly tell the model the selected excerpt is present");
    assert(annotatedPrompt.includes("answer-parent"), "annotation envelope lost its source message id");
    await settle();
    const citation = host.querySelector<HTMLButtonElement>('[data-testid="response-annotation-citation"]');
    assert(
      citation,
      `assistant citation directive did not render as a safe reference button; annotations=${JSON.stringify(useAppStore.getState().responseAnnotations.parent)}; html=${host.querySelector(".annotation-answer-fixture")?.innerHTML}`,
    );
    const fakeCitationLink = host.querySelector<HTMLAnchorElement>(
      '.annotation-answer-fixture a[href="pi-annotation:1"]',
    );
    assert(fakeCitationLink, "ordinary Markdown link fixture was unexpectedly removed");
    assert(
      !fakeCitationLink.matches('[data-testid="response-annotation-citation"]'),
      "an ordinary pi-annotation Markdown link impersonated a citation",
    );
    citation.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await settle();
    const citationDialog = host.querySelector(".annotation-citation-popover");
    assert(citationDialog?.textContent?.includes(quote), "citation popover does not show its excerpt");
    assert(citationDialog?.textContent?.includes("Keep the parent visible while the child runs."), "citation popover does not show its comment");
    assert(citationDialog?.textContent?.includes("answer-parent"), "citation popover does not retain source-message context");
    assert(citation.getAttribute("aria-expanded") === "true", "citation hover did not expose its expanded state");
    const citationHoverBridge = getComputedStyle(citation.parentElement!, "::after");
    assert(citationHoverBridge.pointerEvents !== "none" && Number.parseFloat(citationHoverBridge.height) >= 8, "citation hover preview has no hit-test bridge across the trigger gap");
    citation.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    citationDialog.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await settle();
    assert(host.querySelector(".annotation-citation-popover"), "moving the pointer into the citation preview dismissed it");
    citation.focus();
    citation.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    citation.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    assert(!host.querySelector(".annotation-citation-popover"), "Escape did not dismiss the citation preview");
    assert(document.activeElement === citation, "Escape did not return focus to the citation control");

    clearSelection();
    selectRange(assistantNode, 0, assistantAnchorNode, assistantAnchorNode.length);
    await waitForToolbar(quote);
    buttonNamed("Ask in side chat").click();
    await settle();
    const firstSideChat = Object.values(useAppStore.getState().sideChats)[0];
    assert(firstSideChat, "Ask in side chat did not create the docked draft tab");
    assert(!firstSideChat.childSessionId && forkCount === 0 && sends.length === 0, "opening a side chat forked or sent without user Send");
    assert(useAppStore.getState().activeSessionId === "parent", "opening a side chat switched away from the parent");
    assert(firstSideChat.draftText.includes(quote), "side-chat draft omitted the selected excerpt");

    const sidePrompt = textareaNamed("Side-chat prompt");
    setTextareaValue(sidePrompt, `${firstSideChat.draftText}Explain the selected result.`);
    buttonNamed("Send").click();
    for (let index = 0; index < 120 && sends.length === 0; index += 1) await settle();
    assert(forkCount === 1 && sends.length === 1, "explicit side-chat Send did not create exactly one fork and prompt");
    assert(
      !listableSessions(useAppStore.getState().sessions).some((session) => session.sideChat?.parentSessionId === "parent"),
      "an unpromoted sent side chat appeared in the ordinary session list",
    );
    assert(useAppStore.getState().activeSessionId === "parent", "side-chat send navigated away from the parent");
    await settle();
    assert(host.textContent?.includes("Streaming side answer"), "side-chat transcript did not react to the streaming child update");
    assert(host.querySelector(".permission-card"), "side-chat child permission request was not shown in its transcript");
    assert(host.querySelector('.asktool-card[role="region"]'), "side-chat child AskTool request was not shown beside its transcript");
    const firstChildDuringRun = useAppStore.getState().sideChats[firstSideChat.id]?.childSessionId;
    assert(firstChildDuringRun, "first side-chat child session was not registered before approval");
    buttonNamed("Allow once").click();
    await settle();
    assert(permissionResolutions.at(-1)?.sessionId === firstChildDuringRun, "permission resolution did not target the side-chat child session");
    assert(
      document.activeElement === textareaNamed("Side-chat prompt"),
      "resolving a child permission did not restore focus to the compact side-chat composer",
    );
    assert(!host.querySelector(".permission-card"), "resolved side-chat permission remained visible");
    const proceedOption = [...host.querySelectorAll<HTMLButtonElement>(".asktool-option")].find((button) => button.textContent?.includes("Proceed"));
    assert(proceedOption, "side-chat child AskTool option is missing");
    proceedOption.click();
    await settle();
    buttonNamed("Submit answers").click();
    await settle();
    assert(askResolutions.at(-1)?.sessionId === firstChildDuringRun, "AskTool resolution did not target the side-chat child session");
    assert(askResolutions.at(-1)?.answers[0]?.[0] === "Proceed", "side-chat AskTool answer was not preserved");
    pendingResolvers.shift()?.(true);
    for (let index = 0; index < 120 && !host.textContent?.includes("Side result for the selected excerpt."); index += 1) await settle();
    assert(host.textContent?.includes("Side result for the selected excerpt."), "completed side-chat answer was not rendered");
    assert(useAppStore.getState().activeSessionId === "parent", "completed side-chat response changed the active parent");
    const firstChildId = useAppStore.getState().sideChats[firstSideChat.id]?.childSessionId;
    assert(firstChildId, "first side-chat child session was not retained before follow-up actions");
    const sideChatPane = host.querySelector<HTMLElement>(`.side-chat-tab[data-side-chat-id="${firstSideChat.id}"]`);
    assert(sideChatPane, "first side-chat tab is not mounted after its response");
    const userExcerptNode = textNodeWithin(
      sideChatPane.querySelector('[data-selection-message-id="user-side-1"]') ?? sideChatPane,
      "Explain the selected result.",
    );
    const userExcerptStart = userExcerptNode.data.indexOf("Explain the selected result.");
    assert(userExcerptStart >= 0, "the side-chat prompt text is not present in its transcript row");
    selectText(userExcerptNode, userExcerptStart, userExcerptStart + "Explain the selected result.".length);
    await settle();
    assert(buttonNamed("Add to chat"), "side-chat user excerpt has no append action");
    assert(![...host.querySelectorAll<HTMLButtonElement>(".transcript-selection-toolbar button")]
      .some((button) => button.textContent?.includes("Ask in side chat")),
    "a nested side-chat action was exposed from the docked side-chat transcript");
    buttonNamed("Add to chat").click();
    await settle();
    assert(
      useAppStore.getState().sideChats[firstSideChat.id]?.draftText.includes("> Explain the selected result."),
      "selected user text was not appended to the compact side-chat draft",
    );
    const answerExcerptNode = textNodeWithin(
      sideChatPane.querySelector('[data-selection-message-id="assistant-side-1"]') ?? sideChatPane,
      "Side result for the selected excerpt.",
    );
    selectText(answerExcerptNode, 0, "Side result for the selected excerpt.".length);
    await settle();
    buttonNamed("Add to chat").click();
    await settle();
    setTextareaValue(
      textareaNamed("Add a note to this excerpt (optional)"),
      "This reference belongs to the side-chat child.",
    );
    buttonNamed("Attach excerpt").click();
    await settle();
    assert(
      useAppStore.getState().responseAnnotations[firstChildId]?.[0]?.comment ===
        "This reference belongs to the side-chat child.",
      "side-chat assistant excerpt did not attach to the child session",
    );
    assert(
      sideChatPane.querySelector('.composer-annotation-attachments [aria-label="References (1)"]'),
      "side-chat child annotations are not available for review before sending",
    );

    buttonNamed("Add to main chat").click();
    await settle();
    assert(liveDraft.text.includes("Side result for the selected excerpt."), "side-chat answer was not appended to the parent draft");
    assert(liveDraft.text.includes("> Side result for the selected excerpt."), "side-chat answer was not quoted as its own sourced result");
    assert(liveDraft.text.includes("From message assistant-side-1"), "side-chat result attribution points to the parent excerpt instead of the child answer");
    assert(!liveDraft.text.includes("> The accepted branch keeps the original session active"), "main draft quoted the original prompt excerpt instead of the side-chat answer");

    buttonNamed("Open as a conversation").click();
    for (let index = 0; index < 120 && useAppStore.getState().activeSessionId === "parent"; index += 1) await settle();
    assert(firstChildId && selectedSessions.at(-1) === firstChildId, "Open as a conversation did not select the ordinary child session");
    assert(!useAppStore.getState().sideChats[firstSideChat.id], "promotion did not release the transient side-chat tab");
    assert(
      listableSessions(useAppStore.getState().sessions).some((session) => session.id === firstChildId),
      "promoted side chat did not become an ordinary list entry",
    );

    useAppStore.setState({ activeSessionId: "parent", messages: parentMessages as AppState["messages"] });
    flushSync(() => root.render(<Fixture />));
    clearSelection();
    selectRange(assistantNode, 0, assistantAnchorNode, assistantAnchorNode.length);
    await waitForToolbar(quote);
    buttonNamed("Ask in side chat").click();
    await settle();
    const secondSideChat = Object.values(useAppStore.getState().sideChats).find((item) => item.id !== firstSideChat.id);
    assert(secondSideChat, "could not open a second side-chat tab for close-path verification");
    const secondPrompt = textareaNamed("Side-chat prompt");
    setTextareaValue(secondPrompt, `${secondSideChat.draftText}Explain briefly.`);
    buttonNamed("Send").click();
    for (let index = 0; index < 120 && sends.length < 2; index += 1) await settle();
    assert(forkCount === 2 && sends.length === 2, "second side-chat send did not create its durable child");
    pendingResolvers.shift()?.(true);
    for (let index = 0; index < 120 && !host.textContent?.includes("Side result for the selected excerpt."); index += 1) await settle();
    const secondChildId = useAppStore.getState().sideChats[secondSideChat.id]?.childSessionId;
    const persistedSecondChat = useAppStore.getState().sideChats[secondSideChat.id];
    buttonNamed("Close Side chat").click();
    await settle();
    assert(!useAppStore.getState().sideChats[secondSideChat.id], "closing the side-chat tab retained its transient projection");
    assert(secondChildId && useAppStore.getState().sessions.some((session) => session.id === secondChildId), "closing the tab deleted the durable child session");
    const originalGetSession = api.getSession;
    api.getSession = async (sessionId) => {
      const detail = sessionId === secondChildId && persistedSecondChat?.childSessionId
        ? {
            id: secondChildId,
            title: "Side chat 2",
            mode: "default",
            sideChat: {
              parentSessionId: secondSideChat.parentSessionId,
              sourceMessageId: secondSideChat.sourceMessageId,
              excerpt: secondSideChat.excerpt,
              promoted: false,
            },
            messages: persistedSecondChat.messages,
          } as NonNullable<Awaited<ReturnType<typeof api.getSession>>["session"]>
        : null;
      return { session: detail };
    };
    try {
      await useAppStore.getState().reopenSideChat(secondChildId!);
      const reopened = Object.values(useAppStore.getState().sideChats).find(
        (item) => item.childSessionId === secondChildId,
      );
      assert(reopened, "parent could not reopen the persisted side chat");
      assert(reopened.excerpt.includes(quote), "reopened side chat lost its saved excerpt");
      assert(reopened.messages.some((message) => message.content?.includes("Side result")), "reopened side chat lost its transcript");
      assert(useAppStore.getState().activeSessionId === "parent", "reopening a side chat changed the parent session");
    } finally {
      api.getSession = originalGetSession;
    }

    return {
      ok: true,
      capturedExcerpt: quote,
      annotationSource: annotation.sourceMessageId,
      sideChatForks: forkCount,
      sideChatSends: sends.length,
      childPermissionResolutions: permissionResolutions.length,
      childAskResolutions: askResolutions.length,
      parentDraftPreserved: liveDraft.text.startsWith("Existing main draft"),
      parentSessionStayedSelectedDuringSideChat: true,
      promotedChildId: firstChildId,
      closedChildRetained: secondChildId,
    };
  } finally {
    api.promoteSideChat = originalPromoteSideChat;
    unregisterDraft();
    flushSync(() => root.unmount());
    host.remove();
  }
};

i18n = createInstance();
