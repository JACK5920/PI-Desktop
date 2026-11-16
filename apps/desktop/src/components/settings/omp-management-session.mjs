/** Coordinate short-lived OMP settings RPC work across quick tab switches. */
export function createOmpManagementSession({ attach, stop }) {
  let activeOperations = 0;
  let attachPromise = null;
  let stopPromise = null;

  async function ensureAttached() {
    if (!attachPromise) {
      const pending = Promise.resolve().then(attach);
      attachPromise = pending;
      pending.catch(() => {
        if (attachPromise === pending) attachPromise = null;
      });
    }
    await attachPromise;
  }

  async function run(operation) {
    // A previous panel instance may still be shutting down after it was
    // unmounted. Never attach a new view to that session until stop settles.
    while (stopPromise) await stopPromise;
    activeOperations += 1;
    try {
      await ensureAttached();
      return await operation();
    } finally {
      activeOperations -= 1;
      if (activeOperations === 0) {
        const closing = Promise.resolve().then(stop).catch(() => undefined).then(() => {
          attachPromise = null;
        });
        stopPromise = closing;
        try {
          await closing;
        } finally {
          if (stopPromise === closing) stopPromise = null;
        }
      }
    }
  }

  return { run };
}
