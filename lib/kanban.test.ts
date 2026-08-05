import assert from "node:assert/strict";
import test from "node:test";

import {
  isKanbanStatus,
  kanbanRepositories,
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

test("kanbanRepositories returns sorted unique repository names", () => {
  assert.deepEqual(
    kanbanRepositories([...tasks, { ...tasks[0], id: "task-3" }]),
    ["cacti-api", "monitor-agents"],
  );
});
