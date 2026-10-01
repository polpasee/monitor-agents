import {
  optionalString,
  readJsonObject,
  requiredString,
} from "@/lib/api-input";
import {
  parseKanbanEffort,
  parseKanbanModel,
  parseKanbanPriority,
} from "@/lib/kanban";
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
  const priority = parseKanbanPriority(body?.priority);
  const requestedModel = parseKanbanModel(body?.requestedModel);
  const requestedEffort = parseKanbanEffort(body?.requestedEffort);

  if (
    !body ||
    !title ||
    !repository ||
    description === null ||
    priority === null ||
    requestedModel === false ||
    requestedEffort === false
  ) {
    return Response.json({ error: "Invalid task input." }, { status: 400 });
  }

  const task = getTaskStore().createTask({
    title,
    repository,
    description,
    priority,
    requestedModel,
    requestedEffort,
  });
  return Response.json(task, { status: 201 });
}
