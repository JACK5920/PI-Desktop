// PI-Desktop ⇄ MiniMax Bot 的 Agent 桥：把宿主有限的一次性补全包装成原 MiniAppAgentClient。
// L1 complete：一次补全换一次回复；L2 loop：本地 Agent 循环，工具走受控 pi.* 网关。
// 原插件 engine.mjs 只认 run/answer/reply/models 与那套事件流，所以这里负责合成，engine 一行不改。

import { randomBytes } from 'node:crypto';
import { createSessionQueue } from './session-queue.mjs';

// 官方宿主（MiniMax）给的是一整个 Agent 回合：原生函数调用、步数不设上限、
// MCP 工具直接进工具表。PI-Desktop 的插件 API 只给一次性补全（pi.agent.complete），
// 所以这里只能自己实现 ReAct 循环。为了别比原版差太远，配额尽量贴住宿主硬限：
//   · MAX_STEPS 4 → 12：原版没有步数概念，4 步连「建 Bot → 拉进群」都磕磕绊绊
//   · RATE_LIMIT 6 → 8：宿主硬限就是 8 次/60 秒，自己再压 6 是白让两格
//   · 等待上限 60s → 180s：长任务排队时别把回合掐断（等到了照常继续）
//   · RATE_LIMIT 6 → 7：宿主硬限 8 次/60 秒，但它按自己的窗口计数，我们压到 8
//     会卡在窗口边界上被宿主拒（拒了整轮直接报 BUSY），留一格余量最稳
const MAX_STEPS = 12;
const MAX_CALLS_PER_STEP = 8;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 120_000;
const MAX_TOOL_RESULT = 8000;
const MODEL_CACHE_MS = 60_000;
const RATE_LIMIT = 7;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_WAIT_MS = 180_000;
const DELTA_CHUNK = 240;

const TOOL_PROTOCOL = `你可以调用工具来完成任务，但工具的边界由宿主权限决定，不要尝试越界。

需要工具时，只输出一个 JSON 对象（不要写解释、不要套 Markdown 代码块）：
{"tool":"工具名","args":{...}}

不需要工具或已经拿到足够结果时，直接输出给用户的最终回复（纯文本，不要 JSON）。

可用工具：
- read_text  args {"path":"工作区相对路径"}  读取文本文件
- write_text args {"path":"工作区相对路径","text":"内容"}  写入文本文件
- list_dir   args {"path":"工作区相对路径"}  列目录
- glob       args {"pattern":"glob 表达式"}  按模式找文件
- fetch      args {"url":"https://..."}  抓取受白名单约束的网页
- bot_tool   args {"name":"工具名","arguments":{}}  调用 Bot 团队工具（list_team / create_bot / create_group / message_bot / dispatch_tasks / remember / recall / create_schedule / list_schedules 等）

bot_tool 可用工具名由 /mcp/minimax-bot 的 tools/list 给出。工具结果会以用户消息的形式回传给你，你可以接着调用工具或给出最终答复。

一次做多件事时，请把调用打包成一个数组，别拆成多轮（每轮都要重新叫一次模型，慢且容易半途而废）：
{"tool_calls":[{"tool":"create_bot","args":{...}},{"tool":"create_group","args":{...}}]}

几条硬规矩：
- create_group 必须带 members，至少一个**已存在**的 bot id，否则会报错；刚建的 Bot 的 id 就在上一步工具结果里，直接用。
- 不要编造 bot id；只能用团队名单里给的，或者工具刚返回的。
- 需要先知道结果才能决定下一步时，才分轮；其余情况一次打包。`;

/**
 * `complete` 模式（不解析也不执行工具）的系统提示。
 *
 * 绝不能在不能执行工具的模式里下发工具协议：模型照着协议吐出的调用没人解析，
 * 就会原样出现在对话里，用户看到的是一段 `{"tool":"bot_tool",...}` 源码。
 */
