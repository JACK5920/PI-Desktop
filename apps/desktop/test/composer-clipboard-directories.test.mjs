import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);
function load(path) {
  const result = buildSync({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs" });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const { execFileAsync, nativeClipboardPaths, readComposerClipboardDirectories } = load("../electron/main/composer-clipboard-directories.ts");
const { serializeComposerFileReferences, serializeInlineComposerFileReferences } = load("../../../packages/shared/src/composer-trigger.ts");
const clipboard = values => ({ availableFormats: () => Object.keys(values), readBuffer: format => Buffer.from(values[format] ?? "") });

test("native URI file lists preserve order and decode spaces/unicode without reading clipboard text", async () => {
  assert.deepEqual(await nativeClipboardPaths(clipboard({
    "text/uri-list": "# comment\r\nfile:///tmp/one%20folder\r\nfile:///tmp/%E4%B8%AD%E6%96%87\r\nhttps://example.com/ignored",
    "text/plain": "unrelated clipboard text",
  }), "linux"), ["/tmp/one folder", "/tmp/中文"]);
  assert.deepEqual(await nativeClipboardPaths(clipboard({ "x-special/gnome-copied-files": "copy\nfile:///tmp/a\nfile:///tmp/a" }), "linux"), ["/tmp/a"]);
});

test("native file lists enforce metadata and selection bounds", async () => {
  await assert.rejects(nativeClipboardPaths(clipboard({ "text/uri-list": "x".repeat(1024 * 1024 + 1) }), "linux"), /too large/);
  await assert.rejects(nativeClipboardPaths(clipboard({ "text/uri-list": Array.from({ length: 21 }, (_, i) => `file:///tmp/${i}`).join("\n") }), "linux"), /too many/);
  await assert.rejects(nativeClipboardPaths(clipboard({ "text/uri-list": "file:///tmp/a%00b" }), "linux"), /null|invalid|encoded/i);
});

test("Windows uses the complete native FileDropList instead of custom CF_HDROP or one FileNameW", async () => {
  const paths = ["C:\\first folder", "C:\\notes.txt", "D:\\中文"];
  assert.deepEqual(await nativeClipboardPaths({ readBuffer: () => assert.fail("Windows must use its native file list") }, "win32", async () => paths), paths);
  await assert.rejects(nativeClipboardPaths(clipboard({}), "win32", async () => ["relative"]), /invalid clipboard file path/);
});

test("normalized MIME enumeration does not hide raw Finder file URLs", async () => {
  const native = clipboard({ "public.file-url": "file:///tmp/synthetic-folder" });
  native.availableFormats = () => ["text/uri-list"];
  assert.deepEqual(await nativeClipboardPaths(native, "darwin"), ["/tmp/synthetic-folder"]);
});

test("macOS Finder file-list metadata is decoded in full", { skip: process.platform !== "darwin" }, async () => {
  const xml = '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>/tmp/first folder</string><string>/tmp/second</string></array></plist>';
  assert.deepEqual(await nativeClipboardPaths(clipboard({ NSFilenamesPboardType: xml }), "darwin"), ["/tmp/first folder", "/tmp/second"]);
});

test("async child output stays binary and a hung helper rejects at its timeout", async () => {
  const binary = await execFileAsync(process.execPath, ["-e", "process.stdout.write(Buffer.from([0, 255, 1]))"], {});
  assert.deepEqual([...binary], [0, 255, 1]);
  await assert.rejects(execFileAsync(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeout: 50 }), /clipboard file list read failed|timed out/i);
});

test("directory metadata never copies a tree and mixed files use the existing import capability", async t => {
  const root = await mkdtemp(join(tmpdir(), "composer-folders-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "folder & 中文"), file = join(root, "notes.txt");
  await mkdir(folder);
  await writeFile(join(folder, "keep.txt"), "original");
  await writeFile(file, "notes");
  let captured;
  const result = await readComposerClipboardDirectories(clipboard({}), paths => { captured = paths; return "selection"; }, () => [folder, file]);
  assert.deepEqual(result.items.map(item => item.kind), ["directory", "file"]);
  assert.equal(result.items[0].name, "folder & 中文");
  assert.equal(result.token, "selection");
  assert.equal(captured.length, 1);
  assert.equal(result.items[1].path, undefined, "regular source paths stay in main");
  assert.equal(await readFile(join(folder, "keep.txt"), "utf8"), "original");
  assert.equal(await readComposerClipboardDirectories(clipboard({}), () => assert.fail("regular-only paste keeps its current flow"), () => [file]), null);
});

test("both send serializers include one directory instruction and escaped path markers", () => {
  const refs = [{ path: "/tmp/a & <b>", kind: "directory", token: "\ue001" }, { path: "/tmp/two", kind: "directory", token: "\ue002" }];
  for (const serialize of [serializeComposerFileReferences, serializeInlineComposerFileReferences]) {
    const result = serialize("Inspect \ue001 and \ue002", refs);
    assert.ok(result.includes("<dir>/tmp/a &amp; &lt;b&gt;</dir>"));
    assert.ok(result.includes("<dir>/tmp/two</dir>"));
    assert.equal(result.match(/Inspect their structure/g)?.length, 1);
    assert.equal(serialize("Removed both", refs), "Removed both");
    assert.equal(serialize("", [{ path: "/tmp/without-token", kind: "directory" }]).includes("<dir>/tmp/without-token</dir>"), true);
  }
});

test("restore moves older folder chips out of the editable without changing file tokens", () => {
  const { detachDirectoryTokens } = load("../src/features/chat/composer/directory-attachments.ts");
  const reference = { path: "/tmp/folder.txt", name: "folder.txt", kind: "directory", token: "\ue001" };
  const file = { path: "/tmp/file.txt", name: "file.txt", kind: "file", token: "\ue002" };
  assert.deepEqual(detachDirectoryTokens("before \ue001after \ue002", [reference, file]), {
    text: "before after \ue002",
    references: [{ path: reference.path, name: reference.name, kind: "directory" }, file],
  });
  assert.deepEqual(detachDirectoryTokens("removed", [reference]), { text: "removed", references: [] });
});
