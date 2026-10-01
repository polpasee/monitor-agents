import type { KanbanTask } from "./kanban.ts";

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

export type RunnerProvider = "claude" | "codex";

export type RunnerModel =
  | { provider: "claude"; cli: string | null }
  | { provider: "codex"; family: string; fallback: string };

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
}

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

function usageTokens(usage: Record<string, unknown>): number {
  return sumTokens(usage, [
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
function modelUsageTokens(modelUsage: Record<string, unknown>): number {
  return Object.values(modelUsage).reduce((total: number, entry) => {
    return typeof entry === "object" && entry !== null
      ? total +
          sumTokens(entry as Record<string, unknown>, [
            "inputTokens",
            "outputTokens",
            "cacheReadInputTokens",
            "cacheCreationInputTokens",
          ])
      : total;
  }, 0);
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
  const requests = new Map<string, number>();
  let resultTokens: number | undefined;
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
        resultTokens = (resultTokens ?? 0) + usageTokens(usage);
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

  if (resultTokens !== undefined) {
    metadata.usedTokens = resultTokens;
  } else if (requests.size > 0) {
    metadata.usedTokens = [...requests.values()].reduce(
      (total, tokens) => total + tokens,
      0,
    );
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
 * The stream never names the model, so the runner adds the one it passed. A
 * thread is named `codex:<threadId>` in the topology, and usage only arrives
 * when a turn completes: `input_tokens` already counts cached input and
 * `output_tokens` already counts reasoning.
 */
export function parseCodexRunMetadata(stdout: string): ClaudeRunMetadata {
  const metadata: ClaudeRunMetadata = {};

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
      }
    }
  }

  if (metadata.sessionId) {
    metadata.agentRunId = `codex:${metadata.sessionId}`;
  }

  return metadata;
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
