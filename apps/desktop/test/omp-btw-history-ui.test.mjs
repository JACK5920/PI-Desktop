import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("OMP BTW keeps topic history navigable and follow-up/cancel actions record-scoped", async () => {
  const controls = await read("../src/components/OmpNativeControls.tsx");
  const styles = await read("../src/styles/composer-menus.css");
  const en = await read("../../../packages/i18n/src/locales/en/index.ts");
  const zh = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");
  assert.match(controls, /get_btw_history/);
  assert.match(controls, /btwSelectedRecordId/);
  assert.match(controls, /btwHistoryRefreshPendingRef/);
  assert.match(controls, /btwSubmittingRef\.current/);
  assert.match(controls, /setSelectedRecordId|setBtwSelectedRecordId/);
  assert.match(controls, /onClick=\{\(\) => void refreshBtwHistory\(\)\.catch/);
  assert.doesNotMatch(controls, /<header><strong>\{t\("settings\.omp\.sideQuestions"\)\}<\/strong><button[^>]*onClick=\{\(\) => void openBtw\(\)\}/);
  assert.match(controls, /fields: \{ question, \.\.\.\(btwFollowupRecordId \? \{ recordId: btwFollowupRecordId \} : \{\}\) \}/);
  assert.match(controls, /recordId: record\.id/);
  assert.match(controls, /btwRecords\.some\(\(record\) => record\.status === "running"\)/);
  assert.match(controls, /selectedBtwRecord\.followUps\) \? selectedBtwRecord\.followUps\.map/);
  assert.match(controls, /updatedAt \?\? selectedBtwRecord\.createdAt/);
  assert.match(styles, /\.omp-native-btw-list-row/);
  assert.match(styles, /\.omp-native-btw-detail/);
  for (const key of ["noSideQuestions", "btwStatusRunning", "btwStatusComplete", "btwStatusCancelled", "btwStatusError", "btwStatusInterrupted"]) {
    assert.match(en, new RegExp(`${key}:`));
    assert.match(zh, new RegExp(`${key}:`));
  }
});
