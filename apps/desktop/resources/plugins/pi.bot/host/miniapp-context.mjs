// 构造原 MiniMax Bot 需要的 MiniAppContext，并在当前进程里启动原 server.mjs。
// 宿主差异全部收敛在这一层：端口、数据目录、日志、agent 桥、生命周期。
// 原 miniapp/node/*.mjs 保持与 MiniMax Code 3.1.14 下发包逐字节一致。

import http from 'node:http';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createAgentBridge } from './agent-bridge.mjs';
import { createNativeAgentBridge } from './native-bridge.mjs';

const HOST = '127.0.0.1';
const MAX_PORT_ATTEMPTS = 4;

let guardRefs = 0;
let originalEmit;

// MiniMax 宿主由 Electron 兜底 /favicon.ico，插件自己没有这条路由。
// 在宿主层拦掉它，既保持 miniapp/node/server.mjs 逐字节原样，也避免面板控制台报错。
function installFaviconGuard() {
  if (guardRefs === 0) {
    originalEmit = http.Server.prototype.emit;
    http.Server.prototype.emit = function guardedEmit(event, ...args) {
      if (event === 'request' && args[0]?.url === '/favicon.ico') {
        args[1].writeHead(204).end();
        return true;
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    };
  }
  guardRefs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    guardRefs -= 1;
    if (guardRefs === 0 && originalEmit) {
      http.Server.prototype.emit = originalEmit;
      originalEmit = undefined;
    }
  };
}

function consoleLogger(prefix = 'pi.bot') {
  const write = (level, message, fields) => {
    const suffix = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
    const line = `[${prefix}] ${level} ${String(message)}${suffix}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

export { consoleLogger };

// 原 start() 自己 createServer().listen(context.listen.port)，且只返回 dispose、不回传实际端口，
// 所以先临时占一个 ephemeral 端口拿到号码；EADDRINUSE 时由 startBotHost 重新探测。
export function findFreePort(host = HOST) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function assertReady(origin) {
  let response;
  try {
    response = await fetch(`${origin}/bot`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(`Bot 页面未就绪: ${String(error?.message ?? error)}`);
  }
  if (response.status !== 200) throw new Error(`Bot 页面返回 ${response.status}`);
}

export async function startBotHost({ pi, pluginRoot, dataDir, mode = 'loop', logger = consoleLogger(), ownFetch }) {
  if (!pluginRoot || !dataDir) throw new Error('pluginRoot 与 dataDir 必须提供');
  const entry = pathToFileURL(join(pluginRoot, 'miniapp', 'node', 'server.mjs')).href;
  const { start } = await import(entry);
  const restoreGuard = installFaviconGuard();
  let handedOff = false;
  let lastError;
  try {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    // 每次重试都要换一枚信号：上一次失败时已 abort，复用会让新服务刚起来就被自己关掉。
    const controller = new AbortController();
    const port = await findFreePort();
    const origin = `http://${HOST}:${port}`;
    let agent = mode === 'native'
      ? createNativeAgentBridge({ pi, logger })
      : createAgentBridge({ pi, logger, mode, origin, ownFetch });
    if (mode === 'native') {
      const caps = await agent.probe();
      if (!caps.supported) {
        // 旧宿主缺 desktop.control 操作时自动退回 L2，别让整个 Bot 服务起不来。
        logger.warn('pi.bot.native.fallback', { missing: caps.missing });
        agent = createAgentBridge({ pi, logger, mode: 'loop', origin, ownFetch });
      }
    }
    const context = {
      pluginId: 'pi.bot',
      pluginRoot,
      dataDir,
      listen: { host: HOST, port },
      signal: controller.signal,
      logger,
      agent,
      // 0.7.31 起的契约：声明后引擎才会带 whenBusy:'queue' 并在忙时排队而不是报 BUSY。
      capabilities: agent.capabilities,
    };
    let lifecycle;
    try {
      lifecycle = await start(context);
      await assertReady(origin);
      logger.info('pi.bot.started', { origin, mode: agent.mode, requestedMode: mode, dataDir });
      let disposed = false;
      handedOff = true;
      return {
        origin,
        port,
        agent,
        async dispose() {
          if (disposed) return;
          disposed = true;
          controller.abort();
          try { await lifecycle?.dispose?.(); } catch (error) {
            logger.warn('pi.bot.dispose.failed', { message: String(error?.message ?? error) });
          } finally {
            try { await agent.dispose?.(); } catch (error) {
              logger.warn('pi.bot.agent.dispose.failed', { message: String(error?.message ?? error) });
            }
            restoreGuard();
          }
        },
      };
    } catch (error) {
      lastError = error;
      controller.abort();
      try { await lifecycle?.dispose?.(); } catch { /* 启动失败时半初始化的服务也要收掉 */ }
      if (!/EADDRINUSE|address already in use/i.test(String(error?.message ?? error))) break;
    }
  }
  throw new Error(`Bot 服务启动失败: ${String(lastError?.message ?? lastError)}`);
  } finally {
    if (!handedOff) restoreGuard();
  }
}
