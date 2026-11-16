import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/styles/messages.css", import.meta.url), "utf8");

test("subagent branches align to variable-height card centers", () => {
  const node = styles.match(/\.subagent-topology-node\s*\{([^}]+)\}/)?.[1] ?? "";
  const branch = styles.match(/\.subagent-topology-node::before\s*\{([^}]+)\}/)?.[1] ?? "";
  const trunk = styles.match(/\.subagent-topology-agents::before\s*\{([^}]+)\}/)?.[1] ?? "";

  assert.match(node, /min-height:\s*72px/);
  assert.match(branch, /top:\s*50%/);
  assert.match(branch, /transform:\s*translateY\(-50%\)/);
  assert.match(trunk, /top:\s*36px/);
  assert.match(trunk, /bottom:\s*36px/);
  assert.doesNotMatch(branch, /top:\s*35px/);
});
