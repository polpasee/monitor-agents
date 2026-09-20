import { optionalString, requiredString } from "./api-input.ts";

export const kanbanStatuses = [
  { id: "todo", label: "Todo" },
  { id: "in-progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
] as const;

export type KanbanStatus = (typeof kanbanStatuses)[number]["id"];

export interface KanbanStatusEvent {
  status: KanbanStatus;
  at: string;
}

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  repository: string;
  status: KanbanStatus;
  priority: number;
  claimedBy: string | null;
  claimedAt: string | null;
  leaseUntil: string | null;
  result: string | null;
  lastError: string | null;
  attemptCount: number;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  usedTokens: number | null;
  statusHistory: KanbanStatusEvent[];
  createdAt: string;
  updatedAt: string;
}

/** Run details an agent reports while it works on a task. */
export interface TaskRunMetadata {
  sessionId?: string;
  model?: string;
  effort?: string;
  usedTokens?: number;
}

export type KanbanTaskPatch =
  | { status: KanbanStatus }
  | { title: string; repository: string; description: string };

const statusIds = new Set<KanbanStatus>(
  kanbanStatuses.map((status) => status.id),
);

export function isKanbanStatus(value: unknown): value is KanbanStatus {
  return typeof value === "string" && statusIds.has(value as KanbanStatus);
}

export function isKanbanTaskEditable(task: KanbanTask): boolean {
  return task.status === "todo";
}

export function parseKanbanTaskPatch(
  body: Record<string, unknown> | null,
): KanbanTaskPatch | null {
  if (!body) return null;

  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "status") {
    return isKanbanStatus(body.status) ? { status: body.status } : null;
  }

  if (
    keys.length !== 3 ||
    !["title", "repository", "description"].every((key) =>
      Object.hasOwn(body, key),
    )
  ) {
    return null;
  }

  const title = requiredString(body.title, 200);
  const repository = requiredString(body.repository, 200);
  const description = optionalString(body.description, 5_000);
  return title && repository && description !== null
    ? { title, repository, description }
    : null;
}

/** Statuses where the work has stopped, so nothing is still being spent. */
const terminalStatuses = new Set<KanbanStatus>(["done", "failed"]);

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

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
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

  for (const key of ["sessionId", "model", "effort"] as const) {
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

  return metadata;
}

export function kanbanRepositories(tasks: readonly KanbanTask[]): string[] {
  return [...new Set(tasks.map((task) => task.repository))].sort((left, right) =>
    left.localeCompare(right),
  );
}