const CHAT_ONLY = `直接回答用户的问题，用自然语言。

硬性要求：不要输出 JSON、工具调用或函数调用，也不要输出看起来像代码的结构化数据。
你没有可用的工具；如果问题需要查询实时数据，就用已有信息回答，并说明这一点。`;

const TOOL_NAMES = new Set(['read_text', 'write_text', 'list_dir', 'glob', 'fetch', 'bot_tool']);

/** 工具调用 JSON 坏掉时，让模型重发一次（而不是把源码甩给用户）。 */
const REPAIR_PROMPT = `你上一条输出看起来是工具调用，但不是合法 JSON。常见原因：内容太长被截断、字符串里的引号或换行没转义、字段拼错。
请重新输出，且只输出一个合法的 JSON 对象，格式严格为 {"tool":"工具名","args":{...}}；不要解释、不要代码块、不要加前后缀。
如果内容太长，就把要写的内容缩短，或者先只做第一步。`;

const clip = (value, max = MAX_TOOL_RESULT) => String(value ?? '').slice(0, max);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  function onAbort() { clearTimeout(timer); reject(abortError()); }
  if (signal?.aborted) { clearTimeout(timer); reject(abortError()); return; }
  signal?.addEventListener('abort', onAbort, { once: true });
});

function abortError() {
  return Object.assign(new Error('请求已取消'), { code: 'REQUEST_CANCELLED', retryable: false });
}

function bridgeError(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function classify(error) {
  if (error?.code === 'REQUEST_CANCELLED') return error;
  const code = String(error?.code ?? '');
  const text = String(error?.message ?? error);
  if (/PROVIDER_UNAUTHORIZED|MODEL_NOT_CONFIGURED|UNAUTHORIZED/i.test(code + text)) {
    return bridgeError('AGENT_UNAVAILABLE', `模型未配置或鉴权失败：${text}`, false);
  }
  if (/CONTEXT_TOO_LARGE|INVALID_ARGUMENT/i.test(code + text)) {
    return bridgeError('INVALID_ARGUMENTS', `请求不被宿主接受：${text}`, false);
  }
  if (/RATE_LIMITED|RATE_LIMIT/i.test(code + text)) {
    return bridgeError('BUSY', `模型调用过于频繁：${text}`, true);
  }
  if (/TIMEOUT|NETWORK_ERROR|ECONN/i.test(code + text)) {
    return bridgeError('AGENT_UNAVAILABLE', `模型服务暂时不可用：${text}`, true);
  }
  return bridgeError('AGENT_UNAVAILABLE', text, true);
}

class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.times = [];
    this.chain = Promise.resolve();
  }

  // 串行化 acquire，否则多个 Bot 同时检查会一起越过 6 次/60 秒的宿主硬限。
  acquire(signal) {
    const next = this.chain.then(() => this.waitForSlot(signal));
    this.chain = next.catch(() => {});
    return next;
  }

  async waitForSlot(signal) {
    const deadline = Date.now() + MAX_RATE_WAIT_MS;
    for (;;) {
      const now = Date.now();
      this.times = this.times.filter((ts) => now - ts < this.windowMs);
      if (this.times.length < this.limit) {
        this.times.push(now);
        return;
      }
      if (signal?.aborted) throw abortError();
      if (now >= deadline) throw bridgeError('BUSY', '模型配额繁忙，请稍后重试', true);
      const wait = Math.min(this.windowMs - (now - this.times[0]) + 25, deadline - now);
      await sleep(Math.max(20, wait), signal);
    }
  }
}

/**
 * 从模型输出里抽工具调用。
 *
 * 真实事故（2026-11-13，用户报「让它创建一个群都做不到」）：
 * 模型要写一个 Markdown 文件，文件内容里自带代码块（```text 画目录树）。
 * 旧实现**先**用 /```/ 抽代码块，抽走的是内层那段目录树 —— 里面没有 { }，
 * 于是判定「这不是工具调用」，整段 `{"tool":"write_text",...}` 原样打在对话里，
 * 工具一次都没执行。
 *
 * 所以顺序必须是：**先拿原文解析**，代码块只当兜底（模型真把 JSON 包在
 * 代码块里、或正文里混了花括号时才用得上）。
 */
