import type { KanbanTask, KanbanWorkflowStep } from "./kanban.ts";

export const maxResultLength = 10_000;

export function truncate(text: string, maximumLength: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maximumLength
    ? trimmed
    : `${trimmed.slice(0, maximumLength - 1)}…`;
}

/**
 * Repositories are stored as `owner/name` but checkouts live directly under the
 * workspace root, so only the trailing segment identifies the directory.
 */
export function repositoryDirectoryName(repository: string): string {
  const segments = repository
    .trim()
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.at(-1) ?? "";
}

export function taskSlug(task: Pick<KanbanTask, "id" | "title">): string {
  const words = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const shortId = task.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return words ? `${words}-${shortId}` : `task-${shortId}`;
}

/**
 * A failed task keeps its worktree and branch for inspection, so every retry
 * needs its own name or `git worktree add` refuses to run.
 */
export function taskBranchName(
  task: Pick<KanbanTask, "id" | "title">,
  attempt = 1,
): string {
  const suffix = attempt > 1 ? `-a${attempt}` : "";
  return `task/${taskSlug(task)}${suffix}`;
}

export function buildTaskPrompt(task: KanbanTask): string {
  const description = task.description.trim();
  return [
    `You are completing a queued task for the ${task.repository} repository.`,
    "",
    `Task: ${task.title}`,
    description ? `\nExpected result:\n${description}` : "",
    "",
    "Working agreement:",
    "- The current directory is a dedicated git worktree already on a fresh branch for this task.",
    "- Make the code changes needed to finish the task, and verify them with the repository's own build, lint, or test commands when they exist.",
    "- Do not run git commit, git push, or open a pull request. The task runner commits and publishes your work.",
    `- If you notice other work outside this task, do not do it now. Queue it instead: curl -sS -X POST "\${MONITOR_API_URL:-http://127.0.0.1:5001}/api/agent/tasks" -H "Content-Type: application/json" -d '{"title":"...","repository":"${task.repository}","description":"..."}'`,
    "- Finish with a short summary of what you changed and how you verified it.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export type RunnerProvider = "claude" | "codex" | "openrouter" | "agy";

export type RunnerModel =
  | { provider: "claude"; cli: string | null }
  | { provider: "codex"; family: string; fallback: string }
  | { provider: "openrouter"; cli: string }
  /** `effortInModel`: the model id ends in its effort, e.g. gemini-3.8-flash-low. */
  | { provider: "agy"; cli: string; effortInModel?: boolean };

/**
 * Claude takes the CLI aliases, which follow new releases on their own. Codex
 * resolves the newest listed slug of each family at run time; the fallback is
 * used when the catalog cannot be read.
 */
const runnerModels: Record<string, RunnerModel> = {
  "claude-fable": { provider: "claude", cli: "fable" },
  "claude-opus": { provider: "claude", cli: "opus" },
  "claude-sonnet": { provider: "claude", cli: "sonnet" },
  "claude-haiku": { provider: "claude", cli: "haiku" },
  "codex-astra": { provider: "codex", family: "astra", fallback: "gpt-6-astra" },
  "codex-sol": { provider: "codex", family: "sol", fallback: "gpt-6.1-sol" },
  "codex-luna": { provider: "codex", family: "luna", fallback: "gpt-6-luna" },
  deepseek: { provider: "openrouter", cli: "deepseek/deepseek-v4-pro" },
  glm: { provider: "openrouter", cli: "z-ai/glm-5.3" },
  "agy-gemini": { provider: "agy", cli: "gemini-3.8-flash", effortInModel: true },
  "agy-sonnet": { provider: "agy", cli: "claude-sonnet-4-6" },
  "agy-opus": { provider: "agy", cli: "claude-opus-4-6-thinking" },
  "agy-gpt-oss": { provider: "agy", cli: "gpt-oss-120b-medium" },
};

/**
 * A task without a requested model runs on Claude with its default model. The
 * API validates model ids, so an unknown one only means this map is stale.
 */
export function runnerModel(requestedModel: string | null): RunnerModel {
  if (requestedModel === null) return { provider: "claude", cli: null };
  const model = runnerModels[requestedModel];
  if (!model) throw new Error(`Unknown requested model: ${requestedModel}`);
  return model;
}

/**
 * OpenRouter speaks the Anthropic API, so Claude Code runs DeepSeek and GLM
 * when pointed at it. Every Claude alias resolves to the requested model so
 * background calls and subagents stay on it, and the empty ANTHROPIC_API_KEY
 * keeps a stored Anthropic key from winning over the OpenRouter token.
 */
export function openRouterEnv(
  env: Record<string, string | undefined>,
  model: string,
): Record<string, string | undefined> {
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error(`OPENROUTER_API_KEY is not set, so ${model} cannot run`);
  return {
    ...env,
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  };
}

/**
 * Picks the newest `gpt-<major>[.<minor>]-<family>` slug from the output of
 * `codex debug models`, skipping hidden models and ones marked for upgrade.
 * Versions compare as numbers, so 6.10 is newer than 6.9.
 */
export function latestCodexSlug(
  catalogJson: string,
  family: string,
  fallback: string,
): string {
  let models: unknown;
  try {
    models = (JSON.parse(catalogJson) as { models?: unknown })?.models;
  } catch {
    return fallback;
  }
  if (!Array.isArray(models)) return fallback;

  const pattern = new RegExp(`^gpt-(\\d+)(?:\\.(\\d+))?-${family}$`);
  let best: { slug: string; major: number; minor: number } | null = null;
  for (const model of models) {
    const { slug, visibility, upgrade } = (model ?? {}) as Record<string, unknown>;
    if (typeof slug !== "string" || visibility !== "list" || upgrade != null) continue;
    const match = pattern.exec(slug);
    if (!match) continue;
    const major = Number(match[1]);
    const minor = Number(match[2] ?? 0);
    if (!best || major > best.major || (major === best.major && minor > best.minor)) {
      best = { slug, major, minor };
    }
  }
  return best?.slug ?? fallback;
}

/**
 * `agy models` lists Gemini Flash once per level, so the card's effort picks
 * the id: xhigh reads as high, and none as medium.
 */
export function agyModelId(
  model: { cli: string; effortInModel?: boolean },
  effort: string | null,
): string {
  if (!model.effortInModel) return model.cli;
  const level = effort === "xhigh" ? "high" : effort;
  return `${model.cli}-${level === "low" || level === "high" ? level : "medium"}`;
}

/**
 * Print mode with stream-json, like Claude. Never --effort: `agy` rejects it
 * for every model it lists ("--effort is not supported for model", or "conflicts
 * with --effort" for the ones whose id already names a level).
 */
export function agyArgs(prompt: string, model: string): string[] {
  return [
    "-p",
    prompt,
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ];
}

export function claudeArgs(
  prompt: string,
  model: string | null,
  effort: string | null,
): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];
}

