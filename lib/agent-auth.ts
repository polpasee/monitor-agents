import { createHash, timingSafeEqual } from "node:crypto";

function tokensMatch(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function agentAuthError(
  request: Request,
  configuredToken = process.env.MONITOR_AGENT_TOKEN?.trim() ?? "",
): Response | null {
  if (!configuredToken) {
    return Response.json(
      { error: "Agent task API is not configured." },
      { status: 503 },
    );
  }

  const authorization = request.headers.get("authorization") ?? "";
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!tokensMatch(suppliedToken, configuredToken)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  return null;
}
