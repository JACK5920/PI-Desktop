import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("generated image cards and thumbnails route right-clicks to the shared file menu", async () => {
  const images = await read("../src/features/chat/transcript/GeneratedImages.tsx");
  const thumbnail = await read("../src/features/chat/transcript/GeneratedImageThumbnail.tsx");
  const viewer = await read("../src/features/chat/transcript/GeneratedImageViewer.tsx");
  assert.match(images, /data-file-ref=\{path\}/);
  assert.match(images, /closest<HTMLElement>\("\[data-file-ref\]"\)/);
  assert.match(images, /openFileMenu\(event, \{ path \}\)/);
  assert.match(images, /<ContextMenu state=\{fileMenu\}/);
  assert.match(thumbnail, /data-file-ref=\{image\.path\}/);
  assert.match(viewer, /data-file-ref=\{selected\.path\}/);
});

test("fenced code keeps its content literal and opens a file menu only for a resolvable path token", async () => {
  const markdown = await read("../src/components/Markdown.tsx");
  const linkParser = await read("../src/lib/chat-links.ts");
  assert.match(markdown, /<pre onContextMenu=\{onContextMenu\}>/);
  assert.match(markdown, /fileReferenceAtTextOffset\(/);
  assert.match(markdown, /if \(path\) openFileMenu\(event, \{ path, baseDir \}\)/);
  assert.match(linkParser, /SKIP_MDAST[\s\S]{0,120}"code"/);
});

test("shared file menu exposes system-default opening through the Host-validated path resolver", async () => {
  const menu = await read("../src/hooks/use-chat-file-menu.tsx");
  const target = await read("../src/hooks/use-preview-target.ts");
  assert.match(menu, /openWithDefaultApplication/);
  assert.match(menu, /destination: "default-application"/);
  assert.match(target, /destination === "default-application"/);
  assert.match(target, /resolveRef\(path, baseDir\)/);
  assert.match(target, /api\.fsOpen\(resolved\.absolutePath, mimeType, sessionId\)/);
});