/**
 * `--ephemeral` is left out on purpose: an ephemeral thread is never stored,
 * so the topology could not link the task to its run. The sandbox keeps writes
 * inside the worktree but leaves the network open, and never asks to approve.
 */
export function codexArgs(
  prompt: string,
  model: string,
  effort: string | null,
  worktree: string,
): string[] {
  return [
    "exec",
    "--json",
    "-s",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-m",
    model,
    ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
    "-C",
    worktree,
    prompt,
  ];
}

/**
 * `--output-format json` emits one result object, while `stream-json` emits one
 * JSON object per line and only the final `result` event carries the summary.
 */
export function parseClaudeOutput(stdout: string): {
  result: string;
  isError: boolean;
} {
  let result = "";
  let isError = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const record = event as { type?: unknown; result?: unknown; is_error?: unknown };
    if (record.type === "result") {
      if (typeof record.result === "string") result = record.result;
      isError = record.is_error === true;
    }
  }

  return { result: result || truncate(stdout, 2_000), isError };
}

/**
 * The stream reports no effort level; the runner reads that separately. Codex
 * runs report the same shape.
 */
export interface ClaudeRunMetadata {
  sessionId?: string;
  agentRunId?: string;
  model?: string;
  usedTokens?: number;
  /** The usage behind `usedTokens` in the four kinds a workflow step reports. */
  inputTokens?: number | null;
  cacheWriteTokens?: number | null;
  cacheReadTokens?: number | null;
  outputTokens?: number | null;
}

type TokenKinds = Record<
  "inputTokens" | "cacheWriteTokens" | "cacheReadTokens" | "outputTokens",
  number
