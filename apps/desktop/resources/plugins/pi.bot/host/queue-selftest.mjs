#!/usr/bin/env node
// 排队能力回归（0.7.31 契约）。两段都跑：
//   1) 桥接层：同会话串行 / 跨会话并行 / 排队中取消 / 未声明 whenBusy 的旧行为
//   2) 引擎全链路：startBotHost → 原版 server/engine → 并发触发不报 BUSY
// 运行：node host/queue-selftest.mjs [--data DIR]

import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentBridge } from './agent-bridge.mjs';
import { startBotHost, consoleLogger } from './miniapp-context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HERE);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
const mockModels = { list: async () => [{ providerId: 'mock', modelId: 'm1', label: 'Mock', isDefault: true }] };

function slowPi(log, delayMs) {
  return {
    models: mockModels,
    agent: {
      complete: async ({ messages }) => {
        const text = String(messages.at(-1)?.content ?? '');
        log.push({ phase: 'start', text, at: Date.now() });
        await sleep(delayMs);
        log.push({ phase: 'end', text, at: Date.now() });
        return { text: `reply:${text.slice(-12)}` };
      },
    },
    fs: {},
    net: { fetch: async () => ({}) },
  };
}

async function bridgePhase() {
  const log = [];
  const bridge = createAgentBridge({ pi: slowPi(log, 400), logger: quietLogger, mode: 'loop' });

  // 同一会话并发：第二个必须排队。
  const events = [];
  const first = bridge.run({ text: 'A', sessionId: 's1', whenBusy: 'queue' }, { onEvent: () => {} });
  await sleep(60);
  const second = bridge.run({ text: 'B', sessionId: 's1', whenBusy: 'queue' }, { onEvent: (event) => events.push(event) });
  const [r1, r2] = await Promise.all([first, second]);
  const queued = events.find((event) => event.type === 'run.queued');
  check('同会话第二个请求收到 run.queued', Boolean(queued), JSON.stringify(queued ?? null));
  check('排队位次为 1', queued?.position === 1, `position=${queued?.position}`);
  const a = log.find((entry) => entry.phase === 'start' && entry.text === 'A');
  const b = log.find((entry) => entry.phase === 'start' && entry.text === 'B');
  check('第二个回合在第一个结束后才开始', Boolean(a && b && b.at >= a.at + 380), `A=${a?.at} B=${b?.at}`);
  check('两个回合都返回正文', r1.text === 'reply:A' && r2.text === 'reply:B', `${r1.text} / ${r2.text}`);

  // 不同会话互不影响。
  const parallelLog = [];
  const parallelBridge = createAgentBridge({ pi: slowPi(parallelLog, 400), logger: quietLogger, mode: 'loop' });
  await Promise.all([
    parallelBridge.run({ text: 'X', sessionId: 'sa', whenBusy: 'queue' }, { onEvent: () => {} }),
    parallelBridge.run({ text: 'Y', sessionId: 'sb', whenBusy: 'queue' }, { onEvent: () => {} }),
  ]);
  const starts = parallelLog.filter((entry) => entry.phase === 'start');
  check('不同会话并行执行', starts.length === 2 && Math.abs(starts[0].at - starts[1].at) < 200,
    `delta=${starts.length === 2 ? Math.abs(starts[0].at - starts[1].at) : 'n/a'}ms`);

  // 排队中取消：不执行，返回 REQUEST_CANCELLED。
  const cancelLog = [];
  const cancelBridge = createAgentBridge({ pi: slowPi(cancelLog, 400), logger: quietLogger, mode: 'loop' });
  const holder = cancelBridge.run({ text: 'hold', sessionId: 's2', whenBusy: 'queue' }, { onEvent: () => {} });
  await sleep(60);
  const controller = new AbortController();
  const cancelEvents = [];
  const queuedRun = cancelBridge.run({ text: 'queued-then-abort', sessionId: 's2', whenBusy: 'queue' },
    { onEvent: (event) => cancelEvents.push(event), signal: controller.signal });
  await sleep(60);
  controller.abort();
  let code = '';
  try { await queuedRun; } catch (error) { code = String(error?.code ?? error?.message); }
  await holder;
  await sleep(500);
  check('排队中取消返回 REQUEST_CANCELLED', code === 'REQUEST_CANCELLED', code);
  check('取消的请求没有执行', !cancelLog.some((entry) => entry.phase === 'start' && entry.text === 'queued-then-abort'));
  check('取消发生在排队阶段', cancelEvents.some((event) => event.type === 'run.queued'));

  // 旧行为与能力表。
  const legacyLog = [];
  const legacyBridge = createAgentBridge({ pi: slowPi(legacyLog, 10), logger: quietLogger, mode: 'loop' });
  await legacyBridge.run({ text: 'legacy', sessionId: 's3' }, { onEvent: () => {} });
  check('未声明 whenBusy 仍直接运行', legacyLog.some((entry) => entry.phase === 'start'));
  check('能力表声明 agent.run', legacyBridge.capabilities.has('agent.run') === true);
  check('能力表不虚报其他能力', legacyBridge.capabilities.has('agent.window') === false);
}

