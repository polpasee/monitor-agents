import {
  formatStepModel,
  kanbanEfforts,
  type KanbanTask,
  type KanbanWorkflowStep,
} from "./kanban.ts";

export interface PerformancePoint {
  /** "opus:med". */
  label: string;
  /** Average USD a task cost, every workflow step priced at its own model. */
  cost: number;
  /** Average review score. */
  score: number;
  count: number;
}

export interface PerformanceSeries {
  /** The model family, "opus". */
  label: string;
  /** Ordered by effort, low to xhigh. */
  points: PerformancePoint[];
}

interface TokenPrice {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * USD per million tokens, Anthropic API list prices as of 2026-10-06. Cache
 * writes are at the 5-minute TTL rate (1.25x input), which the subagents that
 * run workflow steps use.
 */
export const tokenPrices: Record<string, TokenPrice> = {
  "claude-fable-5-1": { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 },
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
};

/** Low to xhigh; an effort not listed sorts after them. */
const effortOrder = kanbanEfforts
  .map((option) => option.id as string)
  .filter((id) => id !== "inherit")
  .reverse();

function effortRank(effort: string | null): number {
  const rank = effortOrder.indexOf(effort ?? "");
  return rank === -1 ? effortOrder.length : rank;
}

/** null when the step's model has no price or its four token kinds are missing. */
function stepCost(step: KanbanWorkflowStep): number | null {
  const price = step.model ? tokenPrices[step.model] : undefined;
  const { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens } = step;
  if (
    !price ||
    inputTokens == null ||
    cacheWriteTokens == null ||
    cacheReadTokens == null ||
    outputTokens == null
  ) {
    return null;
  }
  return (
    (inputTokens * price.input +
      cacheWriteTokens * price.cacheWrite +
      cacheReadTokens * price.cacheRead +
      outputTokens * price.output) /
    1_000_000
  );
}

/** null unless every step can be priced and the total is above $0. */
export function taskCost(task: Pick<KanbanTask, "workflowSteps">): number | null {
  let total = 0;
  for (const step of task.workflowSteps) {
    const cost = stepCost(step);
    if (cost === null) return null;
    total += cost;
  }
  return total > 0 ? total : null;
}

/**
 * The review score of scored tasks against what they cost, averaged per
 * coding "model:effort" and joined into one series per model family.
 */
export function buildPerformanceSeries(tasks: KanbanTask[]): PerformanceSeries[] {
  const families = new Map<
    string,
    Map<string, { effort: string | null; label: string; cost: number; score: number; count: number }>
  >();
  for (const task of tasks) {
    if (task.reviewScore === null) continue;
    const model = task.model ?? task.requestedModel;
    const effort = (task.effort ?? task.requestedEffort)?.toLowerCase() ?? null;
    const family = formatStepModel(model, null)?.toLowerCase();
    const label = formatStepModel(model, effort)?.toLowerCase();
    if (!family || !label) continue;
    const cost = taskCost(task);
    if (cost === null) continue;
    const points = families.get(family) ?? new Map();
    const sum = points.get(label) ?? { effort, label, cost: 0, score: 0, count: 0 };
    sum.cost += cost;
    sum.score += task.reviewScore;
    sum.count += 1;
    points.set(label, sum);
    families.set(family, points);
  }

  return [...families]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, points]) => ({
      label,
      points: [...points.values()]
        .sort((a, b) => effortRank(a.effort) - effortRank(b.effort))
        .map(({ label, cost, score, count }) => ({
          label,
          cost: cost / count,
          score: score / count,
          count,
        })),
    }));
}
