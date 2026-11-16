import test from "node:test";
import assert from "node:assert/strict";
import { createOmpManagementSession } from "../src/components/settings/omp-management-session.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("OMP settings management shares concurrent attach and stops only after all work settles", async () => {
  let attaches = 0;
  let stops = 0;
  const operationGate = deferred();
  const session = createOmpManagementSession({
    attach: async () => { attaches += 1; },
    stop: async () => { stops += 1; },
  });

  const first = session.run(() => operationGate.promise);
  const second = session.run(async () => "second");
  await second;
  assert.equal(attaches, 1, "overlapping operations share one management process");
  assert.equal(stops, 0, "the first operation still owns the management session");
  operationGate.resolve("first");
  assert.equal(await first, "first");
  assert.equal(stops, 1, "the process stops after the last operation finishes");
});

test("a new OMP settings tab waits for an in-progress stop before reattaching", async () => {
  let attaches = 0;
  let stops = 0;
  const stopGate = deferred();
  const firstStopStarted = deferred();
  const session = createOmpManagementSession({
    attach: async () => { attaches += 1; },
    stop: async () => {
      stops += 1;
      if (stops === 1) {
        firstStopStarted.resolve();
        await stopGate.promise;
      }
    },
  });

  const stoppingOperation = session.run(async () => undefined);
  await firstStopStarted.promise;
  let thirdOperationStarted = false;
  const returningTab = session.run(async () => { thirdOperationStarted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdOperationStarted, false, "the returning tab does not attach to a process being closed");
  assert.equal(attaches, 1);

  stopGate.resolve();
  await Promise.all([stoppingOperation, returningTab]);
  assert.equal(thirdOperationStarted, true);
  assert.equal(attaches, 2, "a clean process is attached after shutdown completes");
  assert.equal(stops, 2);
});
