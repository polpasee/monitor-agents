import { getTaskStore } from "@/lib/task-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(getTaskStore().listPerformanceSnapshots(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
