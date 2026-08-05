import { agentAuthError } from "@/lib/agent-auth";
import { readJsonObject, requiredString, stringArray } from "@/lib/api-input";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authError = agentAuthError(request);
  if (authError) return authError;

  const body = await readJsonObject(request);
  const agentId = requiredString(body?.agentId, 200);
  const repositories = stringArray(body?.repositories, 100, 200);
  const leaseSeconds = body?.leaseSeconds ?? 60;
  if (
    !body ||
    !agentId ||
    !repositories ||
    typeof leaseSeconds !== "number" ||
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < 15 ||
    leaseSeconds > 3_600
  ) {
    return Response.json({ error: "Invalid claim input." }, { status: 400 });
  }

  const task = getTaskStore().claimTask({
    agentId,
    repositories,
    leaseMs: leaseSeconds * 1_000,
  });
  return task ? Response.json(task) : new Response(null, { status: 204 });
}
