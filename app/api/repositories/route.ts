import { getAccessibleRepositories } from "@/lib/github-repos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(await getAccessibleRepositories(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
