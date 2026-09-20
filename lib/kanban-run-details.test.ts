import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDuration,
  formatTokenCount,
  kanbanStatusDurations,
  parseTaskRunMetadata,
  type KanbanTask,
} from "./kanban.ts";

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

test("kanbanStatusDurations reports nothing without history", () => {
  assert.deepEqual(kanbanStatusDurations({ ...task, statusHistory: [] }), []);
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
  assert.equal(parseTaskRunMetadata({ usedTokens: -1 }), null);
  assert.equal(parseTaskRunMetadata({ usedTokens: 1.5 }), null);
  assert.equal(parseTaskRunMetadata({ usedTokens: "4200" }), null);
  assert.equal(parseTaskRunMetadata({ sessionId: "" }), null);
  assert.equal(parseTaskRunMetadata({ model: "m".repeat(201) }), null);
});
