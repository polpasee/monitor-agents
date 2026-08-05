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
  const leaseSeconds = body?.leaseSeconds ?? 60;
  if (
    !body ||
    !agentId ||
    typeof leaseSeconds !== "number" ||
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < 15 ||
    leaseSeconds > 3_600
  ) {
    return Response.json({ error: "Invalid heartbeat input." }, { status: 400 });
  }

  const { id } = await context.params;
  const task = getTaskStore().heartbeatTask(
    id,
    agentId,
    new Date(),
    leaseSeconds * 1_000,
  );
  return task
    ? Response.json(task)
    : Response.json({ error: "Task claim is not active." }, { status: 409 });
}
