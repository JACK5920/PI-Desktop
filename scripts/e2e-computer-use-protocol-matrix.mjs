#!/usr/bin/env node
/** Run the isolated Agent → Computer → Host → Windows UIA scenario over each
 * supported provider wire protocol. The model endpoint remains loopback-only.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scenario = join(root, "scripts", "e2e-computer-use-agent-runtime.mjs");
const styles = ["chat_completions", "responses", "anthropic_messages", "google_generative_ai"];
const captureModes = ["a11y-only", "pixels"];

for (const captureMode of captureModes) {
  for (const apiStyle of styles) {
    const env = { ...process.env, PI_COMPUTER_E2E_API_STYLE: apiStyle };
    delete env.PI_COMPUTER_E2E_ELECTRON;
    if (captureMode === "pixels") env.PI_COMPUTER_E2E_CAPTURE_MODE = "pixels";
    else delete env.PI_COMPUTER_E2E_CAPTURE_MODE;
    const result = spawnSync(process.execPath, [scenario], { cwd: root, env, stdio: "inherit" });
    assert.equal(result.error, undefined, `${apiStyle}/${captureMode} scenario could not start`);
    assert.equal(result.status, 0, `${apiStyle}/${captureMode} Computer Use scenario failed`);
    console.log(`COMPUTER USE PROTOCOL PASS ${apiStyle} capture=${captureMode}`);
  }
}

console.log(`COMPUTER USE PROTOCOL × CAPTURE MATRIX PASS ${styles.length * captureModes.length}/${styles.length * captureModes.length}`);
