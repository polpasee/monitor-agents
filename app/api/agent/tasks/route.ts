import {
  optionalString,
  readJsonObject,
  requiredString,
} from "@/lib/api-input";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await readJsonObject(request);
  const title = requiredString(body?.title, 200);
  const repository = requiredString(body?.repository, 200);
  const description = optionalString(body?.description, 5_000);

  if (!body || !title || !repository || description === null) {
    return Response.json({ error: "Invalid task input." }, { status: 400 });
  }

  const task = getTaskStore().createTask({
    title,
    repository,
    description,
    // Work an agent notices during another task waits behind everything a
    // person queued, so any priority in the request is ignored.
    priority: -1,
  });
  return Response.json(task, { status: 201 });
}
