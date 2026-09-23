import { readJsonObject, requiredString } from "@/lib/api-input";
import { parseTaskRunMetadata } from "@/lib/kanban";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const body = await readJsonObject(request);
  const agentId = requiredString(body?.agentId, 200);
  const error = requiredString(body?.error, 10_000);
  const metadata = body ? parseTaskRunMetadata(body) : null;
  if (!body || !agentId || !error || !metadata) {
    return Response.json({ error: "Invalid failure input." }, { status: 400 });
  }

  const { id } = await context.params;
  const task = getTaskStore().failTask(id, agentId, error, new Date(), metadata);
  return task
    ? Response.json(task)
    : Response.json({ error: "Task claim is not active." }, { status: 409 });
}
