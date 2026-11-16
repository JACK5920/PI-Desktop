import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  hasOmpTodoSnapshot,
  mergeOmpTodoMetadata,
  normalizeEditableOmpTodos,
  sameOmpTodoCore,
  updateEditableOmpTodoTask,
} from "../src/components/omp-todo-edit.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function node(entry, children = []) { return { entry, children }; }

test("OMP exposes its own goal lifecycle and preserves native todo fields through its session journal", async () => {
  const controls = await read("../src/components/OmpNativeControls.tsx");
  const ipc = await read("../electron/main/ipc/register.ts");
  const en = await read("../../../packages/i18n/src/locales/en/index.ts");
  const zh = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");
  assert.match(ipc, /"goal", "set_todos"/);
  assert.match(controls, /command: "get_state"/);
  assert.match(controls, /command: "get_tree"/);
  assert.match(controls, /command: "goal", fields: \{[\s\S]*?op,[\s\S]*?token_budget/);
  assert.match(controls, /goal_updated/);
  assert.match(controls, /todoHistoryLoaded/);
  assert.match(controls, /hasOmpTodoSnapshot\(/);
  assert.match(controls, /command: "set_todos"/);
  assert.match(controls, /sameOmpTodoCore\(phases, saved\)/);
  assert.match(controls, /todoTaskDetails/);
  assert.match(controls, /todoTaskNotes/);
  assert.match(controls, /omp-native-tasks-panel/);
  assert.match(controls, /goalStatusBudgetLimited/);
  for (const key of ["nativeTasks", "nativeGoal", "createNativeGoal", "pauseNativeGoal", "resumeNativeGoal", "dropNativeGoal", "nativeTodos", "goalStatusActive", "todoTaskDetails", "todoTaskNotes", "nativeTodosPersistenceUnverified"]) {
    assert.match(en, new RegExp(`${key}:`));
    assert.match(zh, new RegExp(`${key}:`));
  }
});

test("editing a todo keeps details, notes, and unknown OMP extension fields intact", () => {
  const original = [{
    name: "Build",
    phaseExtension: { owner: "agent" },
    tasks: [{
      content: "Write regression test",
      status: "pending",
      details: "Keep the OMP-native metadata",
      notes: ["first note", "second note"],
      extension: { source: "omp" },
    }],
  }];
  assert.deepEqual(normalizeEditableOmpTodos(original), original);
  const updated = updateEditableOmpTodoTask(original, 0, 0, {
    content: "Add regression test",
    status: "completed",
    details: "New details",
    notes: "new note\nsecond new note",
  });
  assert.deepEqual(updated, [{
    name: "Build",
    phaseExtension: { owner: "agent" },
    tasks: [{
      content: "Add regression test",
      status: "completed",
      details: "New details",
      notes: ["new note", "second new note"],
      extension: { source: "omp" },
    }],
  }]);
  assert.deepEqual(original[0].tasks[0].notes, ["first note", "second note"], "edit preparation must not mutate the native snapshot");
  const cleared = updateEditableOmpTodoTask(original, 0, 0, { details: "", notes: "" });
  assert.equal(Object.hasOwn(cleared[0].tasks[0], "details"), false);
  assert.equal(Object.hasOwn(cleared[0].tasks[0], "notes"), false);
  assert.equal(sameOmpTodoCore(updated, [{ name: "Build", tasks: [{ content: "Add regression test", status: "completed" }] }]), true);
  assert.equal(normalizeEditableOmpTodos([{ name: "Build", tasks: [{ content: "", status: "invalid" }] }]), null);
});

test("extended todos are restored only from the selected OMP branch's durable entries", () => {
  const activePhases = [{ name: "Build", tasks: [{ content: "Ship safely", status: "in_progress" }] }];
  const activeRaw = [{ name: "Build", tasks: [{ content: "Ship safely", status: "pending", details: "Active-branch detail", notes: ["kept"], custom: "OMP" }] }];
  const tree = [
    node({ id: "root", parentId: null, type: "header" }, [
      node({ id: "inactive", parentId: "root", type: "custom", customType: "user_todo_edit", data: { phases: [{ name: "Old", tasks: [{ content: "Other branch", status: "pending", details: "must not leak" }] }] } }),
      node({ id: "active-edit", parentId: "root", type: "custom", customType: "user_todo_edit", data: { phases: activeRaw } }, [
        node({ id: "active-leaf", parentId: "active-edit", type: "message" }),
      ]),
    ]),
  ];
  const merged = mergeOmpTodoMetadata(activePhases, tree, "active-leaf");
  assert.deepEqual(merged, [{
    name: "Build",
    tasks: [{ content: "Ship safely", status: "in_progress", details: "Active-branch detail", notes: ["kept"], custom: "OMP" }],
  }]);
  assert.equal(hasOmpTodoSnapshot(tree, "active-leaf", activeRaw), true);
  assert.equal(hasOmpTodoSnapshot(tree, "inactive", activeRaw), false);
  assert.equal(mergeOmpTodoMetadata(activePhases, tree, "unknown-leaf"), null);
});

test("OMP-native todo journal verification rejects mismatched snapshots and malformed trees", () => {
  const phases = [{ name: "Verify", tasks: [{ content: "Persist exact fields", status: "pending", details: "durable" }] }];
  const tree = [node({ id: "entry", parentId: null, type: "custom", customType: "user_todo_edit", data: { phases } })];
  assert.equal(hasOmpTodoSnapshot(tree, "entry", phases), true);
  assert.equal(hasOmpTodoSnapshot(tree, "entry", [{ name: "Verify", tasks: [{ content: "Persist exact fields", status: "pending", details: "lost" }] }]), false);
  assert.equal(mergeOmpTodoMetadata(phases, [], "missing"), null);
  assert.equal(normalizeEditableOmpTodos([{ name: "Huge", tasks: [{ content: "x", status: "pending", notes: ["n".repeat(1_100_000)] }] }]), null);
});

test("a newer native todo edit that clears metadata does not resurrect an older value", () => {
  const tree = [node({ id: "root", parentId: null, type: "header" }, [
    node({ id: "with-detail", parentId: "root", type: "custom", customType: "user_todo_edit", data: { phases: [{ name: "Plan", tasks: [{ content: "Ship", status: "pending", details: "old detail", notes: ["old note"] }] }] } }, [
      node({ id: "cleared", parentId: "with-detail", type: "custom", customType: "user_todo_edit", data: { phases: [{ name: "Plan", tasks: [{ content: "Ship", status: "in_progress" }] }] } }, [
        node({ id: "leaf", parentId: "cleared", type: "message" }),
      ]),
    ]),
  ])];
  const merged = mergeOmpTodoMetadata([{ name: "Plan", tasks: [{ content: "Ship", status: "in_progress" }] }], tree, "leaf");
  assert.deepEqual(merged, [{ name: "Plan", tasks: [{ content: "Ship", status: "in_progress" }] }]);
});