>;

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sumTokens(usage: Record<string, unknown>, keys: string[]): number {
  return keys.reduce(
    (total, key) =>
      total + (typeof usage[key] === "number" ? (usage[key] as number) : 0),
    0,
  );
}

/** Usage fields named in the order input, cache write, cache read, output. */
function usageKinds(usage: Record<string, unknown>, keys: string[]): TokenKinds {
  return {
    inputTokens: sumTokens(usage, [keys[0]]),
    cacheWriteTokens: sumTokens(usage, [keys[1]]),
    cacheReadTokens: sumTokens(usage, [keys[2]]),
    outputTokens: sumTokens(usage, [keys[3]]),
  };
}

function addKinds(a: TokenKinds, b: TokenKinds): TokenKinds {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

const noTokens: TokenKinds = {
  inputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
};

function usageTokens(usage: Record<string, unknown>): TokenKinds {
  return usageKinds(usage, [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
  ]);
}

/**
 * A `result` event's `usage` covers only that turn, while `modelUsage` is the
 * running total for the whole session, subagents included.
 */
function modelUsageTokens(modelUsage: Record<string, unknown>): TokenKinds {
  return Object.values(modelUsage).reduce((total: TokenKinds, entry) => {
    return typeof entry === "object" && entry !== null
      ? addKinds(
          total,
          usageKinds(entry as Record<string, unknown>, [
            "inputTokens",
            "cacheCreationInputTokens",
            "cacheReadInputTokens",
            "outputTokens",
          ]),
        )
      : total;
  }, noTokens);
}

/**
 * The stream carries the run details the board shows: `system` announces the
 * session and model, and every `assistant` event carries the usage of one API
 * request. Retried requests repeat the same id, so usage is kept per request
 * instead of summed blindly.
 *
 * A closing `result` event carries `modelUsage`, the running total for the
 * whole session across every model and subagent, so it wins once it arrives.
 * Until then the per-request sum is what a heartbeat can report.
 */
export function parseClaudeRunMetadata(stdout: string): ClaudeRunMetadata {
  const metadata: ClaudeRunMetadata = {};
  const requests = new Map<string, TokenKinds>();
  let resultTokens: TokenKinds | undefined;
  let anonymousRequest = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const value = event as Record<string, unknown>;

    metadata.sessionId = stringField(value.session_id) ?? metadata.sessionId;
    metadata.model = stringField(value.model) ?? metadata.model;

    if (value.type === "result") {
      const modelUsage = value.modelUsage as Record<string, unknown> | undefined;
      const usage = value.usage as Record<string, unknown> | undefined;
      if (typeof modelUsage === "object" && modelUsage !== null) {
        resultTokens = modelUsageTokens(modelUsage);
      } else if (typeof usage === "object" && usage !== null) {
        // Without `modelUsage` there is only the per-turn number, and a run can
        // close with several result events, so those are summed.
        resultTokens = addKinds(resultTokens ?? noTokens, usageTokens(usage));
      }
      continue;
    }

    if (value.type !== "assistant") continue;
    const message = value.message as Record<string, unknown> | undefined;
    if (typeof message !== "object" || message === null) continue;

    // A subagent's turns carry their own model, which is not the model the
    // task itself ran on, so only the main agent's turns name the model.
    const messageModel = stringField(message.model);
    if (
      messageModel &&
      messageModel !== "<synthetic>" &&
      !value.parent_tool_use_id
    ) {
      metadata.model = messageModel;
    }

    const usage = message.usage as Record<string, unknown> | undefined;
    if (typeof usage !== "object" || usage === null) continue;
    const requestKey =
      stringField(value.request_id) ??
      stringField(message.id) ??
      `anonymous-${anonymousRequest++}`;
    requests.set(requestKey, usageTokens(usage));
  }

  const kinds =
    resultTokens ??
    (requests.size > 0 ? [...requests.values()].reduce(addKinds, noTokens) : undefined);
  if (kinds) {
    Object.assign(metadata, kinds);
    metadata.usedTokens =
      kinds.inputTokens + kinds.cacheWriteTokens + kinds.cacheReadTokens + kinds.outputTokens;
  }

  // The runner gives the task a session of its own, which the topology names
  // `claude:<sessionId>`, so the board needs no guess about which run it is.
  if (metadata.sessionId) {
    metadata.agentRunId = `claude:${metadata.sessionId}`;
  }

  return metadata;
}

