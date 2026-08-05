import { readJsonObject } from "@/lib/api-input";
import { isKanbanStatus } from "@/lib/kanban";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const body = await readJsonObject(request);
  if (!body || !isKanbanStatus(body.status)) {
    return Response.json({ error: "Invalid task status." }, { status: 400 });
  }

  const { id } = await context.params;
  const task = getTaskStore().updateTaskStatus(id, body.status);
  return task
    ? Response.json(task)
    : Response.json({ error: "Task not found." }, { status: 404 });
}
