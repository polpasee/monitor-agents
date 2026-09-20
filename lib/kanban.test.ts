import assert from "node:assert/strict";
import test from "node:test";

import {
  findTaskAgent,
  formatDuration,
  formatTokenCount,
  isKanbanTaskEditable,
  isKanbanStatus,
  kanbanRepositories,
  kanbanStatusDurations,
  kanbanStatuses,
  parseKanbanTaskPatch,
  parseTaskRunMetadata,
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
    sessionId: null,
    model: null,
    effort: null,
    usedTokens: null,
    statusHistory: [],
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
    sessionId: null,
    model: null,
    effort: null,
    usedTokens: null,
    statusHistory: [],
    createdAt: "2026-08-04T01:00:00.000Z",
    updatedAt: "2026-08-04T01:00:00.000Z",
  },
];

test("isKanbanStatus accepts only board states", () => {
  assert.equal(isKanbanStatus("in-progress"), true);
  assert.equal(isKanbanStatus("failed"), true);
  assert.equal(isKanbanStatus("unknown"), false);
});

test("isKanbanTaskEditable allows only Todo tasks", () => {
  assert.deepEqual(
    kanbanStatuses.map((status) =>
      isKanbanTaskEditable({ ...tasks[0], status: status.id }),
    ),
    [true, false, false, false, false],
  );
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
const task: KanbanTask = {
  id: "task-1",
  title: "Track state time",
  description: "",
  repository: "monitor-agents",
  status: "review",
  priority: 0,
  claimedBy: null,
  claimedAt: null,
  leaseUntil: null,
  result: null,
  lastError: null,
  attemptCount: 1,
  sessionId: "session-1",
  model: "claude-opus-5",
  effort: "high",
  usedTokens: 12_345,
  statusHistory: [
    { status: "todo", at: "2026-08-04T00:00:00.000Z" },
    { status: "in-progress", at: "2026-08-04T00:01:00.000Z" },
    { status: "todo", at: "2026-08-04T00:02:00.000Z" },
    { status: "in-progress", at: "2026-08-04T00:02:30.000Z" },
    { status: "review", at: "2026-08-04T00:04:30.000Z" },
  ],
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:04:30.000Z",
};

test("kanbanStatusDurations sums every visit to a status", () => {
  assert.deepEqual(
    kanbanStatusDurations(task, new Date("2026-08-04T00:05:30.000Z")),
    [
      { status: "todo", milliseconds: 90_000 },
      { status: "in-progress", milliseconds: 180_000 },
      { status: "review", milliseconds: 60_000 },
    ],
  );
});

test("kanbanStatusDurations stops the clock once a task has finished", () => {
  const finished: KanbanTask = {
    ...task,
    status: "done",
    statusHistory: [
      { status: "todo", at: "2026-08-04T00:00:00.000Z" },
      { status: "in-progress", at: "2026-08-04T00:01:00.000Z" },
      { status: "done", at: "2026-08-04T00:04:00.000Z" },
    ],
  };

  // Viewed weeks later, the finished status must not report the wait as work.
  assert.deepEqual(
    kanbanStatusDurations(finished, new Date("2026-09-20T00:00:00.000Z")),
    [
      { status: "todo", milliseconds: 60_000 },
      { status: "in-progress", milliseconds: 180_000 },
    ],
  );

  // A status the task is still sitting in keeps counting.
  assert.deepEqual(
    kanbanStatusDurations(
      { ...finished, statusHistory: finished.statusHistory.slice(0, 2) },
      new Date("2026-08-04T00:06:00.000Z"),
    ),
    [
      { status: "todo", milliseconds: 60_000 },
      { status: "in-progress", milliseconds: 300_000 },
    ],
  );
});

test("kanbanStatusDurations reports nothing without history", () => {
  assert.deepEqual(kanbanStatusDurations({ ...task, statusHistory: [] }), []);
  // An older server never sent the field at all.
  assert.deepEqual(
    kanbanStatusDurations({
      ...task,
      statusHistory: undefined as unknown as KanbanTask["statusHistory"],
    }),
    [],
  );
});

test("formatDuration scales from seconds to days", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(3_900_000), "1h 5m");
  assert.equal(formatDuration(93_600_000), "1d 2h");
});

test("formatTokenCount keeps the badge short", () => {
  assert.equal(formatTokenCount(940), "940");
  assert.equal(formatTokenCount(12_345), "12.3k");
  assert.equal(formatTokenCount(2_500_000), "2.50M");
});

test("parseTaskRunMetadata accepts only the fields an agent reports", () => {
  assert.deepEqual(parseTaskRunMetadata({ agentId: "agent-1" }), {});
  assert.deepEqual(
    parseTaskRunMetadata({
      sessionId: "session-1",
      model: "claude-opus-5",
      effort: "high",
      usedTokens: 4_200,
    }),
    {
      sessionId: "session-1",
      model: "claude-opus-5",
      effort: "high",
      usedTokens: 4_200,
    },
  );
  // An agent that serialises "not reported" as null keeps what is stored.
  assert.deepEqual(
    parseTaskRunMetadata({ sessionId: null, usedTokens: null }),
    {},
  );
  assert.equal(parseTaskRunMetadata({ usedTokens: -1 }), null);
  assert.equal(parseTaskRunMetadata({ usedTokens: 1.5 }), null);
  assert.equal(parseTaskRunMetadata({ usedTokens: "4200" }), null);
  assert.equal(parseTaskRunMetadata({ sessionId: "" }), null);
  assert.equal(parseTaskRunMetadata({ model: "m".repeat(201) }), null);
});

test("findTaskAgent matches the root run of the reported session", () => {
  const agents = [
    { id: "claude:session-1" },
    { id: "claude:session-1:child-a" },
    { id: "codex:session-2" },
  ];

  assert.deepEqual(findTaskAgent({ sessionId: "session-1" }, agents), {
    id: "claude:session-1",
  });
  assert.deepEqual(findTaskAgent({ sessionId: "session-2" }, agents), {
    id: "codex:session-2",
  });
  // A subagent of the session is not the run the task was handed to.
  assert.equal(findTaskAgent({ sessionId: "child-a" }, agents), null);
  assert.equal(findTaskAgent({ sessionId: null }, agents), null);
});
