import {
  optionalString,
  readJsonObject,
  requiredString,
} from "@/lib/api-input";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const repository = new URL(request.url).searchParams.get("repository")?.trim();
  return Response.json(getTaskStore().listTasks(repository || undefined), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function POST(request: Request) {
  const body = await readJsonObject(request);
  const title = requiredString(body?.title, 200);
  const repository = requiredString(body?.repository, 200);
  const description = optionalString(body?.description, 5_000);
  const priority = body?.priority ?? 0;

  if (
    !body ||
    !title ||
    !repository ||
    description === null ||
    typeof priority !== "number" ||
    !Number.isInteger(priority) ||
    priority < -100 ||
    priority > 100
  ) {
    return Response.json({ error: "Invalid task input." }, { status: 400 });
  }

  const task = getTaskStore().createTask({
    title,
    repository,
    description,
    priority,
  });
  return Response.json(task, { status: 201 });
}
