import assert from "node:assert/strict";
import test from "node:test";
import { OMP_WORKSPACE_FILE_LIMIT, normalizeOmpHostToolRequest, normalizeOmpWorkspacePath, workspacePathFromOmpUri } from "../electron/main/omp/host-bridge.mjs";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("OMP host workspace paths reject absolute paths and traversal, including encoded URI traversal", () => {
  assert.equal(normalizeOmpWorkspacePath("src\\main.ts"), "src/main.ts");
  for (const value of ["", "../secret", "src/../../secret", "C:\\secret", "/etc/passwd", "./secret"]) {
    assert.throws(() => normalizeOmpWorkspacePath(value));
  }
  assert.equal(workspacePathFromOmpUri("pi-workspace://src/main.ts"), "src/main.ts");
  assert.throws(() => workspacePathFromOmpUri("pi-workspace:///%2e%2e/secret"));
  assert.throws(() => workspacePathFromOmpUri("file:///etc/passwd"));
});

test("OMP host tools map strict relative read/write/edit requests to Host Core tool calls", () => {
  assert.deepEqual(normalizeOmpHostToolRequest("pi_read_workspace_file", { path: "src/main.ts", offset: 0, limit: 100 }), {
    toolName: "Read", args: { path: "src/main.ts", offset: 0, limit: 100 },
  });
  assert.deepEqual(normalizeOmpHostToolRequest("pi_write_workspace_file", { path: "notes/result.md", content: "safe" }), {
    toolName: "Write", args: { path: "notes/result.md", content: "safe" },
  });
  assert.deepEqual(normalizeOmpHostToolRequest("pi_edit_workspace_file", { path: "src/main.ts", oldText: "before", newText: "after" }), {
    toolName: "Edit", args: { path: "src/main.ts", oldText: "before", newText: "after" },
  });
  assert.throws(() => normalizeOmpHostToolRequest("pi_read_workspace_file", { path: "src/a", extra: true }));
  assert.throws(() => normalizeOmpHostToolRequest("pi_read_workspace_file", { path: "src/a", offset: -1 }));
  assert.throws(() => normalizeOmpHostToolRequest("pi_read_workspace_file", { path: "src/a", limit: OMP_WORKSPACE_FILE_LIMIT + 1 }));
  assert.throws(() => normalizeOmpHostToolRequest("pi_write_workspace_file", { path: "src/a", content: "x".repeat(OMP_WORKSPACE_FILE_LIMIT + 1) }));
  assert.throws(() => normalizeOmpHostToolRequest("pi_edit_workspace_file", { path: "src/a", oldText: "x".repeat(OMP_WORKSPACE_FILE_LIMIT), newText: "y" }));
  assert.throws(() => normalizeOmpHostToolRequest("pi_write_workspace_file", { path: "../outside", content: "no" }));
});

test("OMP registers project-scoped Host tools only when a project root exists and uses Host authorization", async () => {
  const runtime = await read("../electron/main/omp/rpc-runtime.ts");
  const register = await read("../electron/main/ipc/register.ts");
  assert.match(runtime, /name: "pi_read_workspace_file"/);
  assert.match(runtime, /name: "pi_write_workspace_file"/);
  assert.match(runtime, /name: "pi_edit_workspace_file"/);
  assert.match(runtime, /if \(session\.sessionId === this\.options\.settingsSessionId \|\| !this\.options\.executeHostTool \|\| !session\.workspaceRoot\) return/);
  assert.match(runtime, /scheme: "pi-workspace"[\s\S]*?writable: true[\s\S]*?immutable: false/);
  assert.match(runtime, /normalizeOmpHostToolRequest/);
  assert.match(runtime, /workspaceRoot: session\.workspaceRoot/);
  assert.match(register, /host\.call\("tools\.execute"/);
  assert.match(register, /host\.call\("tools\.abort"/);
  assert.match(register, /require a project workspace/);
  assert.match(register, /"OMP workspace changed; reconnect before using Host tools"/);
  assert.doesNotMatch(runtime, /agentRuntime\.call|PI Runtime/);
});
