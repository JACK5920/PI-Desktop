// PI-Desktop 插件入口。插件根目录的 package.json 来自 MiniMax 原包（"type": "module"），
// 所以入口必须是 .cjs；host/*.mjs 与 miniapp/node/*.mjs 仍按 ESM 加载，互不影响。
// 这里只做「按需启动原服务 + 暴露面板地址」，原 Bot 业务逻辑一行不改。
//
// 资源策略（本文件的重点）：
//   不注册 contributes.services / background.service。宿主把插件 load 起来之后，
//   这个进程只注册命令、什么都不做，事件循环空转，不占 CPU。
//   Bot 服务（HTTP + SSE + 定时任务调度）只在真正有人打开面板 / 工作面板视图时
//   才由 ensureRuntime() 拉起；最后一个消费者消失后由空闲回收器关掉。
//   原插件里这些逻辑一行没改，只是把「谁来点火、什么时候熄火」收到了这一层。

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const COMMAND_ID = 'pibot.open';
const MODES = new Set(['complete', 'loop', 'native']);

/** 没有心跳就认为没人看，回收 Bot 服务。可用环境变量覆盖（毫秒）。 */
const IDLE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.PI_BOT_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 5000 ? raw : 90_000;
})();

/** 页面卸载时喊的那一声「我关了」，给一点宽限再杀，防止只是重载。 */
const RELEASE_GRACE_MS = 5_000;

let runtime = null;
let starting = null;
let lastDiagnostics = null;
let lastSeen = 0;
/** 页面喊「我关了」的时刻。宽限期内再有任何调用就作废这一笔。 */
let releasedAt = 0;
let idleTimer = null;
let reapCount = 0;

function armReaper(delay = IDLE_TIMEOUT_MS) {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!runtime && !starting) return;
  idleTimer = setTimeout(() => void reap(), delay);
  // 不吊住插件进程退出：插件被禁用时宿主不必等这个计时器。
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

async function reap() {
  idleTimer = null;
  if (!runtime) return;
  // 页面已经卸载过，且宽限期内没有新调用 —— 立刻回收，不必等满一个空闲周期。
  // （直接按 lastSeen 判定不行：release 自己也会续命，那样宽限期永远够不着。）
  if (releasedAt && Date.now() - releasedAt >= RELEASE_GRACE_MS - 50) {
    reapCount += 1;
    console.log(`[pi.bot] 页面已关闭，回收 Bot 服务（第 ${reapCount} 次）`);
    releasedAt = 0;
    await disposeRuntime();
    return;
  }
  const idle = Date.now() - lastSeen;
  if (idle < IDLE_TIMEOUT_MS - 1000) {
    armReaper(Math.max(1000, IDLE_TIMEOUT_MS - idle));
    return;
  }
  reapCount += 1;
  console.log(`[pi.bot] 空闲 ${Math.round(idle / 1000)}s，回收 Bot 服务（第 ${reapCount} 次）`);
  await disposeRuntime();
}

/** 任何一次来自界面的调用都算「还有人要看」；同时作废之前的关闭声明。 */
function touch() {
  lastSeen = Date.now();
  releasedAt = 0;
  armReaper();
}

function normalizeMode(value) {
  // 默认 loop，不是 native。实测结论（2026-11-13 真实事故）：
  // create_bot / create_group / remember / dispatch_tasks 这些**团队工具只挂在
  // 插件自己的 MCP 端点**（/mcp/minimax-bot）上，宿主 Agent 看不到它们；
  // native 走宿主自己的回合，于是「建 Bot、建群、记记忆、派任务」全部失效，
  // 连 Bot 的人格 instructions 也传不过去（native 只发用户那句话）。
  //
  // 所以：loop 是能干活的那条路（文件 + 网络 + 团队工具）；native 只是
  // 「借宿主全套工具」的可选项，要自己显式打开：PI_BOT_AGENT_MODE=native。
  // complete 是只聊天的降级档。两者都不能当默认。
  const mode = String(value ?? 'loop').trim().toLowerCase();
  if (!MODES.has(mode)) {
    console.warn(`[pi.bot] 未知 agentMode=${mode}，回退 loop（可选 complete|loop|native）`);
    return 'loop';
  }
  return mode;
}

