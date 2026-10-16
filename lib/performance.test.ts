import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanTask } from "./kanban.ts";
import { buildPerformanceSeries } from "./performance.ts";

function task(overrides: Partial<KanbanTask>): KanbanTask {
  return {
    id: "task",
    title: "Task",
    description: "",
    repository: "repo",
    status: "done",
    priority: 0,
    requestedModel: null,
    requestedEffort: null,
    requestedReviewModel: null,
    requestedReviewEffort: null,
    claimedBy: null,
    claimedAt: null,
    leaseUntil: null,
    result: null,
    lastError: null,
    attemptCount: 0,
    sessionId: null,
    agentRunId: null,
    model: "claude-opus-5",
    effort: "medium",
    usedTokens: null,
    pullRequestNumber: null,
    summary: null,
    statusHistory: [{ status: "done", at: "2026-10-15T03:00:00.000Z" }],
    workflowSteps: [],
    reviewScore: 8,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T03:00:00.000Z",
    ...overrides,
  };
}

test("leaves out tasks without a review score instead of counting them as 0", () => {
  const series = buildPerformanceSeries([
    task({ reviewScore: 8 }),
    task({ reviewScore: null }),
  ]);
  assert.deepEqual(series, [
    { label: "opus:med", points: [{ day: "2026-10-15", average: 8, count: 1 }] },
  ]);
});

test("averages the scores of one label on one day and counts them", () => {
  const series = buildPerformanceSeries([
    task({ reviewScore: 6 }),
    task({ reviewScore: 9 }),
    task({
      reviewScore: 10,
      statusHistory: [{ status: "done", at: "2026-10-14T03:00:00.000Z" }],
    }),
  ]);
  assert.deepEqual(series, [
    {
      label: "opus:med",
      points: [
        { day: "2026-10-14", average: 10, count: 1 },
        { day: "2026-10-15", average: 7.5, count: 2 },
      ],
    },
  ]);
});

test("splits one model's efforts into separate series sorted by label", () => {
  const series = buildPerformanceSeries([
    task({ effort: "medium", reviewScore: 7 }),
    task({ effort: "high", reviewScore: 9 }),
  ]);
  assert.deepEqual(
    series.map((entry) => entry.label),
    ["opus:high", "opus:med"],
  );
});

test("labels codex-sol by its family, codex", () => {
  const series = buildPerformanceSeries([
    task({ model: null, effort: null, requestedModel: "codex-sol", requestedEffort: "high" }),
  ]);
  assert.equal(series[0]?.label, "codex:high");
});

test("buckets the day in Bangkok time", () => {
  const series = buildPerformanceSeries([
    task({ statusHistory: [{ status: "done", at: "2026-10-15T18:00:00.000Z" }] }),
  ]);
  assert.equal(series[0]?.points[0]?.day, "2026-10-16");
});

test("uses the last done event, falling back to updatedAt without one", () => {
  const series = buildPerformanceSeries([
    task({
      statusHistory: [
        { status: "done", at: "2026-10-10T03:00:00.000Z" },
        { status: "review", at: "2026-10-11T03:00:00.000Z" },
        { status: "done", at: "2026-10-12T03:00:00.000Z" },
      ],
    }),
    task({
      statusHistory: [{ status: "review", at: "2026-10-12T03:00:00.000Z" }],
      updatedAt: "2026-10-13T03:00:00.000Z",
    }),
  ]);
  assert.deepEqual(
    series[0]?.points.map((point) => point.day),
    ["2026-10-12", "2026-10-13"],
  );
});

test("skips a task whose date is not a valid time", () => {
  const series = buildPerformanceSeries([
    task({ statusHistory: [{ status: "done", at: "not a date" }] }),
  ]);
  assert.deepEqual(series, []);
});

test("drops a task with no model", () => {
  const series = buildPerformanceSeries([
    task({ model: null, requestedModel: null }),
  ]);
  assert.deepEqual(series, []);
});
