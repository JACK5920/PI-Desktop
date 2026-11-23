// 同一个 Bot 会话的串行队列。
//
// 0.7.31 的契约（miniapp-api.ts）：宿主声明 capabilities.has('agent.run') 后，引擎在
// Bot 正忙时会带 whenBusy:'queue' 再次调用 run()，并监听 run.queued(sessionId, position)
// 作为"已排队"的回执；排队超过 10 分钟由引擎自己 abort。
// 没有它，同一个人同时在私聊和群里 @ 同一个 Bot 就会拿到 BUSY，消息直接丢。

function cancelled() {
  return Object.assign(new Error('请求已取消'), { code: 'REQUEST_CANCELLED', retryable: false });
}

export function createSessionQueue() {
  /** sessionId -> { waiters: Waiter[] }，键存在即表示该会话正被占用 */
  const slots = new Map();

  function release(key) {
    const slot = slots.get(key);
    if (!slot) return;
    const next = slot.waiters.shift();
    if (!next) {
      slots.delete(key);
      return;
    }
    next.cleanup();
    next.resolve();
  }

  /**
   * 拿到槽位或排队。
   * @returns {{ position: number, queued?: Promise<void>, release: () => void }}
   *   queued 为空表示立刻拿到；否则等它 resolve 才轮到本次运行，abort 时 reject。
   */
  function acquire(key, signal) {
    if (!key) return { position: 0, release: () => {} };
    const slot = slots.get(key);
    if (!slot) {
      slots.set(key, { waiters: [] });
      return { position: 0, release: () => release(key) };
    }
    if (signal?.aborted) {
      // 还没排队就被取消：不占位、不注册监听。
      return { position: 0, queued: Promise.reject(cancelled()), release: () => {} };
    }
    const waiter = {};
    const queued = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    const onAbort = () => {
      const at = slot.waiters.indexOf(waiter);
      if (at !== -1) slot.waiters.splice(at, 1);
      waiter.reject(cancelled());
    };
    waiter.cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    slot.waiters.push(waiter);
    return {
      position: slot.waiters.length,
      queued,
      release: () => {
        waiter.cleanup();
        release(key);
      },
    };
  }

  return { acquire, release };
}
