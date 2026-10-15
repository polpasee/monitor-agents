import { optionalString, requiredString } from "./api-input.ts";
import type { AgentRun } from "./telemetry.ts";

export const kanbanStatuses = [
  { id: "todo", label: "Todo" },
  { id: "in-progress", label: "In Coding Progress" },
  { id: "review-queue", label: "Review Queue" },
  { id: "review", label: "In Review Progress" },
  { id: "done", label: "Done" },
] as const;

export type KanbanStatus = (typeof kanbanStatuses)[number]["id"];

/** Stored as a number so `ORDER BY priority DESC` keeps working unchanged. */
export const kanbanPriorities = [
  { id: "high", label: "High", value: 1 },
  { id: "normal", label: "Normal", value: 0 },
  { id: "low", label: "Low", value: -1 },
] as const;

export type KanbanPriority = (typeof kanbanPriorities)[number]["id"];

/** The model a task asks its agent to run; Inherit is stored as NULL. */
export const kanbanModels = [
  { id: "inherit", label: "Inherit" },
  { id: "claude-fable", label: "Claude-Fable" },
  { id: "claude-opus", label: "Claude-Opus" },
  { id: "claude-sonnet", label: "Claude-Sonnet" },
  { id: "claude-haiku", label: "Claude-Haiku" },
  { id: "codex-astra", label: "Codex-Astra" },
  { id: "codex-sol", label: "Codex-Sol" },
  { id: "codex-luna", label: "Codex-Luna" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "glm", label: "GLM" },
  { id: "agy-gemini", label: "AGY-Gemini" },
  { id: "agy-sonnet", label: "AGY-Sonnet" },
  { id: "agy-opus", label: "AGY-Opus" },
  { id: "agy-gpt-oss", label: "AGY-GPT-OSS" },
] as const;

export type KanbanModel = (typeof kanbanModels)[number]["id"];