async function ensureRuntime() {
  touch();
  if (runtime) return runtime;
  if (starting) return starting;
  starting = (async () => {
    console.log('[pi.bot] 首批界面请求到达，启动 Bot 服务');
    const entry = pathToFileURL(path.join(__dirname, 'host', 'miniapp-context.mjs')).href;
    const { startBotHost, consoleLogger } = await import(entry);
    const dataDir = await pi.plugin.getDataPath();
    const mode = normalizeMode(process.env.PI_BOT_AGENT_MODE);
    runtime = await startBotHost({
      pi,
      pluginRoot: __dirname,
      dataDir,
      mode,
      logger: consoleLogger('pi.bot'),
    });
    lastSeen = Date.now();
    armReaper();
    return runtime;
  })().finally(() => { starting = null; });
  return starting;
}

async function disposeRuntime() {
  if (!runtime) return;
  const current = runtime;
  runtime = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  await current.dispose();
}

/**
 * 面板是宿主沙箱里的一个网页，它能不能加载 http://127.0.0.1:<port> 由宿主的
 * 「出站白名单」（manifest.net.domains）决定。这条自检把两个事实分开问清楚：
 *   1. 宿主交给插件的 manifest 里，net.domains 到底有没有值；
 *   2. 插件自己经 pi.net.fetch 打本机服务，报的是「没声明域名」还是「域名不匹配」。
 * 两种情况对应完全不同的修法，不靠猜。
 */
async function diagnoseEgress(origin, logger) {
  const result = { origin, manifestNet: null, manifestPermissions: null, fetchOk: null, fetchError: null };
  try {
    const manifest = typeof pi.plugin.getManifest === 'function' ? await pi.plugin.getManifest() : null;
    result.manifestNet = manifest?.net ?? null;
    result.manifestPermissions = manifest?.permissions ?? null;
  } catch (error) {
    result.manifestNet = { error: String(error?.message ?? error) };
  }
  try {
    const response = await pi.net.fetch({ url: `${origin}/bot`, timeoutMs: 8000 });
    const status = typeof response === 'object' && response ? response.status : undefined;
    result.fetchOk = status === undefined ? true : status === 200;
    if (!result.fetchOk) result.fetchError = `status=${status}`;
  } catch (error) {
    result.fetchOk = false;
    result.fetchError = String(error?.code ? `${error.code}: ${error.message}` : (error?.message ?? error));
  }
  lastDiagnostics = result;
  logger.info('pi.bot.egress.diagnose', result);
  return result;
}