async function enginePhase(dataDir) {
  const log = [];
  const pi = { ...slowPi(log, 1200), plugin: { getDataPath: async () => dataDir } };
  const host = await startBotHost({ pi, pluginRoot: PLUGIN_ROOT, dataDir, mode: 'loop', logger: quietLogger });
  const api = async (path, init) => {
    const response = await fetch(host.origin + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const waitFor = async (chatId, seq) => {
    for (let i = 0; i < 120; i += 1) {
      const page = (await api(`/api/chats/${chatId}/messages?limit=50`)).body;
      const errored = (page.messages ?? []).find((m) => m.seq > seq && m.errorCode);
      if (errored) return { errored };
      const reply = (page.messages ?? []).find((m) => m.seq > seq && m.role === 'bot' && m.status === 'done');
      if (reply) return { reply };
      await sleep(250);
    }
    return {};
  };

  try {
    const state = (await api('/api/state')).body;
    const chief = state.bots[0];
    const created = (await api('/api/bots', { method: 'POST', body: JSON.stringify({ name: 'Concurrent' }) })).body.bot;
    assert.ok(created?.id, `建测试 Bot 失败: ${JSON.stringify(created)}`);
    const group = (await api('/api/groups', { method: 'POST', body: JSON.stringify({
      name: '并发验证群', replyMode: 'admin', members: [created.id], admin: chief.id,
    }) })).body.group;

    const chatPrivate = `bot:${created.id}`;
    const chatGroup = `group:${group.id}`;
    const first = await api(`/api/chats/${chatPrivate}/messages`, { method: 'POST', body: JSON.stringify({ text: '第一轮' }) });
    const firstDone = await waitFor(chatPrivate, first.body.message.seq);
    check('首轮建立会话', Boolean(firstDone.reply?.sessionId), firstDone.reply?.sessionId ?? 'none');

    // 带 sessionId 的第二轮会让引擎真正走到 capabilities.has(...)，能力缺失会直接抛错。
    const second = await api(`/api/chats/${chatPrivate}/messages`, { method: 'POST', body: JSON.stringify({ text: '第二轮' }) });
    const secondDone = await waitFor(chatPrivate, second.body.message.seq);
    check('带 sessionId 的第二轮成功（能力表接线正确）', Boolean(secondDone.reply), secondDone.reply?.text?.slice(0, 24) ?? 'none');

    log.length = 0;
    const [sentPrivate, sentGroup] = await Promise.all([
      api(`/api/chats/${chatPrivate}/messages`, { method: 'POST', body: JSON.stringify({ text: '私聊触发' }) }),
      api(`/api/chats/${chatGroup}/messages`, { method: 'POST', body: JSON.stringify({ text: `@${created.name} 群聊触发` }) }),
    ]);
    const [priv, grp] = await Promise.all([
      waitFor(chatPrivate, sentPrivate.body.message.seq),
      waitFor(chatGroup, sentGroup.body.message.seq),
    ]);
    check('私聊回合完成', Boolean(priv.reply), priv.reply?.text?.slice(0, 24) ?? JSON.stringify(priv.errored ?? null));
    check('群聊回合完成', Boolean(grp.reply), grp.reply?.text?.slice(0, 24) ?? JSON.stringify(grp.errored ?? null));
    check('没有 BUSY/错误码', !priv.errored && !grp.errored,
      [priv.errored?.errorCode, grp.errored?.errorCode].filter(Boolean).join(',') || 'none');

    const sameSession = Boolean(priv.reply?.sessionId) && priv.reply.sessionId === grp.reply?.sessionId;
    const starts = log.map((entry) => entry.at);
    const serialized = starts.length < 2 || starts[1] - starts[0] >= 1100;
    check(sameSession ? '同会话并发已串行化' : '不同会话各自独立执行', sameSession ? serialized : true,
      `sameSession=${sameSession} calls=${starts.join(' → ')}`);
  } finally {
    await host.dispose();
  }
}

function parseArgs(argv) {
  const out = { data: join(PLUGIN_ROOT, '.queue-selftest-data') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--data 缺少目录');
      out.data = value;
      i += 1;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法: node host/queue-selftest.mjs [--data DIR]');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${argv[i]}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
try {
  await bridgePhase();
  await rm(args.data, { recursive: true, force: true });
  await mkdir(join(args.data, 'workspace'), { recursive: true });
  await enginePhase(args.data);
} catch (error) {
  failed += 1;
  console.error(`异常: ${error?.stack ?? error}`);
} finally {
  await rm(args.data, { recursive: true, force: true });
}

console.log(`\n排队回归: ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