function toolCallCandidates(raw) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return fenced ? [raw, fenced[1].trim()] : [raw];
}

function normalizeCall(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.reply === 'string') return { reply: item.reply };
  // 兼容几种常见外壳：{tool,args} / {name,arguments} / {function:{name,arguments}}
  const fn = item.function && typeof item.function === 'object' ? item.function : null;
  const name = String((fn ? fn.name : item.tool) ?? item.name ?? '').trim();
  if (!name || !TOOL_NAMES.has(name)) return null;
  let args = (fn ? fn.arguments : item.args) ?? item.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = undefined; }
  }
  return { tool: name, args: args && typeof args === 'object' ? args : {} };
}

/**
 * 一次输出里可能是单个调用、一个数组，或 {tool_calls:[...]} 外壳。
 * 官方宿主是原生并行工具调用，这里把等价形态都吃下来 —— 一次打包多个调用，
 * 只消耗一轮模型调用，才有可能追平原版的手感。
 */
function parseToolCalls(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  for (const body of toolCallCandidates(raw)) {
    const objStart = body.indexOf('{');
    const arrStart = body.indexOf('[');
    const starts = [objStart, arrStart].filter((i) => i >= 0);
    if (!starts.length) continue;
    const start = Math.min(...starts);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (end <= start) continue;
    try {
      const parsed = JSON.parse(body.slice(start, end + 1));
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.tool_calls) ? parsed.tool_calls
          : Array.isArray(parsed?.calls) ? parsed.calls : [parsed];
      const calls = list.map(normalizeCall).filter(Boolean).slice(0, MAX_CALLS_PER_STEP);
      if (calls.length) return calls;
    } catch {
      // 这个候选坏了，换下一个。
    }
  }
  return [];
}

function parseToolCall(text) {
  return parseToolCalls(text)[0] ?? null;
}

/**
 * 「看着像工具调用，但结构是坏的」——被截断、引号/换行没转义、字段拼错。
 * 这种内容一旦当正文显示，用户看到的就是一坨源码，所以必须在出口拦住。
 */
function looksLikeToolCall(text) {
  const body = String(text ?? '');
  return /"tool"\s*:/.test(body) || /"tool_calls"\s*:/.test(body) || /"function_call"\s*:/.test(body);
}

function emit(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try { onEvent(event); } catch { /* 页面事件通道关闭不能拖垮回合 */ }
}

function emitText(onEvent, sessionId, turnId, text) {
  const body = String(text ?? '');
  for (let i = 0; i < body.length; i += DELTA_CHUNK) {
    emit(onEvent, { type: 'text.delta', sessionId, turnId, text: body.slice(i, i + DELTA_CHUNK) });
  }
  emit(onEvent, { type: 'message.committed', sessionId, turnId, text: body });
}

function trimHistory(messages) {
  let list = messages.slice(-MAX_HISTORY_MESSAGES);
  let size = list.reduce((n, m) => n + String(m.content).length, 0);
  while (list.length > 2 && size > MAX_HISTORY_CHARS) {
    size -= String(list[0].content).length;
    list = list.slice(1);
  }
  return list;
}

