#!/usr/bin/env node
// 脱离 PI-Desktop 的独立运行/自测入口：用一个可预测的 mock 宿主驱动原版 miniapp/node/server.mjs。
// 用途：开发调试、验证移植后的源码零改动可用性、以及 L2 工具循环是否真的跑起来。
// 生产环境由 main.cjs 注入真实 pi.*；本文件不参与插件加载。

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { startBotHost, consoleLogger } from './miniapp-context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HERE);

function parseArgs(argv) {
  const out = { mode: 'loop', data: join(PLUGIN_ROOT, '.dev-data'), selftest: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { out.help = true; continue; }
    if (key === '--selftest') { out.selftest = true; continue; }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 缺少参数`);
    if (key === '--mode') out.mode = value;
    else if (key === '--data') out.data = resolve(value);
    else throw new Error(`未知参数: ${key}`);
    i += 1;
  }
  if (!['complete', 'loop', 'native'].includes(out.mode)) throw new Error('--mode 只能是 complete|loop|native');
  return out;
}

function mockPi(dataDir, mode, logger) {
  const workspace = join(dataDir, 'workspace');
  const inside = async (target) => {
    const full = resolve(workspace, String(target ?? ''));
    const rel = relative(resolve(workspace), full);
    if (rel.startsWith('..') || rel.startsWith('/') || rel.includes('..')) throw new Error('路径越界');
    return full;
  };
  let calls = 0;
  let hostSessionSeq = 0;
  let lastPrompt = '';
  let turnRunning = false;
  const eventHandlers = new Map();
  const events = {
    on: (name, handler) => {
      if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
      eventHandlers.get(name).add(handler);
    },
    off: (name, handler) => eventHandlers.get(name)?.delete(handler),
    emit: (name, payload) => {
      for (const handler of eventHandlers.get(name) ?? []) {
        try { handler(payload); } catch (error) { logger.warn('mock.event.failed', { message: String(error?.message ?? error) }); }
      }
    },
  };
  // 模拟 PI-Desktop 宿主：一个真实 Agent 回合会先跑工具、再流式吐字、最后给 durable 收口回执。
  const runHostTurn = (sessionId, content) => {
    lastPrompt = String(content);
    const summary = lastPrompt.split('\n').filter(Boolean).at(-1) ?? '';
    const fullText = `【Native Agent】已用宿主工具完成：${summary.slice(0, 100)}（含 bash / 文件 / MCP 全套能力）`;
    setImmediate(() => {
      events.emit('desktop:agentEvent', { sessionId, event: { type: 'turn_start' } });
      events.emit('desktop:agentEvent', { sessionId, event: { type: 'tool_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'echo ok' } } });
      events.emit('desktop:agentEvent', { sessionId, event: { type: 'tool_end', toolCallId: 'call_1', result: 'ok', isError: false } });
      events.emit('desktop:agentEvent', { sessionId, event: { type: 'message_update', stream: 'delta', message: { role: 'assistant', content: '' }, deltaText: '【Native Agent】' } });
      events.emit('desktop:agentEvent', { sessionId, event: { type: 'message_update', stream: 'delta', message: { role: 'assistant', content: '' }, deltaText: fullText.slice('【Native Agent】'.length) } });
      events.emit('desktop:agentEvent', { sessionId, event: { type: 'message_end', message: { role: 'assistant', content: fullText } } });
      events.emit('desktop:agentEvent', { sessionId, event: { type: 'turn_end' } });
      turnRunning = false;
      events.emit('desktop:turnEnded', { sessionId, turnId: `hostturn_${calls}`, reason: 'completed', persisted: true });
    });
    return fullText;
  };
  return {
    plugin: {
      getId: () => 'pi.bot',
      getManifest: () => ({ id: 'pi.bot', version: '0.7.24' }),
      getSettings: async () => ({ agentMode: mode }),
      setSettings: async () => {},
      getDataPath: async () => dataDir,
    },
    models: {
      list: async () => [{
        key: 'mock/mock-1', providerId: 'mock', providerName: 'Mock', modelId: 'mock-1',
        label: 'Mock Model', isDefault: true, supportsReasoning: false, thinkingLevels: [],
      }],
    },
    agent: {
      // 第一次返回一次工具调用，拿到工具结果后给最终答复；这样能证明 L2 循环与事件合成生效。
      complete: async ({ system = '', messages = [] }) => {
        calls += 1;
        const last = messages.at(-1)?.content ?? '';
        const toolResultSeen = last.startsWith('工具 ');
        if (mode === 'loop' && !toolResultSeen && String(system).includes('bot_tool')) {
          return {
            text: '{"tool":"bot_tool","args":{"name":"list_team","arguments":{}}}',
            modelKey: 'mock/mock-1',
          };
        }
        const summary = String(last).split('\n').filter(Boolean).at(-1) ?? '';
        return {
          text: `【Mock Bot 第 ${calls} 次调用】已处理：${summary.slice(0, 120)}${toolResultSeen ? '（已结合工具结果）' : ''}`,
          modelKey: 'mock/mock-1',
        };
      },
    },
    fs: {
      readText: async (p) => readFile(await inside(p), 'utf8'),
      writeText: async (p, content) => {
        const full = await inside(p);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, String(content), 'utf8');
      },
      list: async (p) => {
        const full = await inside(p);
        const names = await readdir(full).catch(() => []);
        return Promise.all(names.map(async (name) => {
          const info = await stat(join(full, name)).catch(() => null);
          return { name, path: join(String(p), name), isDirectory: info?.isDirectory() ?? false, size: info?.size };
        }));
      },
      glob: async (pattern) => {
        const names = await readdir(workspace).catch(() => []);
        const tail = String(pattern).replace(/^\*\*\//, '').replace(/\*/g, '');
        return names.filter((name) => name.includes(tail)).map((name) => name);
      },
    },
    net: {
      fetch: async ({ url }) => {
        const parsed = new URL(String(url));
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 http/https');
        logger.info('mock.net.fetch', { url: parsed.origin });
        return `(mock fetch) ${parsed.origin}`;
      },
    },
    events,
    desktop: {
      listOperations: async () => [
        { id: 'session/create', risk: 'write' },
        { id: 'agent/prompt', risk: 'write' },
        { id: 'agent/getStatus', risk: 'read' },
        { id: 'session/get', risk: 'read' },
      ],
      subscribeAgentEvents: async ({ sessionId }) => ({ subscriptionId: `sub_${sessionId}` }),
      unsubscribeAgentEvents: async () => ({}),
      invoke: async ({ operation, args = [] }) => {
        switch (operation) {
          case 'session/create':
            return { session: { id: `pi_sess_${++hostSessionSeq}` } };
          case 'agent/prompt': {
            const sessionId = args[0]?.sessionId;
            if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId 缺失');
            turnRunning = true;
            runHostTurn(sessionId, args[0]?.content ?? '');
            return { accepted: true };
          }
          case 'agent/getStatus':
            return { state: turnRunning ? 'running' : 'idle', running: turnRunning };
          case 'session/get':
            return { messages: [{ role: 'assistant', content: `【Native Agent】兜底读取：${String(lastPrompt).slice(-80)}` }] };
          case 'agent/abort':
            turnRunning = false;
            return { ok: true };
          default:
            throw Object.assign(new Error(`mock 不支持 ${operation}`), { code: 'NOT_FOUND' });
        }
      },
    },
    ui: { openPanel: async () => {}, showToast: async () => {} },
    commands: { register: async () => {}, unregister: async () => {} },
    services: { register: () => {}, unregister: async () => {} },
    needsWorkspace: () => workspace,
  };
}

const waitFor = async (check, { timeoutMs = 8000, intervalMs = 150 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) return null;
    await new Promise((resolve_) => setTimeout(resolve_, intervalMs));
  }
};

async function selftest(origin, mode) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const api = async (path, init) => {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  };

  const page = await fetch(`${origin}/bot`);
  check('原版页面 /bot 可访问', page.status === 200, `HTTP ${page.status}`);
  const state = await api('/api/state');
  check('/api/state 返回团队快照', state.status === 200 && Array.isArray(state.body.bots), `${state.body.bots?.length ?? 0} 个 Bot`);
  const chief = state.body.bots?.[0];

  const mcp = await api('/mcp/minimax-bot', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const tools = mcp.body?.result?.tools ?? [];
  check('MCP tools/list 完整', tools.length >= 21, `${tools.length} 个工具`);

  const bot = await api('/api/bots', {
    method: 'POST',
    body: JSON.stringify({ name: 'Recon', role: '测绘', instructions: '先列已知项与待证项' }),
  });
  check('建 Bot', bot.status === 200 && Boolean(bot.body?.bot?.id), bot.body?.bot?.id ?? JSON.stringify(bot.body));

  const group = await api('/api/groups', {
    method: 'POST',
    body: JSON.stringify({
      name: '移植验证群', replyMode: 'admin',
      members: [chief.id, bot.body?.bot?.id].filter(Boolean),
      admin: chief.id,
    }),
  });
  check('建群（默认全员）', group.status === 200 && Boolean(group.body?.group?.id), group.body?.group?.id ?? JSON.stringify(group.body));

  const memory = await api('/api/memory/team', {
    method: 'POST',
    body: JSON.stringify({ text: '移植验证：结论先行、证据优先', key: 'port.verify' }),
  });
  check('团队记忆写入', memory.status === 200 && memory.body?.entries?.length === 1, `${memory.body?.entries?.length ?? 0} 条`);

  const schedule = await api('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({ name: '每日汇总', prompt: '汇总今日进展', kind: 'daily', time: '09:00', botId: chief.id }),
  });
  check('定时任务创建', schedule.status === 200 && Boolean(schedule.body?.schedule?.nextRunAt),
    schedule.body?.schedule?.id ?? JSON.stringify(schedule.body).slice(0, 160));

  const chatId = `bot:${chief.id}`;
  const sent = await api(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: '给我一份移植结论' }),
  });
  check('发送私聊消息', sent.status === 200 && Boolean(sent.body?.message?.id), sent.body?.message?.id ?? '');

  // 首次启动原插件会自己写一条 Chief 欢迎语，必须按 seq 排除掉它，否则测的不是刚触发的回合。
  const sentSeq = sent.body?.message?.seq ?? 0;
  const done = await waitFor(async () => {
    const page_ = await api(`/api/chats/${chatId}/messages?limit=50`);
    return page_.body?.messages?.find((m) => m.seq > sentSeq && m.role === 'bot' && m.status === 'done');
  });
  check('Bot 回合完成并落盘', Boolean(done), done ? done.text.slice(0, 60) : '超时未收到 bot done');
  if (mode === 'loop') {
    check('L2 工具循环产生工具片段', Array.isArray(done?.parts) && done.parts.some((p) => p.type === 'tool'),
      `parts=${done?.parts?.length ?? 0}`);
    check('最终答复结合工具结果', String(done?.text ?? '').includes('工具结果'), done?.text?.slice(0, 80) ?? '');
  }
  if (mode === 'native') {
    check('L3 宿主完整回合带工具事件', Array.isArray(done?.parts) && done.parts.some((p) => p.type === 'tool'),
      `parts=${done?.parts?.length ?? 0}`);
    check('L3 回复来自宿主 Agent 流式事件', String(done?.text ?? '').includes('Native Agent'), done?.text?.slice(0, 80) ?? '');
    check('L3 回复带宿主工具执行结果', String(done?.text ?? '').includes('宿主工具完成'), done?.text?.slice(0, 80) ?? '');
  }

  const groupId = group.body?.group?.id;
  if (groupId) {
    const groupSent = await api(`/api/chats/group:${groupId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: '@Recon 先做测绘' }),
    });
    const groupSeq = groupSent.body?.message?.seq ?? 0;
    const groupDone = await waitFor(async () => {
      const page_ = await api(`/api/chats/group:${groupId}/messages?limit=50`);
      return page_.body?.messages?.some((m) => m.seq > groupSeq && m.role === 'bot' && ['done', 'pass'].includes(m.status));
    });
    check('群聊 @ 点名触发 Bot 回合', Boolean(groupDone));
  }

  const usageHit = await waitFor(async () => {
    const page_ = await api('/api/usage?days=1');
    return page_.status === 200 && page_.body?.totals?.turns > 0 ? page_.body : null;
  });
  check('用量账本记录回合', Boolean(usageHit), `turns=${usageHit?.totals?.turns ?? 0}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n自测结果: ${results.length - failed.length}/${results.length} 通过（模式 ${mode}）`);
  return failed.length === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node host/standalone.mjs [--mode complete|loop|native] [--data DIR] [--selftest]');
    console.log('  --mode loop      启用本地 Agent 工具循环（默认）');
    console.log('  --mode complete  仅纯文本补全');
    console.log('  --mode native    L3：用 desktop.control 跑宿主完整 Agent 回合（带全套工具）');
    console.log('  --selftest       启动后自动跑 HTTP/MCP/回合/工具/群聊/定时/记忆断言并退出');
    return;
  }
  await mkdir(args.data, { recursive: true });
  await mkdir(join(args.data, 'workspace'), { recursive: true });
  const logger = consoleLogger('pi.bot.standalone');
  const pi = mockPi(args.data, args.mode, logger);
  const host = await startBotHost({ pi, pluginRoot: PLUGIN_ROOT, dataDir: args.data, mode: args.mode, logger });
  console.log(`\nMiniMax Bot 独立运行: ${host.origin}/bot   模式=${args.mode}   数据=${args.data}\n`);

  if (args.selftest) {
    let ok = false;
    try { ok = await selftest(host.origin, args.mode); }
    catch (error) { console.error(`自测异常: ${error.stack ?? error.message}`); }
    await host.dispose();
    process.exit(ok ? 0 : 1);
  }

  const shutdown = async () => {
    await host.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error(`启动失败: ${error.stack ?? error.message}`);
  process.exit(1);
});

// 运行：node host/standalone.mjs --mode loop --data ./.dev-data
// 自测：node host/standalone.mjs --mode loop --selftest
// 纯文本模式：node host/standalone.mjs --mode complete
