import { readJsonObject } from "@/lib/api-input";
import { parseKanbanTaskPatch } from "@/lib/kanban";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const body = await readJsonObject(request);
  const patch = parseKanbanTaskPatch(body);
  if (!patch) {
    const error =
      body && Object.keys(body).length === 1 && Object.hasOwn(body, "status")
        ? "Invalid task status."
        : "Invalid task update.";
    return Response.json({ error }, { status: 400 });
  }

  const { id } = await context.params;
  const store = getTaskStore();
  if ("status" in patch) {
    const task = store.updateTaskStatus(id, patch.status);
    return task
      ? Response.json(task)
      : Response.json({ error: "Task not found." }, { status: 404 });
  }

  const task = store.updateTodoTaskDetails(id, patch);
  if (task) return Response.json(task);
  const currentTask = store.getTask(id);
  return currentTask
    ? Response.json(
        { error: "Only Todo tasks can be edited.", task: currentTask },
        { status: 409 },
      )
    : Response.json({ error: "Task not found." }, { status: 404 });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const store = getTaskStore();
  const task = store.deleteTodoTask(id);
  if (task) return new Response(null, { status: 204 });
  const currentTask = store.getTask(id);
  return currentTask
    ? Response.json(
        { error: "Only Todo tasks can be deleted.", task: currentTask },
        { status: 409 },
      )
    : Response.json({ error: "Task not found." }, { status: 404 });
}