/** The effort / thinking level a task asks for; Inherit is stored as NULL. */
export const kanbanEfforts = [
  { id: "inherit", label: "Inherit" },
  { id: "xhigh", label: "xHigh" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
] as const;

export type KanbanEffort = (typeof kanbanEfforts)[number]["id"];

/** How many tasks may sit in In Coding / In Review Progress at once. */
export interface BoardSettings {
  codingLimit: number;
  reviewLimit: number;
}

export const kanbanLimitOptions = [1, 2, 3, 4, 5] as const;

export const defaultKanbanLimit = 2;

/** At least one known limit, each an integer 1–5; anything else is rejected. */
export function parseBoardSettingsPatch(
  body: Record<string, unknown> | null,
): Partial<BoardSettings> | null {
  if (!body) return null;
  const keys = Object.keys(body);
  if (
    keys.length === 0 ||
    !keys.every((key) => key === "codingLimit" || key === "reviewLimit") ||
    !keys.every((key) =>
      kanbanLimitOptions.some((option) => option === body[key]),
    )
  ) {
    return null;
  }
  return body as Partial<BoardSettings>;
}

export interface KanbanStatusEvent {
  status: KanbanStatus;
  at: string;
}

/** One Standard Workflow step an agent ran for a task; a step may repeat. */
export interface KanbanWorkflowStep {
  /** 1–6, as numbered in AGENTS.md. */
  step: number;
  model: string | null;
  effort: string | null;
  usedTokens: number | null;
  /**
   * The usage behind `usedTokens`, as billed in four kinds. Optional: steps
   * stored before these were reported have only the total.
   */
  inputTokens?: number | null;
  cacheWriteTokens?: number | null;
  cacheReadTokens?: number | null;
  outputTokens?: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  repository: string;
  status: KanbanStatus;
  priority: number;
  requestedModel: string | null;
  requestedEffort: string | null;
  requestedReviewModel: string | null;
  requestedReviewEffort: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  leaseUntil: string | null;
  result: string | null;
  lastError: string | null;
  attemptCount: number;
  sessionId: string | null;
  agentRunId: string | null;
  model: string | null;
  effort: string | null;
  usedTokens: number | null;
  pullRequestNumber: number | null;
  summary: string | null;
  statusHistory: KanbanStatusEvent[];
  workflowSteps: KanbanWorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

/** Run details an agent reports while it works on a task. */
export interface TaskRunMetadata {
  sessionId?: string;
  agentRunId?: string;
  model?: string;
  effort?: string;
  usedTokens?: number;
  /** The reporter's full list; it replaces the stored one. */
  workflowSteps?: KanbanWorkflowStep[];
}

export type KanbanTaskPatch =
  | { status: KanbanStatus }
  | {
      title: string;
      repository: string;
      description: string;
      priority?: number;
      requestedModel?: string | null;
      requestedEffort?: string | null;
      requestedReviewModel?: string | null;
      requestedReviewEffort?: string | null;
    };

const statusIds = new Set<KanbanStatus>(
  kanbanStatuses.map((status) => status.id),
);

export function isKanbanStatus(value: unknown): value is KanbanStatus {
  return typeof value === "string" && statusIds.has(value as KanbanStatus);
}

export function isKanbanTaskEditable(task: KanbanTask): boolean {
  return task.status === "todo";
}

/** Older tasks may hold any integer, so only the sign decides the level. */
export function kanbanPriorityOf(value: number) {
  return kanbanPriorities[value > 0 ? 0 : value < 0 ? 2 : 1];
}

/** A missing priority means Normal; anything but a known level is rejected. */
export function parseKanbanPriority(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return kanbanPriorities.find((priority) => priority.id === value)?.value ?? null;
}

/**
 * A missing value or "inherit" means Inherit, stored as null; `false` marks
 * anything but a known option, so the caller can reject it.
 */
function parseRequestedOption(
  options: readonly { id: string }[],
  value: unknown,
): string | null | false {
  if (value === undefined || value === null || value === "inherit") return null;
  return options.some((option) => option.id === value) ? (value as string) : false;
}

export function parseKanbanModel(value: unknown): string | null | false {
  return parseRequestedOption(kanbanModels, value);
}

export function parseKanbanEffort(value: unknown): string | null | false {
  return parseRequestedOption(kanbanEfforts, value);
}

const taskDetailKeys = new Set([
  "title",
  "repository",
  "description",
  "priority",
  "requestedModel",
  "requestedEffort",
  "requestedReviewModel",
  "requestedReviewEffort",
]);

export function parseKanbanTaskPatch(
  body: Record<string, unknown> | null,
): KanbanTaskPatch | null {
  if (!body) return null;

  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "status") {
    return isKanbanStatus(body.status) ? { status: body.status } : null;
  }

  if (
    !keys.every((key) => taskDetailKeys.has(key)) ||
    !["title", "repository", "description"].every((key) =>
      Object.hasOwn(body, key),
    )
  ) {
    return null;
  }

  const hasPriority = Object.hasOwn(body, "priority");
  const priority = hasPriority ? parseKanbanPriority(body.priority) : undefined;
  if (priority === null) return null;

  const hasModel = Object.hasOwn(body, "requestedModel");
  const requestedModel = hasModel ? parseKanbanModel(body.requestedModel) : undefined;
  const hasEffort = Object.hasOwn(body, "requestedEffort");
  const requestedEffort = hasEffort
    ? parseKanbanEffort(body.requestedEffort)
    : undefined;
  const hasReviewModel = Object.hasOwn(body, "requestedReviewModel");
  const requestedReviewModel = hasReviewModel
    ? parseKanbanModel(body.requestedReviewModel)
    : undefined;
  const hasReviewEffort = Object.hasOwn(body, "requestedReviewEffort");
  const requestedReviewEffort = hasReviewEffort
    ? parseKanbanEffort(body.requestedReviewEffort)
    : undefined;
  if (
    requestedModel === false ||
    requestedEffort === false ||
    requestedReviewModel === false ||
    requestedReviewEffort === false
  ) {
    return null;
  }

  const title = requiredString(body.title, 200);
  const repository = requiredString(body.repository, 200);
  const description = optionalString(body.description, 5_000);
  return title && repository && description !== null
    ? {
        title,
        repository,
        description,
        ...(priority !== undefined && { priority }),
        ...(hasModel && { requestedModel }),
        ...(hasEffort && { requestedEffort }),
        ...(hasReviewModel && { requestedReviewModel }),
        ...(hasReviewEffort && { requestedReviewEffort }),
      }
    : null;
}

/** Statuses where the work has stopped, so nothing is still being spent. */
const terminalStatuses = new Set<KanbanStatus>(["done"]);

/**
 * `statusHistory` records the moment each status started, so the time spent in
 * a status is the gap to the next entry. A task can re-enter a status (an
 * expired lease sends `in-progress` back to `todo`), so the gaps are summed.
 *
 * The status a task currently sits in is still running, so its gap ends now —
 * unless the task has finished, where a clock that kept counting would read as
 * work still being done.
 */
export function kanbanStatusDurations(
  task: KanbanTask,
  now = new Date(),
): { status: KanbanStatus; milliseconds: number }[] {
  const totals = new Map<KanbanStatus, number>();
  // A board can be served a task from an older API that never sent a history.
  const history = task.statusHistory ?? [];

  history.forEach((event, index) => {
    const start = Date.parse(event.at);
    const nextAt = history[index + 1]?.at;
    if (!nextAt && terminalStatuses.has(event.status)) return;
    const end = nextAt ? Date.parse(nextAt) : now.getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return;
    totals.set(
      event.status,
      (totals.get(event.status) ?? 0) + Math.max(0, end - start),
    );
  });

  return kanbanStatuses
    .filter((status) => totals.has(status.id))
    .map((status) => ({
      status: status.id,
      milliseconds: totals.get(status.id) ?? 0,
    }));
}

/** When the task entered its current status; tasks without a history fall back to their last update. */
export function kanbanStatusSince(task: KanbanTask): string {
  const history = task.statusHistory ?? [];
  return (
    history.findLast((event) => event.status === task.status)?.at ??
    task.updatedAt
  );
}

/** When the task first entered its current status; tasks without a history fall back to their last update. */
function kanbanStatusFirstAt(task: KanbanTask): string {
  const history = task.statusHistory ?? [];
  return (
    history.find((event) => event.status === task.status)?.at ?? task.updatedAt
  );
}

/**
 * Orders cards within one column: `todo` lists higher priority first. `todo` and
 * `in-progress` then list the task that first entered the status earliest, so a
 * task sent back by an expired lease keeps its place; the later columns list the
 * task that last entered earliest, so a re-queued task goes to the back.
 */
export function compareKanbanColumnTasks(
  left: KanbanTask,
  right: KanbanTask,
): number {
  const statusIndex = (task: KanbanTask) =>
    kanbanStatuses.findIndex((status) => status.id === task.status);
  // Grouping by status first keeps the order total when the board sorts every column at once.
  const byStatus = statusIndex(left) - statusIndex(right);
  if (byStatus) return byStatus;
  const enteredAt =
    left.status === "todo" || left.status === "in-progress"
      ? kanbanStatusFirstAt
      : kanbanStatusSince;
  return (
    (left.status === "todo" ? right.priority - left.priority : 0) ||
    enteredAt(left).localeCompare(enteredAt(right))
  );
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}h ${minutes % 60}m`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const bangkokTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Bangkok",
});

export function formatBangkokTime(isoString: string): string {
  return bangkokTime.format(new Date(isoString));
}

/** "Last N Minute(s)/Hour(s)/Day(s)" within a week, otherwise the time in GMT+7. */
export function formatStatusAge(isoString: string, now = new Date()): string {
  const last = (amount: number, unit: string) =>
    `Last ${amount} ${unit}${amount === 1 ? "" : "s"}`;
  const minutes = Math.max(
    1,
    Math.floor((now.getTime() - Date.parse(isoString)) / 60_000),
  );
  if (minutes < 60) return last(minutes, "Minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return last(hours, "Hour");
  const days = Math.floor(hours / 24);
  return days < 7 ? last(days, "Day") : formatBangkokTime(isoString);
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

const agyFamilies = ["gemini", "sonnet", "opus", "oss"];

/**
 * An Antigravity model by family, "agy-opus", so it never reads as the Claude
 * model it shares a name with. Requested ids ("agy-opus") and reported ones
 * ("agy/claude-opus-4-6-thinking") both start with "agy"; null for any other.
 */
function agyFamily(tokens: string[]): string | null {
  if (tokens[0] !== "agy") return null;
  const family = agyFamilies.find((name) => tokens.includes(name));
  return family ? `agy-${family}` : "agy";
}

/** "claude-opus" → "opus"; also matched inside reported ids like "gpt-6.1-sol". */
const shortModelNames = kanbanModels
  .filter((option) => option.id !== "inherit")
  .map((option) => option.id.split("-").at(-1)!);

/** A requested or reported model and effort as "opus:med"; null when both are unknown. */
export function formatModelBadge(
  model: string | null,
  effort: string | null,
): string | null {
  const tokens = model?.toLowerCase().split(/[-/._]/) ?? [];
  const shortModel =
    model &&
    (agyFamily(tokens) ??
      shortModelNames.find((name) => tokens.includes(name)) ??
      model);
  const shortEffort = effort === "medium" ? "med" : effort?.toLowerCase();
  return [shortModel, shortEffort].filter(Boolean).join(":") || null;
}

const maxWorkflowSteps = 50;

/** The Standard Workflow steps of AGENTS.md, numbered from 1. */
const workflowStepLabels = [
  "Explore",
  "Plan",
  "Implement",
  "Test & Verification",
  "Merge and Clean",
  "Summarize",
];

/** A missing key or null means "not known"; `false` marks a malformed value. */
function optionalText(value: unknown): string | null | false {
  return value === undefined || value === null
    ? null
    : (requiredString(value, 200) ?? false);
}

function optionalTimestamp(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? value
    : false;
}

const stepTokenFields = [
  "inputTokens",
  "cacheWriteTokens",
  "cacheReadTokens",
  "outputTokens",
] as const;

function validTokenCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000_000
  );
}

function parseWorkflowStep(value: unknown): KanbanWorkflowStep | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const { step } = entry;
  const usedTokens = entry.usedTokens ?? null;
  const model = optionalText(entry.model);
  const effort = optionalText(entry.effort);
  const startedAt = optionalTimestamp(entry.startedAt);
  const endedAt = optionalTimestamp(entry.endedAt);
  if (
    typeof step !== "number" ||
    !Number.isInteger(step) ||
    step < 1 ||
    step > 6 ||
    model === false ||
    effort === false ||
    startedAt === false ||
    endedAt === false ||
    (usedTokens !== null && !validTokenCount(usedTokens))
  ) {
    return null;
  }

  const parsed: KanbanWorkflowStep = {
    step,
    model,
    effort,
    usedTokens,
    startedAt,
    endedAt,
  };
  // A kind the reporter leaves out stays out; one that is sent must be a count.
  for (const field of stepTokenFields) {
    const tokens = entry[field];
    if (tokens === undefined) continue;
    if (tokens !== null && !validTokenCount(tokens)) return null;
    parsed[field] = tokens;
  }
  return parsed;
}

const stepEffortLabels: Record<string, string> = {
  xhigh: "XHigh",
  high: "High",
  medium: "Med",
  low: "Low",
};

/**
 * A reported model and effort as "OPUS:Med". The model is shown by family:
 * Codex ids (and the Astra, Sol and Luna names) read "CODEX", a known name
 * inside the id ("claude-opus-5", "glm-5.3") reads as that name, and any other
 * id by its first segment. An effort of "inherit", or none, is left out.
 */
export function formatStepModel(
  model: string | null,
  effort: string | null,
): string | null {
  if (!model) return null;
  const tokens = model.toLowerCase().split(/[-/._]/);
  const agy = agyFamily(tokens);
  const known = kanbanModels.find(
    (option) =>
      option.id !== "inherit" && tokens.includes(option.id.split("-").at(-1)!),
  );
  const family =
    agy ??
    (tokens[0] === "codex" || known?.id.startsWith("codex-")
      ? "codex"
      : known
        ? known.id.split("-").at(-1)!
        : tokens[0]);
  const level = effort?.toLowerCase();
  return [
    (family || model).toUpperCase(),
    level && level !== "inherit" ? (stepEffortLabels[level] ?? effort) : null,
  ]
    .filter(Boolean)
    .join(":");
}

/** Always in millions, "0.51 M"; null while the step reported no tokens. */
export function formatStepTokens(tokens: number | null): string {
  return tokens === null ? "—" : `${(tokens / 1_000_000).toFixed(2)} M`;
}

export interface KanbanWorkflowStepRow {
  step: number;
  label: string;
  /** Display form, e.g. "CODEX:High"; null when the step reported no model. */
  model: string | null;
  tokens: number | null;
  inputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
}

/** Each column's sum over the steps that reported it; null when none did. */
export interface KanbanWorkflowStepTotals {
  tokens: number | null;
  inputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
}

/**
 * The steps an agent reported, one row each, a repeated step staying a row of
 * its own. Rows follow `startedAt` when every step has one, otherwise the
 * order reported. A step that has started but not ended has no duration yet.
 */
export function kanbanWorkflowSteps(task: Pick<KanbanTask, "workflowSteps">): {
  rows: KanbanWorkflowStepRow[];
  totalTokens: number | null;
  totals: KanbanWorkflowStepTotals;
} {
  // A board can be served a task from an older API that never sent steps.
  const steps = task.workflowSteps ?? [];
  const startedAt = (step: KanbanWorkflowStep) =>
    step.startedAt === null ? NaN : Date.parse(step.startedAt);
  const ordered = steps.every((step) => !Number.isNaN(startedAt(step)))
    ? steps.toSorted((left, right) => startedAt(left) - startedAt(right))
    : steps;

  const rows = ordered.map((step) => {
    const duration =
      step.startedAt !== null && step.endedAt !== null
        ? Date.parse(step.endedAt) - Date.parse(step.startedAt)
        : NaN;
    return {
      step: step.step,
      label: workflowStepLabels[step.step - 1] ?? "",
      model: formatStepModel(step.model, step.effort),
      tokens: step.usedTokens,
      inputTokens: step.inputTokens ?? null,
      cacheWriteTokens: step.cacheWriteTokens ?? null,
      cacheReadTokens: step.cacheReadTokens ?? null,
      outputTokens: step.outputTokens ?? null,
      durationMs: duration >= 0 ? duration : null,
    };
  });
  const sum = (pick: (row: KanbanWorkflowStepRow) => number | null) => {
    const counted = rows.flatMap((row) => pick(row) ?? []);
    return counted.length
      ? counted.reduce((total, tokens) => total + tokens, 0)
      : null;
  };
  const totals: KanbanWorkflowStepTotals = {
    tokens: sum((row) => row.tokens),
    inputTokens: sum((row) => row.inputTokens),
    cacheWriteTokens: sum((row) => row.cacheWriteTokens),
    cacheReadTokens: sum((row) => row.cacheReadTokens),
    outputTokens: sum((row) => row.outputTokens),
  };
  return { rows, totalTokens: totals.tokens, totals };
}

/**
 * Run details are optional everywhere: an agent reports what it knows, and a
 * key it leaves out — or sends as `null` — keeps the stored value. Anything
 * else rejects the request so a malformed report is never silently dropped.
 */
export function parseTaskRunMetadata(
  body: Record<string, unknown>,
): TaskRunMetadata | null {
  const metadata: TaskRunMetadata = {};

  for (const key of ["sessionId", "agentRunId", "model", "effort"] as const) {
    if (body[key] === undefined || body[key] === null) continue;
    const value = requiredString(body[key], 200);
    if (!value) return null;
    metadata[key] = value;
  }

  if (body.usedTokens !== undefined && body.usedTokens !== null) {
    const tokens = body.usedTokens;
    if (
      typeof tokens !== "number" ||
      !Number.isInteger(tokens) ||
      tokens < 0 ||
      tokens > 1_000_000_000_000
    ) {
      return null;
    }
    metadata.usedTokens = tokens;
  }

  // The reporter sends its whole list every time, so it replaces the stored one.
  if (body.workflowSteps !== undefined && body.workflowSteps !== null) {
    const entries = body.workflowSteps;
    if (!Array.isArray(entries) || entries.length > maxWorkflowSteps) return null;
    const steps = entries.map(parseWorkflowStep);
    if (steps.includes(null)) return null;
    metadata.workflowSteps = steps as KanbanWorkflowStep[];
  }

  return metadata;
}

/**
 * A session picks up several tasks at once and hands each one to an
 * orchestrator of its own, so the prompt is what says which task an
 * orchestrator was given. The collector truncates that prompt, leaving only
 * the opening of the title to match on.
 */
const orchestratorTitle = /\*\*Task:\*\*\s*`?([^`…]+)/u;

/** A live orchestrator describes the task better than one that already stopped. */
const statusOrder: Record<AgentRun["status"], number> = {
  running: 0,
  idle: 1,
  queued: 2,
  completed: 3,
  failed: 4,
  aborted: 5,
};

/**
 * How firmly a prompt claims the task: it either carries the task id outright,
 * or it opens with the title, which the truncation may have cut to a few
 * characters. Null when the prompt says nothing about this task.
 */
function claimStrength(
  agent: AgentRun,
  task: Pick<KanbanTask, "id" | "title">,
): number | null {
  if (agent.task.includes(task.id)) return 0;

  const opening = orchestratorTitle.exec(agent.task)?.[1].trim();
  return opening !== undefined &&
    opening.length >= 4 &&
    task.title.replace(/^`/u, "").startsWith(opening)
    ? 1
    : null;
}

/**
 * In order of how sure the answer is: the run an agent reported for the task,
 * the orchestrator the session spawned for it, then the session's own run —
 * every collector names that root run `<provider>:<sessionId>`.
 */
export function findTaskAgent(
  task: Pick<KanbanTask, "id" | "sessionId" | "agentRunId" | "title">,
  agents: readonly AgentRun[],
): AgentRun | null {
  // A reported run needs no guessing, and it can be anywhere in the tree.
  const reported = task.agentRunId
    ? agents.find((agent) => agent.id === task.agentRunId)
    : undefined;
  if (reported) return reported;

  if (!task.sessionId) return null;

  const root = agents.find((agent) => {
    const segments = agent.id.split(":");
    return segments.length === 2 && segments[1] === task.sessionId;
  });
  if (!root) return null;

  const orchestrators = agents
    .flatMap((agent) => {
      if (agent.parentId !== root.id) return [];
      const claim = claimStrength(agent, task);
      return claim === null ? [] : [{ agent, claim }];
    })
    .sort(
      (left, right) =>
        left.claim - right.claim ||
        statusOrder[left.agent.status] - statusOrder[right.agent.status] ||
        Date.parse(right.agent.startedAt) - Date.parse(left.agent.startedAt),
    );

  return orchestrators[0]?.agent ?? root;
}

/**
 * The tokens a task has used: the total its agent reported, or while none is
 * reported yet, the live input and output of the run found for the task.
 * A todo task's run belongs to an attempt that ended, and a session's own run
 * found only by its id counts every task that session worked on, so neither
 * stands in for the task.
 */
export function kanbanTaskTokens(
  task: KanbanTask,
  agents: readonly AgentRun[],
): number | null {
  if (typeof task.usedTokens === "number") return task.usedTokens;
  if (task.status === "todo") return null;
  const run = findTaskAgent(task, agents);
  if (!run || (run.parentId === null && run.id !== task.agentRunId)) {
    return null;
  }
  return run.tokenUsage.input + run.tokenUsage.output;
}

export function kanbanRepositories(tasks: readonly KanbanTask[]): string[] {
  return [...new Set(tasks.map((task) => task.repository))].sort((left, right) =>
    left.localeCompare(right),
  );
}
