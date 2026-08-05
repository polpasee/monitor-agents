import { agentAuthError } from "@/lib/agent-auth";
import { readJsonObject, requiredString } from "@/lib/api-input";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authError = agentAuthError(request);
  if (authError) return authError;

  const body = await readJsonObject(request);
  const agentId = requiredString(body?.agentId, 200);
  const error = requiredString(body?.error, 10_000);
  if (!body || !agentId || !error) {
    return Response.json({ error: "Invalid failure input." }, { status: 400 });
  }

  const { id } = await context.params;
  const task = getTaskStore().failTask(id, agentId, error);
  return task
    ? Response.json(task)
    : Response.json({ error: "Task claim is not active." }, { status: 409 });
}
