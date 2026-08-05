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

const statusIds = new Set<KanbanStatus>(
  kanbanStatuses.map((status) => status.id),
);

export function isKanbanStatus(value: unknown): value is KanbanStatus {
  return typeof value === "string" && statusIds.has(value as KanbanStatus);
}

export function kanbanRepositories(tasks: readonly KanbanTask[]): string[] {
  return [...new Set(tasks.map((task) => task.repository))].sort((left, right) =>
    left.localeCompare(right),
  );
}
