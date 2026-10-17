import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanTask, KanbanWorkflowStep } from "./kanban.ts";
import { buildPerformanceSeries, taskCost } from "./performance.ts";

function step(overrides: Partial<KanbanWorkflowStep>): KanbanWorkflowStep {
  return {
    step: 3,
    model: "claude-opus-5-5",
    effort: "medium",
    usedTokens: 1_000_000,
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 1_000_000,
    outputTokens: 0,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

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
    workflowSteps: [step({})],
    reviewScore: 8,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T03:00:00.000Z",
    ...overrides,
  };
}

test("prices every token kind of every step at that step's own model", () => {
  const cost = taskCost({
    workflowSteps: [
      step({
        model: "claude-sonnet-5-5",
        inputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
      step({ model: "claude-opus-5-5", cacheReadTokens: 0, outputTokens: 1_000_000 }),
    ],
  });
  // Sonnet 2 + 2.5 + 0.2 + 10, then Opus output 20.
  assert.ok(Math.abs(cost! - 34.7) < 1e-9);
});

test("cannot price a task with an unpriced model, missing token kinds or no steps", () => {
  assert.equal(taskCost({ workflowSteps: [step({ model: "gpt-6-sol" })] }), null);
  assert.equal(taskCost({ workflowSteps: [step({ outputTokens: undefined })] }), null);
  assert.equal(taskCost({ workflowSteps: [] }), null);
});

test("leaves out tasks without a review score or a cost", () => {
  const series = buildPerformanceSeries([
    task({ reviewScore: 8 }),
    task({ reviewScore: null }),
    task({ workflowSteps: [] }),
  ]);
  assert.deepEqual(series, [
    { label: "opus", points: [{ label: "opus:med", cost: 0.2, score: 8, count: 1 }] },
  ]);
});

test("averages the cost and score of one model:effort and counts them", () => {
  const series = buildPerformanceSeries([
    task({ reviewScore: 6 }),
    task({ reviewScore: 9, workflowSteps: [step({ cacheReadTokens: 3_000_000 })] }),
  ]);
  const point = series[0]?.points[0];
  assert.equal(point?.score, 7.5);
  assert.ok(Math.abs(point!.cost - 0.4) < 1e-9);
  assert.equal(point?.count, 2);
});

test("joins one model's efforts into one series ordered low to xhigh", () => {
  const series = buildPerformanceSeries([
    task({ effort: "xhigh" }),
    task({ effort: "medium" }),
    task({ effort: "low" }),
    task({ effort: "high" }),
    task({ model: "sonnet", effort: "high" }),
  ]);
  assert.deepEqual(
    series.map((entry) => [entry.label, entry.points.map((point) => point.label)]),
    [
      ["opus", ["opus:low", "opus:med", "opus:high", "opus:xhigh"]],
      ["sonnet", ["sonnet:high"]],
    ],
  );
});

test("labels codex-sol by its family, codex", () => {
  const series = buildPerformanceSeries([
    task({ model: null, effort: null, requestedModel: "codex-sol", requestedEffort: "high" }),
  ]);
  assert.equal(series[0]?.label, "codex");
  assert.equal(series[0]?.points[0]?.label, "codex:high");
});

test("drops a task with no model", () => {
  const series = buildPerformanceSeries([
    task({ model: null, requestedModel: null }),
  ]);
  assert.deepEqual(series, []);
});
