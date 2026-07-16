import {
  linkCodexRootsToClaudeWorktrees,
  type DashboardSnapshot,
} from "./telemetry";
import { collectAgyTelemetry } from "./collectors/agy";
import { collectClaudeTelemetry } from "./collectors/claude";
import { collectCodexTelemetry } from "./collectors/codex";
import { collectGeminiTelemetry } from "./collectors/gemini";

export async function collectLiveSnapshot(): Promise<DashboardSnapshot> {
  const results = await Promise.all([
    collectCodexTelemetry(),
    collectClaudeTelemetry(),
    collectAgyTelemetry(),
    collectGeminiTelemetry(),
  ]);
  const agents = linkCodexRootsToClaudeWorktrees(
    results.flatMap((result) => result.agents),
  );

  return {
    mode: "live",
    capturedAt: new Date().toISOString(),
    agents,
    events: results
      .flatMap((result) => result.events)
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
      .slice(0, 40),
    quotaLimits: results.flatMap((result) => result.quotaLimits),
    sources: results.map((result) => result.source),
  };
}
