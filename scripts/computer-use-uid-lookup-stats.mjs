#!/usr/bin/env node
/**
 * 统计 computer-use 的 uid 查找命中率。
 *
 * 为什么需要它：Windows 后端的 uid 里含元素在观测数组中的位置，树上任何一处插入或
 * 删除都会让其后所有 uid 失效。命中率低说明模型每做一步都要重新观测整棵树，那么
 * "让 identity 跨观测稳定"就是修复而不是优化；命中率高则说明为它改造遍历方式是过度设计。
 *
 * 输入：host-core 的 tracing 输出（`RUST_LOG=computer=debug`，或带 `--nocapture` 的测试输出）。
 * 输出：命中/未命中计数与比率，按 target_id 分组；无数据时明确报告"无数据"而不是 0。
 *
 * 用法：
 *   node scripts/computer-use-uid-lookup-stats.mjs <log-file> [more-log-files...]
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ANSI = /\u001b\[[0-9;]*m/g;
const HIT = "computer-use uid lookup hit";
const MISS = "computer-use uid lookup missed";
const TARGET_ID = /target_id=(\S+)/;

function usage() {
  process.stdout.write(
    "usage: node scripts/computer-use-uid-lookup-stats.mjs <log-file> [more...]\n",
  );
}

function tally(records, line, key) {
  const target = TARGET_ID.exec(line)?.[1] ?? "<unknown>";
  const bucket = records.get(target) ?? { hits: 0, misses: 0 };
  bucket[key] += 1;
  records.set(target, bucket);
}

async function main() {
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (files.length === 0) {
    usage();
    process.exit(2);
  }

  const byTarget = new Map();
  let hits = 0;
  let misses = 0;
  let scannedFiles = 0;

  for (const file of files) {
    let text;
    try {
      text = await readFile(resolve(file), "utf8");
    } catch (error) {
      process.stderr.write(`cannot read ${file}: ${error.message}\n`);
      continue;
    }
    scannedFiles += 1;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.replace(ANSI, "");
      if (line.includes(HIT)) {
        hits += 1;
        tally(byTarget, line, "hits");
      } else if (line.includes(MISS)) {
        misses += 1;
        tally(byTarget, line, "misses");
      }
    }
  }

  const lookups = hits + misses;
  const targetCount = byTarget.size;
  // 0% 失配只有在"观测期间树确实变过"时才有意义。单一静态目标（例如验收用的
  // fixture 窗口）从不变更树结构，只能得出"共 0 次机会失效"，不能作为 churn 结论。
  const inconclusive = misses === 0 && targetCount <= 1;
  const summary = {
    filesScanned: scannedFiles,
    lookups,
    hits,
    misses,
    // 没有查找记录时比率无意义，给 null 而不是 0，避免被读成"从未失效"。
    missRatio: lookups === 0 ? null : Number((misses / lookups).toFixed(4)),
    verdict:
      lookups === 0
        ? "no data: 没有 uid 查找日志，先跑一次带 computer=debug 的真实任务"
        : inconclusive
          ? "inconclusive: 单一目标且零失配，只说明观测期间树没变，不能推断真实 churn"
          : misses / lookups >= 0.15
            ? "high churn: 稳定 identity 改造值得做"
            : misses / lookups >= 0.05
              ? "moderate churn: 先确认这些 miss 是否集中在会插入节点的界面"
              : "low churn: 当前 uid 语义够用，改造属过度设计",
    targetCount,
    byTarget: Object.fromEntries(
      [...byTarget.entries()]
        .sort((left, right) => right[1].hits + right[1].misses - (left[1].hits + left[1].misses))
        .map(([target, bucket]) => {
          const total = bucket.hits + bucket.misses;
          return [
            target,
            {
              ...bucket,
              lookups: total,
              missRatio: total === 0 ? null : Number((bucket.misses / total).toFixed(4)),
            },
          ];
        }),
    ),
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
