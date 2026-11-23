// L3 native：用 PI-Desktop 的 desktop.control 官方通道跑「完整 Agent 回合」。
// 链路：session/create（每 Bot 一个独立 durable session）→ subscribeAgentEvents →
//       agent/prompt（带 bash/edit/write/MCP 全套工具的真实回合）→ desktop:turnEnded → session/get 兜底。
// 比 agent.extension 更优：不需要高风险授权、不上架禁用、天然对齐原版「每 Bot 独立会话」。
// 对外仍实现 MiniAppAgentClient（run/answer/reply/models）+ 原版事件流，engine.mjs 零改动。

import { randomBytes } from 'node:crypto';
import { createSessionQueue } from './session-queue.mjs';

// 主对话没有「两分钟就掐」这回事：一个回合跑多久由宿主的模型与工具决定。
// 这里只设一个兜底上限，防止回合永远不收口（真正收口靠 desktop:turnEnded /
// agent/getStatus 轮询）。原本 120s 会让稍长的任务中途断掉 —— 而超时只是停止
// 等待，宿主那边的回合还在跑，用户看到的却是「结束了但没内容」。
const TURN_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 400;
const MAX_TRANSCRIPT_CHARS = 20_000;
const REQUIRED_OPERATIONS = ['session/create', 'agent/prompt', 'agent/getStatus', 'session/get'];

const clip = (value, max = MAX_TRANSCRIPT_CHARS) => String(value ?? '').slice(0, max);

function bridgeError(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function abortError() {
  return Object.assign(new Error('请求已取消'), { code: 'REQUEST_CANCELLED', retryable: false });
}

// UiMessage 的正文在不同版本里可能是字符串、内容块数组或 text 字段，全部兼容。
function textOfMessage(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && (part.type === 'text' || part.type === 'output_text'))
      .map((part) => String(part.text ?? ''))
      .join('');
  }
  if (typeof message.text === 'string') return message.text;
  return '';
}

function emit(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try { onEvent(event); } catch { /* 页面事件通道关闭不能拖垮回合 */ }
}

function isIdleStatus(status) {
  if (!status) return false;
  const state = String(status.state ?? status.status ?? status.phase ?? '').toLowerCase();
  return ['idle', 'completed', 'done', 'finished', 'ready'].includes(state) || status.running === false || status.busy === false;
}

