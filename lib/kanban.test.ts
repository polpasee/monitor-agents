import assert from "node:assert/strict";
import test from "node:test";

import {
  isKanbanStatus,
  kanbanRepositories,
  parseKanbanTaskPatch,
  type KanbanTask,
} from "./kanban.ts";

const tasks: KanbanTask[] = [
  {
    id: "task-1",
    title: "Add repository filter",
    description: "",
    repository: "monitor-agents",
    status: "todo",
    priority: 0,
    claimedBy: null,
    claimedAt: null,
    leaseUntil: null,
    result: null,
    lastError: null,
    attemptCount: 0,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  },
  {
    id: "task-2",
    title: "Review API",
    description: "",
    repository: "cacti-api",
    status: "review",
    priority: 0,
    claimedBy: null,
    claimedAt: null,
    leaseUntil: null,
    result: null,
    lastError: null,
    attemptCount: 0,
    createdAt: "2026-08-04T01:00:00.000Z",
    updatedAt: "2026-08-04T01:00:00.000Z",
  },
];

test("isKanbanStatus accepts only board states", () => {
  assert.equal(isKanbanStatus("in-progress"), true);
  assert.equal(isKanbanStatus("failed"), true);
  assert.equal(isKanbanStatus("unknown"), false);
});

test("parseKanbanTaskPatch preserves the exact status payload", () => {
  assert.deepEqual(parseKanbanTaskPatch({ status: "review" }), {
    status: "review",
  });
  assert.equal(parseKanbanTaskPatch({ status: "unknown" }), null);
  assert.equal(parseKanbanTaskPatch({ status: "todo", title: "Extra" }), null);
});

test("parseKanbanTaskPatch validates exact editable task details", () => {
  assert.deepEqual(
    parseKanbanTaskPatch({
      title: "  Update the board  ",
      repository: "  monitor-agents  ",
      description: "  Keep Todo editable.  ",
    }),
    {
      title: "Update the board",
      repository: "monitor-agents",
      description: "Keep Todo editable.",
    },
  );
  assert.equal(
    parseKanbanTaskPatch({ title: "Partial", repository: "monitor-agents" }),
    null,
  );
  assert.equal(
    parseKanbanTaskPatch({
      title: "Extra",
      repository: "monitor-agents",
      description: "",
      priority: 1,
    }),
    null,
  );
  assert.equal(
    parseKanbanTaskPatch({
      title: " ",
      repository: "monitor-agents",
      description: "",
    }),
    null,
  );
  assert.equal(
    parseKanbanTaskPatch({
      title: "x".repeat(201),
      repository: "monitor-agents",
      description: "",
    }),
    null,
  );
  assert.equal(
    parseKanbanTaskPatch({
      title: "Too long description",
      repository: "monitor-agents",
      description: "x".repeat(5_001),
    }),
    null,
  );
});

test("kanbanRepositories returns sorted unique repository names", () => {
  assert.deepEqual(
    kanbanRepositories([...tasks, { ...tasks[0], id: "task-3" }]),
    ["cacti-api", "monitor-agents"],
  );
});
