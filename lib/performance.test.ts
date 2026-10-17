import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanWorkflowStep } from "./kanban.ts";
import {
  buildPerformanceSeries,
  codingCost,
  tokenPrice,
  tokenPrices,
  type PerformanceSnapshot,
} from "./performance.ts";

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

function snapshot(overrides: Partial<PerformanceSnapshot>): PerformanceSnapshot {
  return {
    taskId: "task",
    model: "opus",
    effort: "medium",
    reviewScore: 8,
    workflowSteps: [step({})],
    recordedAt: "2026-10-15T03:00:00.000Z",
    ...overrides,
  };
}

test("prices every token kind of the coding model's steps", () => {
  const cost = codingCost({
    model: "sonnet",
    workflowSteps: [
      step({
        model: "claude-sonnet-5-5",
        inputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ],
  });
  // 2 + 2.5 + 0.2 + 10.
  assert.ok(Math.abs(cost! - 14.7) < 1e-9);
});

test("leaves out the Opus verify step of Sonnet's work", () => {
  const cost = codingCost({
    model: "sonnet",
    workflowSteps: [
      step({ model: "claude-sonnet-5-5", step: 3 }),
      step({ model: "claude-opus-5-5", step: 4, outputTokens: 1_000_000 }),
    ],
  });
  assert.ok(Math.abs(cost! - 0.2) < 1e-9);
});

test("counts only Implement, leaving out Explore and Verify even on the card's family", () => {
  const cost = codingCost({
    model: "opus",
    workflowSteps: [
      step({ step: 1, effort: null, outputTokens: 1_000_000 }),
      step({ step: 3 }),
      step({ step: 4, outputTokens: 1_000_000 }),
    ],
  });
  assert.ok(Math.abs(cost! - 0.2) < 1e-9);
});

test("leaves out an Implement step another model ran", () => {
  const cost = codingCost({
    model: "gpt-6.1-sol",
    workflowSteps: [
      step({ step: 3, model: "claude-opus-5-5", outputTokens: 1_000_000 }),
      step({ step: 3, model: "gpt-6.1-sol", cacheReadTokens: 1_000_000 }),
    ],
  });
  // GPT-6.1 Sol cache read at $0.10.
  assert.ok(Math.abs(cost! - 0.1) < 1e-9);
});

test("matches a task's model to its steps across the runners' id shapes", () => {
  const cases: [string, string][] = [
    ["opus", "claude-opus-5-5"],
    ["codex-sol", "gpt-6.1-sol"],
    ["gpt-6.1-sol", "gpt-6.1-sol"],
    ["agy/gemini-3.8-flash-medium", "agy/gemini-3.8-flash-medium"],
    ["deepseek", "deepseek/deepseek-v4-pro"],
    ["glm", "z-ai/glm-5.3"],
  ];
  for (const [model, stepModel] of cases) {
    assert.notEqual(
      codingCost({ model, workflowSteps: [step({ model: stepModel })] }),
      null,
      `${model} / ${stepModel}`,
    );
  }
});

test("prices a reported id by dropping its provider prefix and effort suffix", () => {
  assert.equal(tokenPrice("z-ai/glm-5.3"), tokenPrices["glm-5.3"]);
  assert.equal(tokenPrice("deepseek/deepseek-v4-pro"), tokenPrices["deepseek-v4-pro"]);
  assert.equal(tokenPrice("agy/gemini-3.8-flash-medium"), tokenPrices["gemini-3.8-flash"]);
  assert.equal(tokenPrice("agy/gpt-oss-120b-medium"), tokenPrices["gpt-oss-120b"]);
  assert.equal(tokenPrice("agy/claude-opus-4-6-thinking"), tokenPrices["claude-opus-4-6"]);
  assert.equal(tokenPrice("gpt-6.1-sol"), tokenPrices["gpt-6.1-sol"]);
  assert.equal(tokenPrice("gpt-6-sol"), tokenPrices["gpt-6-sol"]);
  assert.equal(tokenPrice("glm-5.3-flash"), tokenPrices["glm-5.3-flash"]);
  assert.equal(tokenPrice("claude-opus-5"), null);
});

test("prices a board model id as the model it runs", () => {
  assert.equal(tokenPrice("codex-astra"), tokenPrices["gpt-6-astra"]);
  assert.equal(tokenPrice("agy-opus"), tokenPrices["claude-opus-4-6"]);
  assert.equal(tokenPrice("claude-sonnet"), tokenPrices["claude-sonnet-5-5"]);
  assert.equal(tokenPrice("glm"), tokenPrices["glm-5.3"]);
});

test("cannot price a task with an unpriced model, missing token kinds or no coding steps", () => {
  assert.equal(codingCost({ model: "mystery", workflowSteps: [step({ model: "mystery-1" })] }), null);
  assert.equal(codingCost({ model: "opus", workflowSteps: [step({ outputTokens: undefined })] }), null);
  assert.equal(codingCost({ model: "opus", workflowSteps: [step({ model: "claude-sonnet-5-5" })] }), null);
  assert.equal(codingCost({ model: "opus", workflowSteps: [] }), null);
});

test("leaves out snapshots without a cost", () => {
  const series = buildPerformanceSeries([
    snapshot({ reviewScore: 8 }),
    snapshot({ workflowSteps: [] }),
  ]);
  assert.deepEqual(series, [
    { label: "opus", points: [{ label: "opus:med", cost: 0.2, score: 8, count: 1 }] },
  ]);
});

test("averages the cost and score of one model:effort and counts them", () => {
  const series = buildPerformanceSeries([
    snapshot({ reviewScore: 6 }),
    snapshot({ reviewScore: 9, workflowSteps: [step({ cacheReadTokens: 3_000_000 })] }),
  ]);
  const point = series[0]?.points[0];
  assert.equal(point?.score, 7.5);
  assert.ok(Math.abs(point!.cost - 0.4) < 1e-9);
  assert.equal(point?.count, 2);
});

test("joins one model's efforts into one series ordered by cost per task", () => {
  const sonnetSteps = [step({ model: "claude-sonnet-5-5" })];
  const costing = (cacheReadTokens: number) => [step({ cacheReadTokens })];
  const series = buildPerformanceSeries([
    snapshot({ effort: "xhigh", workflowSteps: costing(4_000_000) }),
    snapshot({ effort: "medium", workflowSteps: costing(3_000_000) }),
    snapshot({ effort: "low", workflowSteps: costing(1_000_000) }),
    snapshot({ effort: "high", workflowSteps: costing(2_000_000) }),
    snapshot({ model: "sonnet", effort: "high", workflowSteps: sonnetSteps }),
  ]);
  assert.deepEqual(
    series.map((entry) => [entry.label, entry.points.map((point) => point.label)]),
    [
      ["opus", ["opus:low", "opus:high", "opus:med", "opus:xhigh"]],
      ["sonnet", ["sonnet:high"]],
    ],
  );
});

test("labels codex-sol by its family, codex", () => {
  const series = buildPerformanceSeries([
    snapshot({
      model: "codex-sol",
      effort: "high",
      workflowSteps: [step({ model: "gpt-6.1-sol" })],
    }),
  ]);
  assert.equal(series[0]?.label, "codex");
  assert.equal(series[0]?.points[0]?.label, "codex:high");
});

test("drops a snapshot with no model", () => {
  assert.deepEqual(buildPerformanceSeries([snapshot({ model: null })]), []);
});
