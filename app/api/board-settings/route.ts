import { readJsonObject } from "@/lib/api-input";
import { parseBoardSettingsPatch } from "@/lib/kanban";
import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(getTaskStore().getBoardSettings(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function PATCH(request: Request) {
  const patch = parseBoardSettingsPatch(await readJsonObject(request));
  if (!patch) {
    return Response.json({ error: "Invalid board settings." }, { status: 400 });
  }
  return Response.json(getTaskStore().updateBoardSettings(patch));
}
