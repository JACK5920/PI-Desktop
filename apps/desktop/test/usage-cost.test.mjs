import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const file = new URL("../src/lib/usage-cost.ts", import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: file.pathname,
});
const module = { exports: {} };
new Function("require", "exports", "module", outputText)(() => ({}), module.exports, module);
const { formatUsageCost, knownUsageCost } = module.exports;

test("known cost is shown only when usage metadata marks it as priced", () => {
  assert.equal(knownUsageCost({ costStatus: "estimated", cost: { total: 0.0012 } }), 0.0012);
  assert.equal(knownUsageCost({ costStatus: "reported", cost: { total: 0 } }), 0);
  assert.equal(knownUsageCost({ costStatus: "unknown", cost: { total: 2 } }), undefined);
  assert.equal(knownUsageCost({ costStatus: "estimated", cost: { total: Number.NaN } }), undefined);
});

test("currency output is locale-aware and keeps small costs visible", () => {
  assert.match(formatUsageCost(0.000123, "en-US"), /\$0\.000123/);
  assert.match(formatUsageCost(1.25, "de-DE"), /1,25/);
});
