import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.log("SKIP: Windows PowerShell 5.1 encoding check requires Windows.");
  process.exit(0);
}

const powershell = process.env.SystemRoot
  ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe";
const version = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
  encoding: "utf8",
  windowsHide: true,
});
if (version.error || version.status !== 0) {
  throw version.error ?? new Error(`could not query PowerShell version: ${version.stderr}`);
}
const versionText = version.stdout.trim();
if (!versionText.startsWith("5.1.")) {
  console.log(`SKIP: Windows PowerShell 5.1 not selected (found ${versionText}).`);
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "pi-ps51-utf8-"));
try {
  // The literal tests the script-file decoder. The expected value is built
  // from code points so it remains ASCII and cannot inherit the same mistake.
  const source = [
    "$expected = \"$([char]0x4E2D)$([char]0x6587)$([char]0x6D4B)$([char]0x8BD5)\"",
    "$value = '中文测试'",
    "if ($value -ceq $expected) { [Console]::WriteLine('PASS'); exit 0 }",
    "[Console]::WriteLine('MISMATCH'); exit 17",
  ].join("\r\n");
  const noBomPath = join(directory, "utf8-no-bom.ps1");
  const bomPath = join(directory, "utf8-with-bom.ps1");
  writeFileSync(noBomPath, Buffer.from(source, "utf8"));
  writeFileSync(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, "utf8")]));

  const run = (path) =>
    spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", path], {
      encoding: "utf8",
      windowsHide: true,
    });

  const noBom = run(noBomPath);
  const withBom = run(bomPath);
  assert.equal(noBom.error, undefined, noBom.error?.message);
  assert.equal(withBom.error, undefined, withBom.error?.message);
  assert.equal(noBom.status, 17, `expected no-BOM UTF-8 script to expose PS 5.1 decoding behavior: ${noBom.stdout} ${noBom.stderr}`);
  assert.equal(withBom.status, 0, `BOM UTF-8 script should preserve Chinese text: ${withBom.stdout} ${withBom.stderr}`);
  assert.match(withBom.stdout, /PASS/);
  console.log(JSON.stringify({ powerShellVersion: versionText, noBom: noBom.status, withBom: withBom.status, result: "PASS" }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