export function createNativeAgentBridge({ pi, logger }) {
  const queue = createSessionQueue();
  const botToHost = new Map();      // 原插件 sessionId → PI-Desktop durable session id
  const subscriptions = new Map();  // host sessionId → subscriptionId
  const active = new Map();         // host sessionId → 当前回合
  let capabilities = { supported: false, operations: [], events: false };
  let installed = false;

  async function probe() {
    try {
      const listed = typeof pi?.desktop?.listOperations === 'function' ? await pi.desktop.listOperations() : [];
      const ids = new Set((Array.isArray(listed) ? listed : []).map((item) => String(item?.id ?? '')));
      const missing = REQUIRED_OPERATIONS.filter((id) => !ids.has(id));
      capabilities = {
        supported: missing.length === 0,
        missing,
        operations: [...ids],
        events: typeof pi?.desktop?.subscribeAgentEvents === 'function' && typeof pi?.events?.on === 'function',
        // 引擎按 has('agent.run') 决定排队；native 桥实现了会话级串行队列。
        has: (name) => name === 'agent.run',
      };
      if (!capabilities.supported) {
        logger.warn('pi.bot.native.unsupported', { missing });
      }
    } catch (error) {
      capabilities = {
        supported: false,
        missing: REQUIRED_OPERATIONS,
        operations: [],
        events: false,
        has: (name) => name === 'agent.run',
      };
      logger.warn('pi.bot.native.probe.failed', { message: String(error?.message ?? error) });
    }
    return capabilities;
  }

  function onAgentEvent(payload) {
    const hostSessionId = String(payload?.sessionId ?? '');
    const turn = active.get(hostSessionId);
    if (!turn) return;
    const event = payload?.event ?? payload;
    if (!event || typeof event.type !== 'string') return;
    switch (event.type) {
      case 'turn_start':
        if (!turn.hostStarted) {
          turn.hostStarted = true;
          emit(turn.onEvent, { type: 'turn.started', sessionId: turn.botSessionId, turnId: turn.turnId });
        }
        break;
      case 'message_update': {
        if (typeof event.deltaText === 'string' && event.deltaText) {
          turn.text += event.deltaText;
          emit(turn.onEvent, { type: 'text.delta', sessionId: turn.botSessionId, turnId: turn.turnId, text: event.deltaText });
          break;
        }
        // 非 delta 帧是快照替换，必须整体覆盖而不是追加，否则回复会重复成两遍。
        if (event.stream !== 'delta') {
          const snapshot = textOfMessage(event.message);
          if (snapshot && snapshot !== turn.text) turn.text = snapshot;
        }
        break;
      }
      case 'message_end': {
        const final = textOfMessage(event.message);
        if (final) turn.text = final;
        emit(turn.onEvent, { type: 'message.committed', sessionId: turn.botSessionId, turnId: turn.turnId, text: turn.text });
        break;
      }
      case 'tool_start': {
        const name = String(event.toolName ?? 'tool');
        // tool_end 只带 toolCallId，名字得自己按 id 存下来才能和 started 对上。
        if (event.toolCallId) turn.toolNames.set(String(event.toolCallId), name);
        emit(turn.onEvent, { type: 'tool.started', sessionId: turn.botSessionId, turnId: turn.turnId, name });
        break;
      }
      case 'tool_end': {
        const name = turn.toolNames.get(String(event.toolCallId ?? '')) ?? String(event.toolName ?? 'tool');
        emit(turn.onEvent, {
          type: 'tool.finished', sessionId: turn.botSessionId, turnId: turn.turnId,
          name, ok: event.isError !== true,
        });
        break;
      }
      case 'tool_permission_request': {
        const request = event.request ?? {};
        emit(turn.onEvent, {
          type: 'permission.requested', sessionId: turn.botSessionId, turnId: turn.turnId,
          requestId: String(request.requestId ?? request.id ?? randomBytes(6).toString('hex')),
          toolName: String(request.toolName ?? request.name ?? 'tool'),
          toolInput: clip(request.args ?? request.input ?? '', 1500),
          reason: String(request.reason ?? '需要你允许一次工具调用'),
        });
        break;
      }
      case 'error':
        turn.error = String(event.error?.message ?? event.error ?? 'Agent 回合出错');
        break;
      default:
        break;
    }
  }

  function onTurnEnded(payload) {
    const hostSessionId = String(payload?.sessionId ?? '');
    const turn = active.get(hostSessionId);
    if (!turn) return;
    // unknown 不是失败确认：规范明确它可能已经跑完了，所以只用兜底读 transcript，不重放。
    turn.endedReason = String(payload?.reason ?? 'unknown');
    turn.persisted = payload?.persisted === true;
    settle(hostSessionId);
  }

  function settle(hostSessionId) {
    const turn = active.get(hostSessionId);
    if (!turn || turn.settling) return;
    turn.settling = true;
    clearTimeout(turn.timer);
    if (turn.pollTimer) clearInterval(turn.pollTimer);
    turn.resolve();
  }

  function installEvents() {
    if (installed || typeof pi?.events?.on !== 'function') return;
    installed = true;
    pi.events.on('desktop:agentEvent', onAgentEvent);
    pi.events.on('desktop:turnEnded', onTurnEnded);
  }

  async function ensureHostSession(botSessionId, label) {
    const cached = botToHost.get(botSessionId);
    if (cached) return cached;
    const result = await pi.desktop.invoke({
      operation: 'session/create',
      args: [{ title: `MiniMax Bot · ${clip(label || 'Bot', 60)}`, mode: 'agent' }],
    });
    const id = result?.session?.id ?? result?.id ?? result?.sessionId;
    if (typeof id !== 'string' || !id.trim()) {
      throw bridgeError('AGENT_UNAVAILABLE', 'session/create 没有返回会话 id', false);
    }
    botToHost.set(botSessionId, id);
    return id;
  }

  async function subscribe(hostSessionId) {
    if (!capabilities.events || subscriptions.has(hostSessionId)) return;
    try {
      const result = await pi.desktop.subscribeAgentEvents({ sessionId: hostSessionId });
      if (result?.subscriptionId) subscriptions.set(hostSessionId, result.subscriptionId);
    } catch (error) {
      // 订阅失败不致命：轮询 agent/getStatus 仍能收口，只是失去逐字流式。
      logger.warn('pi.bot.native.subscribe.failed', { message: String(error?.message ?? error) });
      capabilities.events = false;
    }
  }

  async function readTranscript(hostSessionId) {
    try {
      const result = await pi.desktop.invoke({
        operation: 'session/get',
        args: [{ id: hostSessionId, messageLimit: 8, contentLimit: MAX_TRANSCRIPT_CHARS }],
      });
      const messages = result?.messages ?? result?.session?.messages ?? result?.transcript ?? [];
      if (!Array.isArray(messages)) return '';
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'assistant') {
          const text = textOfMessage(messages[i]);
          if (text.trim()) return text.trim();
        }
      }
    } catch (error) {
      logger.warn('pi.bot.native.transcript.failed', { message: String(error?.message ?? error) });
    }
    return '';
  }

  async function runTurn({ text, sessionId: requestedId, signal, onEvent, label = '' }) {
    if (!capabilities.supported) {
      throw bridgeError('AGENT_UNAVAILABLE', `宿主缺少 native 所需操作: ${capabilities.missing?.join(', ')}`, false);
    }
    if (signal?.aborted) throw abortError();
    const botSessionId = requestedId || `mvs_${randomBytes(12).toString('hex')}`;
    const turnId = `turn_${randomBytes(8).toString('hex')}`;
    const prompt = String(text ?? '').trim();
    if (!prompt) {
      emit(onEvent, { type: 'turn.started', sessionId: botSessionId, turnId });
      emit(onEvent, { type: 'turn.finished', sessionId: botSessionId, turnId, status: 'finished', text: '' });
      return { sessionId: botSessionId, turnId, status: 'finished', text: '' };
    }

    const hostSessionId = await ensureHostSession(botSessionId, label);
    await subscribe(hostSessionId);
    installEvents();

    // 同一 host 会话串行；原插件已按 chatId+botId 串行化，这里再兜一层防重入。
    if (active.has(hostSessionId)) {
      throw bridgeError('BUSY', '该 Bot 的 Agent 会话正在执行上一回合', true);
    }

    try {
      const done = new Promise((resolve) => {
        active.set(hostSessionId, {
          botSessionId, turnId, onEvent, text: '', error: '', signal,
          hostStarted: false, settling: false, resolve, toolNames: new Map(),
          endedReason: '', persisted: false,
        });
      });
      const turn = active.get(hostSessionId);
      emit(onEvent, { type: 'turn.started', sessionId: botSessionId, turnId });
      turn.hostStarted = true;

      turn.timer = setTimeout(() => settle(hostSessionId), TURN_TIMEOUT_MS);
      turn.pollTimer = setInterval(() => {
        void (async () => {
          try {
            const status = await pi.desktop.invoke({ operation: 'agent/getStatus', args: [hostSessionId] });
            if (isIdleStatus(status) && turn.hostStarted) settle(hostSessionId);
          } catch { /* 宿主忙时忽略，超时与 turnEnded 会收口 */ }
        })();
      }, POLL_INTERVAL_MS);

      const onAbort = () => {
        void pi.desktop.invoke({ operation: 'agent/abort', args: [{ sessionId: hostSessionId }] }).catch(() => {});
        settle(hostSessionId);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        await pi.desktop.invoke({
          operation: 'agent/prompt',
          args: [{ sessionId: hostSessionId, content: clip(prompt, 100_000) }],
        });
      } catch (error) {
        settle(hostSessionId);
        throw bridgeError('AGENT_UNAVAILABLE', `agent/prompt 失败: ${String(error?.message ?? error)}`, true);
      }

      await done;
      signal?.removeEventListener('abort', onAbort);
      const aborted = signal?.aborted || turn.endedReason === 'aborted';
      const errored = turn.endedReason === 'error' || Boolean(turn.error);

      let finalText = turn.text.trim();
      if (!finalText && !aborted) finalText = await readTranscript(hostSessionId);
      if (finalText) {
        emit(onEvent, { type: 'message.committed', sessionId: botSessionId, turnId, text: finalText });
      }

      const status = aborted ? 'aborted' : errored ? 'error' : 'finished';
      emit(onEvent, {
        type: 'turn.finished', sessionId: botSessionId, turnId, status,
        ...(status === 'finished' ? { text: finalText } : {}),
        ...(status === 'error' ? { error: { code: 'AGENT_UNAVAILABLE', message: turn.error || 'Agent 回合失败' } } : {}),
      });

      if (status === 'error') throw bridgeError('AGENT_UNAVAILABLE', turn.error || 'Agent 回合失败', true);
      return { sessionId: botSessionId, turnId, status, text: finalText };
    } finally {
      active.delete(hostSessionId);
    }
  }

  return {
    async run(input, options = {}) {
      const run = () => runTurn({
        text: input?.text,
        sessionId: input?.sessionId,
        signal: options.signal,
        onEvent: options.onEvent,
        label: input?.botName,
      });
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
      const answers = Array.isArray(input?.answers) ? input.answers : [];
      const text = answers.length
        ? `用户对提问的回答：\n${answers.map((a) => `- ${String(a.stepId ?? '')}: ${JSON.stringify(a.selectedOptionIds ?? [])} ${String(a.otherText ?? '')}`).join('\n')}`
        : '请继续。';
      return runTurn({ text, sessionId: input?.sessionId, signal: options.signal, onEvent: options.onEvent });
    },
    async reply() {
      // 权限/提问由执行侧宿主拥有；插件只观测，不替用户点「允许」。
      return undefined;
    },
    async models() {
      try {
        const rows = typeof pi?.models?.list === 'function' ? await pi.models.list() : [];
        const models = (Array.isArray(rows) ? rows : []).map((row) => ({
          providerId: row.providerId, modelId: row.modelId,
          label: row.label ?? row.modelId, name: row.label ?? row.modelId,
          variants: row.supportsReasoning ? ['', 'thinking'] : [''],
          thinking: { efforts: Array.isArray(row.thinkingLevels) ? row.thinkingLevels : [] },
        }));
        const def = (Array.isArray(rows) ? rows : []).find((row) => row.isDefault) ?? rows[0];
        return { models, default: def ? { providerId: def.providerId, modelId: def.modelId } : undefined };
      } catch {
        return { models: [], default: undefined };
      }
    },
    get mode() { return 'native'; },
    get capabilities() { return capabilities; },
    probe,
    dispose() {
      for (const [hostSessionId, subscriptionId] of subscriptions) {
        if (typeof pi?.desktop?.unsubscribeAgentEvents === 'function') {
          void Promise.resolve(pi.desktop.unsubscribeAgentEvents({ subscriptionId })).catch(() => {});
        }
        active.delete(hostSessionId);
      }
      subscriptions.clear();
      if (installed && typeof pi?.events?.off === 'function') {
        pi.events.off('desktop:agentEvent', onAgentEvent);
        pi.events.off('desktop:turnEnded', onTurnEnded);
      }
      installed = false;
    },
  };
}
