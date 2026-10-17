import {
  formatStepModel,
  kanbanEfforts,
  type KanbanWorkflowStep,
} from "./kanban.ts";

/** A scored task's run as kept in performance_snapshots, after the task is gone too. */
export interface PerformanceSnapshot {
  taskId: string;
  /** The coding model the task ran, or asked for: "opus", "gpt-6.1-sol". */
  model: string | null;
  effort: string | null;
  reviewScore: number;
  workflowSteps: KanbanWorkflowStep[];
  recordedAt: string;
}

export interface PerformancePoint {
  /** "opus:med". */
  label: string;
  /** Average USD a task's coding model spent on it. */
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
 * USD per million tokens, API list prices seen 2026-10-17. Anthropic and
 * OpenAI cache writes are the 5-minute rate (1.25x input); providers without a
 * write charge bill them as input.
 */
export const tokenPrices: Record<string, TokenPrice> = {
  "claude-fable-5-1": { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 },
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  // The Claude models AGY runs, at Anthropic's list price.
  "claude-opus-4-6": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-sonnet-4-6": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  // developers.openai.com/api/docs/pricing, standard tier up to 272K input.
  "gpt-6-astra": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  "gpt-6.1-sol": { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  "gpt-6-sol": { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  "gpt-6-luna": { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  // api-docs.deepseek.com, peak hours (off-peak is half).
  "deepseek-v4-pro": { input: 1.32, cacheWrite: 1.32, cacheRead: 0.044, output: 3.96 },
  // docs.z.ai.
  "glm-5.3": { input: 1.4, cacheWrite: 1.4, cacheRead: 0.26, output: 4.4 },
  "glm-5.3-flash": { input: 0.15, cacheWrite: 0.15, cacheRead: 0.03, output: 0.5 },
  // ai.google.dev, before the December 2026 / January 2027 increases.
  "gemini-4-argon": { input: 2, cacheWrite: 2, cacheRead: 0.1, output: 10 },
  "gemini-3.8-flash": { input: 0.75, cacheWrite: 0.75, cacheRead: 0.075, output: 3.75 },
  // Open weights; the common OpenRouter host price.
  "gpt-oss-120b": { input: 0.15, cacheWrite: 0.15, cacheRead: 0.075, output: 0.6 },
};

/** A board model id reported in place of a run's own, priced as the model runnerModels runs. */
const boardModelIds: Record<string, string> = {
  "claude-fable": "claude-fable-5-1",
  "claude-opus": "claude-opus-5-5",
  "claude-sonnet": "claude-sonnet-5-5",
  "claude-haiku": "claude-haiku-5-5",
  "codex-astra": "gpt-6-astra",
  "codex-sol": "gpt-6.1-sol",
  "codex-luna": "gpt-6-luna",
  deepseek: "deepseek-v4-pro",
  glm: "glm-5.3",
  "agy-gemini": "gemini-3.8-flash",
  "agy-sonnet": "claude-sonnet-4-6",
  "agy-opus": "claude-opus-4-6",
  "agy-gpt-oss": "gpt-oss-120b",
};

/**
 * The price of a reported model id. A provider prefix ("z-ai/", "agy/") and an
 * effort suffix ("-medium") are dropped, a board id ("codex-sol") becomes the
 * model it runs, then an id without its own price takes the longest priced id
 * it starts with ("claude-opus-4-6-thinking").
 */
export function tokenPrice(model: string): TokenPrice | null {
  const reported = model
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/-(low|medium|high|xhigh)$/, "");
  const id = boardModelIds[reported] ?? reported;
  if (tokenPrices[id]) return tokenPrices[id];
  const prefix = Object.keys(tokenPrices)
    .filter((priced) => id.startsWith(`${priced}-`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? tokenPrices[prefix] : null;
}

/** Low to xhigh; an effort not listed sorts after them. */
const effortOrder = kanbanEfforts
  .map((option) => option.id as string)
  .filter((id) => id !== "inherit")
  .reverse();

function effortRank(effort: string | null): number {
  const rank = effortOrder.indexOf(effort ?? "");
  return rank === -1 ? effortOrder.length : rank;
}

function family(model: string | null): string | null {
  return formatStepModel(model, null)?.toLowerCase() ?? null;
}

/** null when the step's model has no price or its four token kinds are missing. */
function stepCost(step: KanbanWorkflowStep): number | null {
  const price = step.model ? tokenPrice(step.model) : null;
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

/**
 * Implement: the only step on the card's own model. Explore and Test &
 * Verification run on Opus whatever the card asks.
 */
const implementStep = 3;

/**
 * What the coding model's Implement steps cost. An Implement step another
 * model ran, which no reporter sends today, would be left out. null unless
 * every such step can be priced and the total is above $0.
 */
export function codingCost(
  snapshot: Pick<PerformanceSnapshot, "model" | "workflowSteps">,
): number | null {
  const codingFamily = family(snapshot.model);
  let total = 0;
  for (const step of snapshot.workflowSteps) {
    if (step.step !== implementStep || family(step.model) !== codingFamily) continue;
    const cost = stepCost(step);
    if (cost === null) return null;
    total += cost;
  }
  return total > 0 ? total : null;
}

/**
 * The review score of scored tasks against what their coding model cost,
 * averaged per "model:effort" and joined into one series per model family.
 */
export function buildPerformanceSeries(
  snapshots: PerformanceSnapshot[],
): PerformanceSeries[] {
  const families = new Map<
    string,
    Map<string, { effort: string | null; label: string; cost: number; score: number; count: number }>
  >();
  for (const snapshot of snapshots) {
    const effort = snapshot.effort?.toLowerCase() ?? null;
    const seriesLabel = family(snapshot.model);
    const label = formatStepModel(snapshot.model, effort)?.toLowerCase();
    if (!seriesLabel || !label) continue;
    const cost = codingCost(snapshot);
    if (cost === null) continue;
    const points = families.get(seriesLabel) ?? new Map();
    const sum = points.get(label) ?? { effort, label, cost: 0, score: 0, count: 0 };
    sum.cost += cost;
    sum.score += snapshot.reviewScore;
    sum.count += 1;
    points.set(label, sum);
    families.set(seriesLabel, points);
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
