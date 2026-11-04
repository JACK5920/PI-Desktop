import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  annotationsForAssistantMessage,
  buildAnnotatedPrompt,
  isResponseAnnotationCitationNode,
  remarkResponseAnnotationCitations,
  transcriptMessagesForSession,
} = await import("../src/lib/response-annotations.ts");

function collectCitationLinks(node, links = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectCitationLinks(child, links);
  } else if (node && typeof node === "object") {
    if (
      node.type === "link" &&
      typeof node.url === "string" &&
      node.url.startsWith("pi-annotation:") &&
      node.data?.hProperties?.dataPiAnnotationCitation === "true"
    ) {
      links.push(node.url);
    }
    collectCitationLinks(node.children, links);
  }
  return links;
}

function collectAnnotationSchemeLinks(node, links = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectAnnotationSchemeLinks(child, links);
  } else if (node && typeof node === "object") {
    if (node.type === "link" && typeof node.url === "string" && node.url.startsWith("pi-annotation:")) {
      links.push(node.url);
    }
    collectAnnotationSchemeLinks(node.children, links);
  }
  return links;
}

test("only exact prose citation directives are promoted to safe annotation links", () => {
  const processor = unified().use(remarkParse).use(remarkResponseAnnotationCitations);
  const source = 'Cite :codex-annotation{index="1"} but leave `:codex-annotation{index="2"}`, :codex-annotation{index="0"}, and [fake](pi-annotation:1) alone.';
  const tree = processor.runSync(processor.parse(source));
  assert.deepEqual(collectCitationLinks(tree), ["pi-annotation:1"]);
  assert.deepEqual(collectAnnotationSchemeLinks(tree), ["pi-annotation:1", "pi-annotation:1"]);
  assert.equal(isResponseAnnotationCitationNode({ properties: { href: "pi-annotation:1" } }), false);
  assert.equal(isResponseAnnotationCitationNode({
    properties: { href: "pi-annotation:1", dataPiAnnotationCitation: "true" },
  }), true);
});

test("raw HTML cannot forge response-annotation citation provenance", () => {
  const processor = unified().use(remarkParse).use(remarkResponseAnnotationCitations);
  const tree = processor.runSync(processor.parse(
    [
      '<a href="pi-annotation:1" data-pi-annotation-citation="true">simple</a>',
      '<a title=">" href="pi-annotation:1" data-pi-annotation-citation="true">quoted delimiter</a>',
      '<a data-pi-annotation-citation="false" data-pi-annotation-citation="true" href="pi-annotation:1">duplicate</a>',
      '<a dataPiAnnotationCitation="true" href="pi-annotation:1">camel case</a>',
      '<div>\n<a/href="pi-annotation:1" data-pi-annotation-citation="true">slash before attributes</a>\n</div>',
      '<div>\n<a / data-pi-annotation-citation="true" href="pi-annotation:1">slash with whitespace</a>\n</div>',
    ].join("\n"),
  ));
  const rawHtmlValues = [];
  const collectRawHtml = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) collectRawHtml(child);
    } else if (node && typeof node === "object") {
      if (node.type === "html" && typeof node.value === "string") rawHtmlValues.push(node.value);
      collectRawHtml(node.children);
    }
  };
  collectRawHtml(tree);
  assert.ok(rawHtmlValues.length > 0);
  const rawHtml = rawHtmlValues.join("");
  assert.doesNotMatch(rawHtml, /data-pi-annotation-citation/i);
});

test("the sanitized Markdown pipeline preserves only generated citation provenance", () => {
  const schema = {
    ...defaultSchema,
    protocols: {
      ...defaultSchema.protocols,
      href: [...(defaultSchema.protocols?.href ?? []), "pi-annotation"],
    },
    attributes: {
      ...defaultSchema.attributes,
      a: [...(defaultSchema.attributes?.a ?? []), "dataPiAnnotationCitation"],
    },
  };
  const processor = unified()
    .use(remarkParse)
    .use(remarkResponseAnnotationCitations)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, schema);
  const tree = processor.runSync(processor.parse([
    '<a title=">" href="pi-annotation:1" data-pi-annotation-citation="false" data-pi-annotation-citation="true">fake</a>',
    'Citation :codex-annotation{index="1"}.',
  ].join("\n\n")));
  const safeCitations = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
    } else if (node && typeof node === "object") {
      if (node.type === "element" && node.properties?.dataPiAnnotationCitation === "true") {
        safeCitations.push(node);
      }
      visit(node.children);
    }
  };
  visit(tree);
  assert.equal(safeCitations.length, 1);
  assert.equal(safeCitations[0].properties.href, "pi-annotation:1");
  assert.deepEqual(safeCitations[0].children, [{ type: "text", value: ':codex-annotation{index="1"}' }]);
});

test("citations resolve against the nearest preceding user prompt for the same answer", () => {
  const first = [{ id: "a1", sourceMessageId: "source-1", excerpt: "First source" }];
  const second = [{ id: "a2", sourceMessageId: "source-2", excerpt: "Second source" }];
  const messages = [
    { id: "u1", role: "user", content: buildAnnotatedPrompt("Compare", first) },
    { id: "a1", role: "assistant", content: "First answer" },
    { id: "u2", role: "user", content: buildAnnotatedPrompt("Review", second) },
    { id: "a2", role: "assistant", content: "Second answer" },
  ];
  assert.deepEqual(annotationsForAssistantMessage(messages, "a1"), [
    { sourceMessageId: "source-1", excerpt: "First source" },
  ]);
  assert.deepEqual(annotationsForAssistantMessage(messages, "a2"), [
    { sourceMessageId: "source-2", excerpt: "Second source" },
  ]);
  assert.deepEqual(annotationsForAssistantMessage(messages, "missing"), []);
});

test("session transcript lookup reads the child snapshot owned by an open side chat", () => {
  const childAnnotation = {
    id: "child-annotation",
    sourceMessageId: "child-source",
    excerpt: "quoted child source",
    comment: "Keep the child association.",
  };
  const childMessages = [
    { id: "child-question", role: "user", content: buildAnnotatedPrompt("Question", [childAnnotation]) },
    { id: "child-answer", role: "assistant", content: 'Answer :codex-annotation{index="1"}.' },
  ];
  const state = {
    activeSessionId: "parent",
    messages: [{ id: "parent-message", role: "user", content: "Parent" }],
    retainedTranscripts: { child: [] },
    sideChats: {
      "side-chat-1": { childSessionId: "child", messages: childMessages },
    },
  };
  assert.deepEqual(transcriptMessagesForSession(state, "child"), childMessages);
  assert.deepEqual(
    annotationsForAssistantMessage(transcriptMessagesForSession(state, "child"), "child-answer"),
    [{ sourceMessageId: "child-source", excerpt: "quoted child source", comment: "Keep the child association." }],
  );
});

test("Markdown recognizes citation plugin without rendering arbitrary HTML", async () => {
  const source = await readFile(
    new URL("../src/components/Markdown.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /remarkResponseAnnotationCitations/);
  assert.match(source, /responseAnnotations/);
});