/**
 * `codex exec --json` ends with the last `agent_message` as its answer. Warning
 * items and top-level `error` events can be retried, so only `turn.failed`
 * marks the run as failed.
 */
export function parseCodexOutput(stdout: string): {
  result: string;
  isError: boolean;
} {
  let message: string | undefined;
  let failure: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const value = event as Record<string, unknown>;
    const item = value.item as Record<string, unknown> | undefined;
    const error = value.error as Record<string, unknown> | undefined;

    if (
      value.type === "item.completed" &&
      typeof item === "object" &&
      item !== null &&
      item.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      message = item.text;
    } else if (value.type === "turn.failed") {
      failure =
        (typeof error === "object" && error !== null
          ? stringField(error.message)
          : undefined) ?? "The Codex turn failed.";
    }
  }

  return {
    result: failure ?? (message || truncate(stdout, 2_000)),
    isError: failure !== undefined,
  };
}

/**
 * Antigravity prints `init`, `step_update` and a final `result` event. Only
 * `result` carries the answer, and `status` is SUCCESS when the turn worked.
 */
export function parseAgyOutput(stdout: string): {
  result: string;
  isError: boolean;
} {
  let result = "";
  // A run that never printed its `result` (killed, crashed, cut off) did not finish.
  let isError = true;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = event as { event?: unknown; result?: Record<string, unknown> };
    if (record?.event === "result" && typeof record.result === "object" && record.result) {
      if (typeof record.result.response === "string") result = record.result.response;
      isError = record.result.status !== "SUCCESS";
    }
  }

  return { result: result || truncate(stdout, 2_000), isError };
}

/**
 * The conversation id names the session. Tokens are the final `result` usage;
 * until it arrives, the usage of each finished step (one per step index, as a
 * step can repeat its event) is what a heartbeat can report. `output_tokens`
 * already counts thinking, and `total_tokens` is input plus output without
 * `cache_read_tokens`, so the used tokens are the kinds added up.
 */
export function parseAgyRunMetadata(stdout: string): ClaudeRunMetadata {
  const metadata: ClaudeRunMetadata = {};
  const steps = new Map<number, Record<string, unknown>>();
  let resultUsage: Record<string, unknown> | undefined;

  const usageOf = (usage: unknown): Record<string, unknown> | undefined =>
    typeof usage === "object" && usage !== null
      ? (usage as Record<string, unknown>)
      : undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;

    if (event.event === "init") {
      metadata.sessionId = stringField(event.conversation_id) ?? metadata.sessionId;
    } else if (event.event === "step_update") {
      const step = event.step_update as Record<string, unknown> | undefined;
      const usage = usageOf(step?.usage);
      if (step && typeof step.step_index === "number" && usage) {
        steps.set(step.step_index, usage);
      }
    } else if (event.event === "result") {
      const result = event.result as Record<string, unknown> | undefined;
      metadata.sessionId = stringField(result?.conversation_id) ?? metadata.sessionId;
      resultUsage = usageOf(result?.usage) ?? resultUsage;
    }
  }

  const usages = resultUsage ? [resultUsage] : [...steps.values()];
  if (usages.length === 0) return metadata;
  const sum = (count: (usage: Record<string, unknown>) => number) =>
    usages.reduce((tokens, usage) => tokens + count(usage), 0);
  // A usage with only `total_tokens` cannot be split.
  const split = usages.some(
    (usage) =>
      typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number",
  );
  if (!split) {
    metadata.usedTokens = sum((usage) => sumTokens(usage, ["total_tokens"]));
    metadata.inputTokens = null;
    metadata.cacheWriteTokens = null;
    metadata.cacheReadTokens = null;
    metadata.outputTokens = null;
    return metadata;
  }
  metadata.inputTokens = sum((usage) => sumTokens(usage, ["input_tokens"]));
  metadata.cacheWriteTokens = 0;
  metadata.cacheReadTokens = sum((usage) => sumTokens(usage, ["cache_read_tokens"]));
  metadata.outputTokens = sum((usage) => sumTokens(usage, ["output_tokens"]));
  metadata.usedTokens =
    metadata.inputTokens + metadata.cacheReadTokens + metadata.outputTokens;
  return metadata;
}