module.exports = {
  async onLoad() {
    // 只注册入口，不启动任何服务：宿主把插件 load 起来的那一刻到这里为止。
    // 独立窗口（1180×780）走这里，工作面板里的停靠视图由 contributes.views 提供。
    await pi.commands.register({
      id: COMMAND_ID,
      title: 'MiniMax Bot: 打开独立窗口',
      keywords: ['bot', '团队', 'minimax', '机器人'],
      category: 'Bot',
      run: () => pi.ui.openPanel(),
    });
    console.log('[pi.bot] 插件已加载（Bot 服务待首次打开时启动）');
  },

  async onUnload() {
    try { await pi.commands.unregister(COMMAND_ID); } catch { /* 宿主卸载时可能已注销 */ }
    await disposeRuntime();
  },

  async onPanelInvoke(channel, payload) {
    // ---- 快路径：这三条不拉起服务，只回答状态或调整计时 ----
    if (channel === 'pibot.touch') {
      touch();
      return { ok: true, running: Boolean(runtime), idleTimeoutMs: IDLE_TIMEOUT_MS };
    }
    if (channel === 'pibot.release') {
      // 页面卸载时喊一声。注意这里不调 touch()——它会把 releasedAt 清零，
      // 宽限期就永远够不着了。只记下时刻，让回收器 5 秒后确认没人接手。
      releasedAt = Date.now();
      armReaper(RELEASE_GRACE_MS);
      return { ok: true, graceMs: RELEASE_GRACE_MS, running: Boolean(runtime) };
    }
    if (channel === 'pibot.idle') {
      return {
        running: Boolean(runtime),
        idleForMs: lastSeen ? Date.now() - lastSeen : null,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        reaps: reapCount,
      };
    }

    const host = await ensureRuntime();

    if (channel === 'pibot.origin') {
      // 进程活着不等于端口能应答。面板拿到地址就会立刻挂一个 iframe 上去，
      // 而 iframe 加载失败在网页侧是看不出来的（Chromium 照样触发 load），
      // 结果就是「一片空白」。所以这里替面板先探一次，把话说在前面。
      const probe = await pi.net
        .fetch({ url: `${host.origin}/bot`, timeoutMs: 5000 })
        .catch((error) => ({ __error: error }));
      const status = probe && typeof probe === 'object' ? probe.status : undefined;
      if (probe?.__error || (typeof status === 'number' && status >= 400)) {
        const reason = probe?.__error
          ? String(probe.__error?.message ?? probe.__error)
          : `HTTP ${status}`;
        throw new Error(`Bot 服务端口没有应答（${host.origin}）：${reason}`);
      }
      return { origin: host.origin, port: host.port, mode: host.agent.mode };
    }
    if (channel === 'pibot.diagnose') {
      // 面板白屏时用来把真实原因显示出来，而不是留一张白纸。
      const diagnostics = lastDiagnostics ?? (await diagnoseEgress(host.origin, { info: () => {} }));
      return { ...diagnostics, mode: host.agent.mode, port: host.port };
    }
    if (channel === 'pibot.ensurePolicy') {
      // 兼容旧宿主的兜底：早期版本的 ipc/plugin-ui-ipc.ts 构造面板请求时没有
      // 带上 manifest.net.domains，面板 session 白名单为空，连 http://127.0.0.1
      // 都被当成越权出站拦掉，表现就是白屏。宿主 open() 遇到已存在的窗口会用
      // 新参数重新应用策略，所以再调一次 pi.ui.openPanel() 就能补上。
      //
      // 该宿主缺陷已在源码中修复（netDomains / netAnyHost / allowMicrophone
      // 三个字段补齐），所以这条路径对当前源码宿主是多余的；保留是为了让插件
      // 跑在尚未更新的打包版宿主上也不白屏。
      //
      // 停靠视图不走这条路：视图由 pluginViewOpen 创建，宿主一直按 manifest
      // 正确下发策略。在视图里调 openPanel() 会平白多弹一个窗口，所以跳过。
      const surface = String(payload?.surface ?? '');
      if (surface === 'view' || surface === 'widget') {
        return { ok: false, skipped: true, reason: 'docked surface: policy applied by host' };
      }
      await pi.ui.openPanel();
      return { ok: true };
    }
    if (channel === 'pibot.openWindow') {
      // 停靠视图里的「弹出独立窗口」。已经开着的窗口只会被重新应用策略。
      await pi.ui.openPanel();
      return { ok: true };
    }
    if (channel === 'pibot.openExternal') {
      // 兜底通道：面板被宿主出站策略拦住时，至少能一键在系统浏览器里打开同一套 UI。
      const url = `${host.origin}/bot`;
      await pi.shell.openExternal(url);
      return { url, opened: true };
    }
    if (channel === 'pibot.status') {
      const mode = host.agent.mode;
      const tools = mode === 'native'
        ? ['session/create', 'agent/prompt', 'subscribeAgentEvents', 'agent/getStatus', 'session/get', '宿主 Agent 全套工具（含 shell）']
        : mode === 'loop'
          ? ['read_text', 'write_text', 'list_dir', 'glob', 'fetch', 'bot_tool']
          : [];
      return {
        origin: host.origin, mode, running: true, tools,
        capabilities: host.agent.capabilities ?? null,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        reaps: reapCount,
      };
    }
    throw new Error(`未知的面板操作: ${channel}`);
  },
};