export function createAgentBridge({ pi, logger, mode = 'loop', origin = '', ownFetch }) {
  const limiter = new RateLimiter(RATE_LIMIT, RATE_WINDOW_MS);
  const queue = createSessionQueue();
  const sessions = new Map();
  let modelCache;
  const request = typeof ownFetch === 'function' ? ownFetch : (...args) => globalThis.fetch(...args);

  async function modelCatalog() {
    const now = Date.now();
    if (modelCache && now - modelCache.at < MODEL_CACHE_MS) return modelCache.value;
    let rows = [];
    try {
      rows = typeof pi?.models?.list === 'function' ? await pi.models.list() : [];
    } catch (error) {
      logger.warn('pi.bot.models.failed', { message: String(error?.message ?? error) });
      return { models: [], default: undefined };
    }
    const models = (Array.isArray(rows) ? rows : []).map((row) => ({
      providerId: row.providerId,
      modelId: row.modelId,
      label: row.label ?? row.modelId,
      name: row.label ?? row.modelId,
      variants: row.supportsReasoning ? ['', 'thinking'] : [''],
      thinking: { efforts: Array.isArray(row.thinkingLevels) ? row.thinkingLevels : [] },
    }));
    const preferred = (Array.isArray(rows) ? rows : []).find((row) => row.isDefault) ?? rows[0];
    const value = {
      models,
      default: preferred ? { providerId: preferred.providerId, modelId: preferred.modelId } : undefined,
    };
    modelCache = { at: now, value };
    return value;
  }

  async function resolveModelKey(requested) {
    let candidate = requested;
    if (typeof candidate === 'string') {
      const text = candidate.trim();
      if (text.includes('/')) return { modelKey: text, thinkingLevel: undefined };
      candidate = undefined;
    }
    if (candidate && typeof candidate === 'object') {
      const providerId = String(candidate.providerId ?? '').trim();
      const modelId = String(candidate.modelId ?? '').trim();
      if (providerId && modelId) {
        const level = candidate.thinking?.effort;
        return { modelKey: `${providerId}/${modelId}`, thinkingLevel: typeof level === 'string' ? level : undefined };
      }
    }
    const catalog = await modelCatalog();
    if (catalog.default) {
      return { modelKey: `${catalog.default.providerId}/${catalog.default.modelId}`, thinkingLevel: undefined };
    }
    throw bridgeError('AGENT_UNAVAILABLE', 'PI-Desktop 没有可用的模型配置，请先在设置里添加一个服务', false);
  }

  async function callModel({ system, messages, thinkingLevel, signal }) {
    await limiter.acquire(signal);
    if (signal?.aborted) throw abortError();
    const { modelKey } = await resolveModelKey(undefined);
    const result = await pi.agent.complete({
      modelKey,
      system: clip(system, 32_000),
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: clip(m.content, 100_000) })),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    if (!text) throw bridgeError('AGENT_UNAVAILABLE', '模型返回了空内容', true);
    return text;
  }

  async function mcpToolsList() {
    if (!origin) return [];
    try {
      const response = await request(`${origin}/mcp/minimax-bot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const body = await response.json();
      return Array.isArray(body?.result?.tools) ? body.result.tools.map((tool) => tool.name) : [];
    } catch (error) {
      logger.warn('pi.bot.mcp.list.failed', { message: String(error?.message ?? error) });
      return [];
    }
  }

  async function executeTool(name, args, onEvent, sessionId, turnId, signal) {
    emit(onEvent, { type: 'tool.started', sessionId, turnId, name });
    let ok = true;
    let value;
    try {
      if (signal?.aborted) throw abortError();
      switch (name) {
        case 'read_text':
          value = await pi.fs.readText(String(args.path ?? ''));
          break;
        case 'write_text':
          await pi.fs.writeText(String(args.path ?? ''), String(args.text ?? ''));
          value = '已写入';
          break;
        case 'list_dir':
          value = JSON.stringify(await pi.fs.list(String(args.path ?? '')));
          break;
        case 'glob':
          value = JSON.stringify(await pi.fs.glob(String(args.pattern ?? '')));
          break;
        case 'fetch': {
          const response = await pi.net.fetch({ url: String(args.url ?? ''), timeoutMs: 15_000 });
          value = typeof response === 'string' ? response : JSON.stringify(response);
          break;
        }
        case 'bot_tool': {
          if (!origin) throw new Error('内部 MCP 端点未就绪');
          const toolName = String(args.name ?? '');
          const known = await mcpToolsList();
          if (!known.includes(toolName)) throw new Error(`未知 Bot 工具 ${toolName}`);
          const response = await request(`${origin}/mcp/minimax-bot`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
              params: { name: toolName, arguments: args.arguments && typeof args.arguments === 'object' ? args.arguments : {} },
            }),
          });
          const body = await response.json();
          if (body?.error) throw new Error(String(body.error.message ?? 'MCP 调用失败'));
          if (body?.result?.isError) throw new Error(clip(body.result.content?.[0]?.text ?? '工具返回错误', 500));
          value = clip(body?.result?.content?.[0]?.text ?? '{}', MAX_TOOL_RESULT);
          break;
        }
        default:
          throw new Error(`不支持的工具 ${name}`);
      }
    } catch (error) {
      ok = false;
      value = `工具执行失败：${String(error?.message ?? error)}`;
      logger.warn('pi.bot.tool.failed', { name, message: value });
    }
    emit(onEvent, { type: 'tool.finished', sessionId, turnId, name, ok });
    return clip(value);
  }

  async function runTurn({ text, sessionId: requestedId, model, signal, onEvent, system, allowTools = mode === 'loop' }) {
    // 工具协议只在能执行工具的时候下发；否则模型输出的调用没人接，就成了正文。
    const systemPrompt = system ?? (allowTools ? TOOL_PROTOCOL : CHAT_ONLY);
    const sessionId = requestedId || `mvs_${randomBytes(12).toString('hex')}`;
    const turnId = `turn_${randomBytes(8).toString('hex')}`;
    const history = sessions.get(sessionId) ?? [];
    const input = String(text ?? '').trim();
    if (signal?.aborted) throw abortError();
    if (!input) {
      emit(onEvent, { type: 'turn.started', sessionId, turnId });
      emit(onEvent, { type: 'turn.finished', sessionId, turnId, status: 'finished', text: '' });
      return { sessionId, turnId, status: 'finished', text: '' };
    }

    emit(onEvent, { type: 'turn.started', sessionId, turnId });
    const scratch = [...history, { role: 'user', content: input }];
    let finalText = '';
    let lastError;
    try {
      const { thinkingLevel } = model && typeof model === 'object' ? { thinkingLevel: model.thinking?.effort } : { thinkingLevel: undefined };
      for (let step = 0; step < (allowTools ? MAX_STEPS : 1); step += 1) {
        if (signal?.aborted) throw abortError();
        const output = await callModel({ system: systemPrompt, messages: trimHistory(scratch), thinkingLevel, signal });
        const calls = parseToolCalls(output);
        // 结构坏了（截断、转义错、字段拼错）：这坨东西不能当答复显示给用户。
        // 还有步数就要它重发一次合法 JSON；没步数就交给下面的纯文本收口。
        if (!calls.length && looksLikeToolCall(output)) {
          if (allowTools && step + 1 < MAX_STEPS) {
            scratch.push({ role: 'user', content: REPAIR_PROMPT });
            continue;
          }
          break;
        }
        // 模型越界：当前模式没有工具，它却吐了个工具调用。既不能执行，更不能
        // 把这段 JSON 当答复显示 —— 丢掉它，交给下面的纯文本收口。
        if (calls.length && !allowTools) break;
        if (!calls.length) { finalText = output; break; }
        const replyCall = calls.find((call) => call.reply !== undefined);
        if (replyCall) { finalText = replyCall.reply; break; }
        // 一轮里打包的多个调用依次执行；结果合并成一条回传，省模型调用次数。
        const lines = [];
        for (const call of calls) {
          if (signal?.aborted) throw abortError();
          const result = await executeTool(call.tool, call.args, onEvent, sessionId, turnId, signal);
          lines.push(`工具 ${call.tool} 的结果：\n${result}`);
        }
        scratch.push({
          role: 'user',
          content: `${lines.join('\n\n')}\n\n请据此继续，或给出最终答复。工具报错就先修正参数重试一次，别原样重复同一个错误调用。`,
        });
      }
      // 步数用尽、或模型越界输出工具 JSON 时，再要一次纯文本收口，
      // 保证用户永远看不到工具调用的源码。
      if (!finalText) {
        finalText = await callModel({
          system: allowTools
            ? '根据上面的工具结果，直接给用户最终答复，不要再调用工具，不要输出 JSON。'
            : CHAT_ONLY,
          messages: trimHistory(scratch), thinkingLevel, signal,
        });
        // 收口还是 JSON（合法的越界调用，或者坏掉的结构），就只能如实说明，
        // 绝不能把源码摆给用户。
        if (looksLikeToolCall(finalText) || parseToolCall(finalText)) {
          finalText = allowTools
            ? '这次要调用的工具参数太长，模型生成到一半就断了，所以没执行成功。把要求拆小一点（比如先建一个文件）我再试。'
            : '这个请求需要调用工具才能完成，但当前是对话模式（complete），不支持工具调用。切换到 loop 模式后我再做。';
        }
      }
      sessions.set(sessionId, trimHistory([
        ...history,
        { role: 'user', content: input },
        { role: 'assistant', content: finalText },
      ]));
      emitText(onEvent, sessionId, turnId, finalText);
      emit(onEvent, { type: 'turn.finished', sessionId, turnId, status: 'finished', text: finalText });
      return { sessionId, turnId, status: 'finished', text: finalText };
    } catch (error) {
      lastError = error?.code === 'REQUEST_CANCELLED' ? error : classify(error);
      const status = lastError.code === 'REQUEST_CANCELLED' ? 'aborted' : 'error';
      emit(onEvent, {
        type: 'turn.finished', sessionId, turnId, status,
        ...(status === 'error' ? { error: { code: lastError.code, message: lastError.message } } : {}),
      });
      if (status === 'aborted') return { sessionId, turnId, status: 'aborted', text: '' };
      throw lastError;
    }
  }

  return {
    async run(input, options = {}) {
      const run = () => runTurn({
        text: input?.text,
        sessionId: input?.sessionId,
        model: input?.model,
        signal: options.signal,
        onEvent: options.onEvent,
      });
      // 引擎只在 capabilities.has('agent.run') 为真时才带 whenBusy；不支持就不改变旧行为。
      const sessionId = input?.sessionId;
      if (input?.whenBusy !== 'queue' || !sessionId) return run();
      const slot = queue.acquire(sessionId, options.signal);
      if (slot.queued) {
        emit(options.onEvent, { type: 'run.queued', sessionId, position: slot.position });
        await slot.queued;
      }
      try {
        return await run();
      } finally {
        slot.release();
      }
    },
    async answer(input, options = {}) {
      // 原插件的问卷在 PI-Desktop 没有对应宿主能力；把答案拼成一轮新的用户输入续跑同一会话。
      const answers = Array.isArray(input?.answers) ? input.answers : [];
      const text = answers.length
        ? `用户对上一步提问的回答：\n${answers.map((a) => `- ${String(a.stepId ?? '')}: ${JSON.stringify(a.selectedOptionIds ?? [])} ${String(a.otherText ?? '')}`).join('\n')}`
        : '请继续。';
      return runTurn({
        text,
        sessionId: input?.sessionId,
        signal: options.signal,
        onEvent: options.onEvent,
        allowTools: false,
        system: '根据对话历史继续回答用户，不要输出 JSON。',
      });
    },
    async reply() {
      // L1/L2 没有宿主级工具审批弹窗；权限已由 pi.fs.* / pi.net.fetch 的网关在工具执行时裁决。
      return undefined;
    },
    async models() { return modelCatalog(); },
    // 0.7.31 起引擎按能力表决定要不要排队；这里已实现串行队列，可以声明。
    capabilities: { has: (name) => name === 'agent.run' },
    get mode() { return mode; },
    get limiter() { return limiter; },
  };
}
