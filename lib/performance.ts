import { formatStepModel, type KanbanTask } from "./kanban.ts";

export interface PerformancePoint {
  /** YYYY-MM-DD in Bangkok time. */
  day: string;
  average: number;
  count: number;
}

export interface PerformanceSeries {
  /** "opus:med", "codex:high". */
  label: string;
  points: PerformancePoint[];
}

const bangkokDate = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Bangkok",
});

/** null for a string that is not a valid time, which formatToParts would throw on. */
function bangkokDay(at: string): string | null {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const part = new Map(
    bangkokDate.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${part.get("year")}-${part.get("month")}-${part.get("day")}`;
}

/**
 * The review score of scored tasks averaged per Bangkok day, one series per
 * coding "model:effort". A task's day is when it last went done, or its last
 * update when it never did.
 */
export function buildPerformanceSeries(tasks: KanbanTask[]): PerformanceSeries[] {
  const sums = new Map<string, Map<string, { total: number; count: number }>>();
  for (const task of tasks) {
    if (task.reviewScore === null) continue;
    const label = formatStepModel(
      task.model ?? task.requestedModel,
      task.effort ?? task.requestedEffort,
    )?.toLowerCase();
    if (!label) continue;
    const doneAt = task.statusHistory.findLast((event) => event.status === "done")?.at;
    const day = bangkokDay(doneAt ?? task.updatedAt);
    if (!day) continue;
    const days = sums.get(label) ?? new Map();
    const sum = days.get(day) ?? { total: 0, count: 0 };
    sum.total += task.reviewScore;
    sum.count += 1;
    days.set(day, sum);
    sums.set(label, days);
  }

  return [...sums]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, days]) => ({
      label,
      points: [...days]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, { total, count }]) => ({ day, average: total / count, count })),
    }));
}