/**
 * The stream never names the model, so the runner adds the one it passed. A
 * thread is named `codex:<threadId>` in the topology, and usage only arrives
 * when a turn completes: `input_tokens` already counts cached input and
 * `output_tokens` already counts reasoning.
 */
export function parseCodexRunMetadata(stdout: string): ClaudeRunMetadata {
  const metadata: ClaudeRunMetadata = {};
  let kinds: TokenKinds | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const value = event as Record<string, unknown>;

    if (value.type === "thread.started") {
      metadata.sessionId = stringField(value.thread_id) ?? metadata.sessionId;
    } else if (value.type === "turn.completed") {
      const usage = value.usage as Record<string, unknown> | undefined;
      if (typeof usage === "object" && usage !== null) {
        metadata.usedTokens =
          (metadata.usedTokens ?? 0) +
          sumTokens(usage, ["input_tokens", "output_tokens"]);
        const input = sumTokens(usage, ["input_tokens"]);
        const cached = sumTokens(usage, ["cached_input_tokens"]);
        kinds = addKinds(kinds ?? noTokens, {
          inputTokens: Math.max(input - cached, 0),
          cacheWriteTokens: sumTokens(usage, ["cache_write_input_tokens"]),
          cacheReadTokens: cached,
          outputTokens: sumTokens(usage, ["output_tokens"]),
        });
      }
    }
  }

  if (kinds) Object.assign(metadata, kinds);
  if (metadata.sessionId) {
    metadata.agentRunId = `codex:${metadata.sessionId}`;
  }

  return metadata;
}

/** Stored step times carry no milliseconds, e.g. "2026-10-16T08:30:40Z". */
function stepTimestamp(date: Date | null): string | null {
  return date ? date.toISOString().replace(/\.\d{3}Z$/u, "Z") : null;
}

/**
 * The runner's whole run is one Implement step (3). It is left out until the
 * stream reports usage, so an early heartbeat keeps whatever is stored.
 */
export function runWorkflowSteps(
  metadata: ClaudeRunMetadata & { effort?: string },
  startedAt: Date,
  endedAt: Date | null,
): { workflowSteps?: KanbanWorkflowStep[] } {
  if (metadata.inputTokens === undefined) return {};
  return {
    workflowSteps: [
      {
        step: 3,
        model: metadata.model ?? null,
        effort: metadata.effort ?? null,
        usedTokens: metadata.usedTokens ?? null,
        inputTokens: metadata.inputTokens,
        cacheWriteTokens: metadata.cacheWriteTokens ?? null,
        cacheReadTokens: metadata.cacheReadTokens ?? null,
        outputTokens: metadata.outputTokens ?? null,
        startedAt: stepTimestamp(startedAt),
        endedAt: stepTimestamp(endedAt),
      },
    ],
  };
}

/**
 * Agent tooling (MCP servers, editor caches) writes into the checkout while a
 * task runs. Those paths must never reach the pull request, so staging uses an
 * explicit exclude pathspec instead of a bare `git add -A`.
 */
export function stagePathspecs(excludes: readonly string[]): string[] {
  const cleaned = excludes
    .map((entry) => entry.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return [".", ...cleaned.map((entry) => `:(exclude)${entry}/**`), ...cleaned.map((entry) => `:(exclude)${entry}`)];
}

export interface CompletionSummary {
  summary: string;
  branch: string;
  pullRequestUrl?: string;
  changedFiles: number;
}

export function formatCompletionResult(input: CompletionSummary): string {
  const header =
    input.changedFiles === 0
      ? "No file changes were produced."
      : `${input.changedFiles} file(s) changed on ${input.branch}.`;
  const heading = input.pullRequestUrl
    ? `${header}\nPull request: ${input.pullRequestUrl}`
    : header;
  return truncate(
    [heading, input.summary.trim()].filter(Boolean).join("\n\n"),
    maxResultLength,
  );
}

export function pullRequestNumberFromUrl(url: string | undefined): number | undefined {
  const match = url ? /\/pull\/(\d+)/.exec(url) : null;
  return match ? Number(match[1]) : undefined;
}

export function formatFailure(reason: string, detail: string): string {
  return truncate([reason, detail].filter(Boolean).join("\n\n"), maxResultLength);
}
