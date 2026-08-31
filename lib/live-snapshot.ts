import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyDeclaredSpawnLinks,
  linkExternalRootsToClaudeSpawns,
  linkCodexRootsToClaudeWorktrees,
  linkWorktreeRootsToClaudeRepos,
  parseSpawnLinks,
  type AgentRun,
  type DashboardSnapshot,
  type SpawnLink,
} from "./telemetry";
import { collectAgyTelemetry } from "./collectors/agy";
import { collectClaudeTelemetry } from "./collectors/claude";
import { collectCodexTelemetry } from "./collectors/codex";
import { collectGeminiTelemetry } from "./collectors/gemini";
import { collectQwenTelemetry } from "./collectors/qwen";

// A linked worktree keeps a `.git` file rather than a directory:
// `gitdir: /repo/.git/worktrees/<name>`.
const WORKTREE_GITDIR_PATTERN =
  /^gitdir:[\t ]*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/\n]+\s*$/u;

async function resolveWorktreeMainRepos(
  agents: readonly AgentRun[],
): Promise<Map<string, string>> {
  const cwds = new Set(
    agents
      .filter((agent) => agent.provider !== "claude" && agent.parentId === null)
      .map((agent) => agent.cwd),
  );

  const mainRepoByCwd = new Map<string, string>();
  await Promise.all(
    [...cwds].map(async (cwd) => {
      let gitFile: string;
      try {
        gitFile = await readFile(join(cwd, ".git"), "utf8");
      } catch {
        // Not a worktree, or the directory is already gone.
        return;
      }

      const mainRepo = gitFile.match(WORKTREE_GITDIR_PATTERN)?.[1];
      if (mainRepo) {
        mainRepoByCwd.set(cwd, mainRepo);
      }
    }),
  );

  return mainRepoByCwd;
}

// Only the newest records can still describe a visible agent, and the ledger is
// append-only so that parallel launches never overwrite each other's lines.
const MAX_SPAWN_LINK_RECORDS = 500;

async function readSpawnLinks(): Promise<SpawnLink[]> {
  let ledger: string;
  try {
    ledger = await readFile(
      join(homedir(), ".monitor-agents", "spawn-links.jsonl"),
      "utf8",
    );
  } catch {
    // No wrapper has ever declared a spawn on this machine.
    return [];
  }

  return parseSpawnLinks(ledger).slice(-MAX_SPAWN_LINK_RECORDS);
}

export async function collectLiveSnapshot(): Promise<DashboardSnapshot> {
  const results = await Promise.all([
    collectCodexTelemetry(),
    collectClaudeTelemetry(),
    collectAgyTelemetry(),
    collectGeminiTelemetry(),
    collectQwenTelemetry(),
  ]);
  // Declared links are exact, so they run before every inference below; each
  // linker leaves an agent that already has a parent alone.
  const declaredLinkedAgents = applyDeclaredSpawnLinks(
    results.flatMap((result) => result.agents),
    await readSpawnLinks(),
  );
  const worktreeLinkedAgents =
    linkCodexRootsToClaudeWorktrees(declaredLinkedAgents);
  const spawnLinkedAgents = linkExternalRootsToClaudeSpawns(
    worktreeLinkedAgents,
    results.flatMap((result) => result.externalSpawns ?? []),
  );
  const capturedAt = new Date().toISOString();
  const agents = linkWorktreeRootsToClaudeRepos(
    spawnLinkedAgents,
    await resolveWorktreeMainRepos(spawnLinkedAgents),
    capturedAt,
  );

  return {
    mode: "live",
    capturedAt,
    agents,
    events: results
      .flatMap((result) => result.events)
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
      .slice(0, 40),
    quotaLimits: results.flatMap((result) => result.quotaLimits),
    sources: results.map((result) => result.source),
  };
}
