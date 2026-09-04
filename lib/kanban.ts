import { optionalString, requiredString } from "./api-input.ts";

export const kanbanStatuses = [
  { id: "todo", label: "Todo" },
  { id: "in-progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
] as const;

export type KanbanStatus = (typeof kanbanStatuses)[number]["id"];

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
  createdAt: string;
  updatedAt: string;
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

export function kanbanRepositories(tasks: readonly KanbanTask[]): string[] {
  return [...new Set(tasks.map((task) => task.repository))].sort((left, right) =>
    left.localeCompare(right),
  );
}
