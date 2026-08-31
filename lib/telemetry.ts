export type Provider = "codex" | "claude" | "agy" | "gemini" | "qwen";

export type AgentStatus =
  | "queued"
  | "running"
  | "idle"
  | "completed"
  | "aborted"
  | "failed";

export type SpawnMethod = "root" | "native" | "bash" | "api";

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  contextUsed: number;
  contextLimit: number;
}

export interface AgentRun {
  id: string;
  parentId: string | null;
  name: string;
  provider: Provider;
  model: string;
  effort: string | null;
  status: AgentStatus;
  task: string;
  spawnMethod: SpawnMethod;
  spawnCommand?: string;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  tokenUsage: TokenUsage;
  costUsd: number | null;
  toolCalls: number | null;
}

export interface ExternalSpawn {
  parentId: string;
  childProvider: Provider;
  spawnMethod: Exclude<SpawnMethod, "root" | "native">;
  at: string;
}

export interface SpawnLink {
  childId: string;
  parentId: string;
  spawnMethod: Exclude<SpawnMethod, "root" | "native">;
}

export type EventKind =
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "tool.called"
  | "usage.recorded";

export interface Event {
  id: string;
  agentId: string;
  kind: EventKind;
  at: string;
  label: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

export type QuotaPeriod = "hour" | "week";

export interface QuotaLimit {
  id: string;
  provider: Provider;
  label: string;
  period: QuotaPeriod;
  windowHours: number;
  usedTokens: number | null;
  tokenLimit: number | null;
  usedCostUsd: number | null;
  costLimitUsd: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

export function getProviderQuota(
  quotaLimits: readonly QuotaLimit[],
  provider: Provider,
  period: QuotaPeriod,
): QuotaLimit | undefined {
  return quotaLimits.find(
    (quota) => quota.provider === provider && quota.period === period,
  );
}

export type SourceConnection =
  | "connected"
  | "idle"
  | "unconfigured"
  | "error";

export interface SourceStatus {
  provider: Provider;
  connection: SourceConnection;
  detail: string;
  agentCount: number;
}

export interface DashboardSnapshot {
  mode: "live" | "demo";
  capturedAt: string;
  agents: AgentRun[];
  events: Event[];
  quotaLimits: QuotaLimit[];
  sources: SourceStatus[];
}

export interface AgentTreeNode {
  agent: AgentRun;
  children: AgentTreeNode[];
}

export interface DashboardKpis {
  totalAgents: number;
  runningAgents: number;
  idleAgents: number;
  completedAgents: number;
  abortedAgents: number;
  failedAgents: number;
  totalTokens: number;
  totalCostUsd: number;
  knownCostAgents: number;
  totalToolCalls: number;
  knownToolCallAgents: number;
}

export function getAgentChildren(
  agents: AgentRun[],
  parentId: string,
): AgentRun[] {
  return agents.filter((agent) => agent.parentId === parentId);
}

export function getAgentGroup(
  agents: readonly AgentRun[],
  rootId: string,
): AgentRun[] {
  if (!agents.some((agent) => agent.id === rootId)) {
    return [];
  }

  const childrenByParent = new Map<string, string[]>();
  for (const agent of agents) {
    if (agent.parentId === null) {
      continue;
    }

    const children = childrenByParent.get(agent.parentId) ?? [];
    children.push(agent.id);
    childrenByParent.set(agent.parentId, children);
  }

  const includedIds = new Set<string>();
  const pendingIds = [rootId];
  while (pendingIds.length > 0) {
    const agentId = pendingIds.pop()!;
    if (includedIds.has(agentId)) {
      continue;
    }

    includedIds.add(agentId);
    pendingIds.push(...(childrenByParent.get(agentId) ?? []));
  }

  return agents.filter((agent) => includedIds.has(agent.id));
}

export function getAgentDepths(
  agents: readonly AgentRun[],
): Map<string, number> {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const depths = new Map<string, number>();

  for (const agent of agents) {
    if (depths.has(agent.id)) {
      continue;
    }

    const path: AgentRun[] = [];
    const pathIndexes = new Map<string, number>();
    let current: AgentRun | undefined = agent;

    while (
      current !== undefined &&
      !depths.has(current.id) &&
      !pathIndexes.has(current.id)
    ) {
      pathIndexes.set(current.id, path.length);
      path.push(current);
      current = current.parentId
        ? agentsById.get(current.parentId)
        : undefined;
    }

    if (current !== undefined && depths.has(current.id)) {
      let depth = depths.get(current.id)!;
      for (let index = path.length - 1; index >= 0; index -= 1) {
        depth += 1;
        depths.set(path[index].id, depth);
      }
      continue;
    }

    const cycleStart =
      current === undefined ? undefined : pathIndexes.get(current.id);
    if (cycleStart !== undefined) {
      for (let index = cycleStart; index < path.length; index += 1) {
        depths.set(path[index].id, 0);
      }

      let depth = 0;
      for (let index = cycleStart - 1; index >= 0; index -= 1) {
        depth += 1;
        depths.set(path[index].id, depth);
      }
      continue;
    }

    let depth = -1;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1;
      depths.set(path[index].id, depth);
    }
  }

  return depths;
}

// A spawn that declares its own parentage does not have to be inferred at all.
// `scripts/spawn-link.mjs` appends one JSON line per launch naming both ends of
// the edge, so a wrapper script that would otherwise leave no trace produces an
// exact link. The ledger is a plain file a person can edit, so every record is
// validated and an edge is dropped unless its parent is a visible agent: an id
// that means nothing here fails to no edge, never to a wrong one.
export function parseSpawnLinks(ledger: string): SpawnLink[] {
  const links: SpawnLink[] = [];
  for (const line of ledger.split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }

    const record =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const childId = record?.childId;
    const parentId = record?.parentId;
    if (typeof childId !== "string" || typeof parentId !== "string") {
      continue;
    }

    links.push({
      childId,
      parentId,
      spawnMethod: record?.spawnMethod === "api" ? "api" : "bash",
    });
  }

  return links;
}

export function applyDeclaredSpawnLinks(
  agents: readonly AgentRun[],
  links: readonly SpawnLink[],
): AgentRun[] {
  // A retried launch appends a fresh record; the newest one wins.
  const linkByChildId = new Map(links.map((link) => [link.childId, link]));
  const agentIds = new Set(agents.map((agent) => agent.id));

  return agents.map((agent) => {
    if (agent.parentId !== null) {
      return agent;
    }

    const link = linkByChildId.get(agent.id);
    if (!link || link.parentId === agent.id || !agentIds.has(link.parentId)) {
      return agent;
    }

    return {
      ...agent,
      parentId: link.parentId,
      spawnMethod: link.spawnMethod,
    };
  });
}

const CLAUDE_WORKTREE_PATTERN =
  /(?:^|[\\/])\.claude[\\/]worktrees[\\/]agent-([^\\/]+)(?:[\\/]|$)/u;

export function claudeWorktreeAgentId(cwd: string): string | null {
  return cwd.match(CLAUDE_WORKTREE_PATTERN)?.[1] ?? null;
}

export function linkCodexRootsToClaudeWorktrees(
  agents: readonly AgentRun[],
): AgentRun[] {
  const claudeChildren = agents.filter(
    (agent) => agent.provider === "claude" && agent.parentId !== null,
  );

  return agents.map((agent) => {
    if (agent.provider !== "codex" || agent.parentId !== null) {
      return agent;
    }

    const worktreeAgentId = claudeWorktreeAgentId(agent.cwd);
    if (!worktreeAgentId) {
      return agent;
    }

    const parents = claudeChildren.filter(
      (candidate) => candidate.id.split(":").at(-1) === worktreeAgentId,
    );

    return parents.length === 1
      ? { ...agent, parentId: parents[0].id, spawnMethod: "bash" }
      : agent;
  });
}

// Qwen has been measured starting up to 17s after the Bash call that spawned
// it, so the window covers a slower cold start than codex needs. Ambiguity is
// safe: a root matching more than one spawn is left unlinked rather than
// guessed. A spawn that resumes an existing session (`qwen -r`) is never
// linked, because that session started before the command that resumed it.
// One spawn keeps several children on purpose, so that a command looping over
// a fan-out attaches all of them; the cost is that an unrelated root starting
// inside the window of some other spawn can attach to it too.
const EXTERNAL_SPAWN_LINK_WINDOW_MS = 30_000;

export function linkExternalRootsToClaudeSpawns(
  agents: readonly AgentRun[],
  externalSpawns: readonly ExternalSpawn[],
): AgentRun[] {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const spawns = externalSpawns.filter((spawn) => {
    const parent = agentsById.get(spawn.parentId);
    return (
      parent?.provider === "claude" && Number.isFinite(Date.parse(spawn.at))
    );
  });
  function matches(child: AgentRun, spawn: ExternalSpawn): boolean {
    if (spawn.childProvider !== child.provider) {
      return false;
    }

    const startedAtMs = Date.parse(child.startedAt);
    const delayMs = startedAtMs - Date.parse(spawn.at);
    return delayMs >= 0 && delayMs <= EXTERNAL_SPAWN_LINK_WINDOW_MS;
  }

  return agents.map((agent) => {
    if (agent.provider === "claude" || agent.parentId !== null) {
      return agent;
    }

    const matchingSpawns = spawns.filter((spawn) => matches(agent, spawn));
    if (matchingSpawns.length !== 1) {
      return agent;
    }

    const parentIds = new Set(matchingSpawns.map((spawn) => spawn.parentId));
    if (parentIds.size !== 1) {
      return agent;
    }

    return {
      ...agent,
      parentId: matchingSpawns[0].parentId,
      spawnMethod: matchingSpawns[0].spawnMethod,
    };
  });
}

// A spawn launched through a wrapper script (`nohup ./run-qwen.sh f1 &`)
// leaves no `qwen -p` text in the Bash command, so no ExternalSpawn mark is
// ever recorded for it. The worktree the child runs in is the evidence that
// survives: its `.git` file points back at the repository the parent session
// owns. Only Claude roots are candidates, because subagents share their
// session's cwd and would leave every repository ambiguous.
export function linkWorktreeRootsToClaudeRepos(
  agents: readonly AgentRun[],
  mainRepoByCwd: ReadonlyMap<string, string>,
  capturedAt: string,
): AgentRun[] {
  const claudeRoots = agents.filter(
    (agent) => agent.provider === "claude" && agent.parentId === null,
  );

  return agents.map((agent) => {
    if (agent.provider === "claude" || agent.parentId !== null) {
      return agent;
    }

    const mainRepo = mainRepoByCwd.get(agent.cwd);
    if (mainRepo === undefined) {
      return agent;
    }

    const startedAtMs = Date.parse(agent.startedAt);
    const parents = claudeRoots.filter(
      (candidate) =>
        candidate.cwd === mainRepo &&
        Date.parse(candidate.startedAt) <= startedAtMs &&
        startedAtMs <= Date.parse(candidate.endedAt ?? capturedAt),
    );

    return parents.length === 1
      ? { ...agent, parentId: parents[0].id, spawnMethod: "bash" }
      : agent;
  });
}

const TERMINAL_TOPOLOGY_GRACE_MS = 60_000;

function isTerminalStatus(status: AgentStatus): boolean {
  return status === "completed" || status === "aborted" || status === "failed";
}

export function retainTopologyAgents(
  agents: AgentRun[],
  capturedAt: string,
): AgentRun[] {
  const capturedAtMs = Date.parse(capturedAt);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const retainedIds = new Set<string>();
  for (const agent of agents) {
    const inactiveAtMs = Date.parse(agent.endedAt ?? agent.lastActivityAt);
    const isExpirable =
      isTerminalStatus(agent.status) ||
      (agent.provider === "codex" && agent.status === "idle");
    const isSeed =
      !isExpirable ||
      capturedAtMs - inactiveAtMs < TERMINAL_TOPOLOGY_GRACE_MS;

    if (!isSeed) {
      continue;
    }

    let current: AgentRun | undefined = agent;
    while (current && !retainedIds.has(current.id)) {
      retainedIds.add(current.id);
      current = current.parentId
        ? agentsById.get(current.parentId)
        : undefined;
    }
  }

  return agents.filter((agent) => retainedIds.has(agent.id));
}

export function buildAgentForest(agents: AgentRun[]): AgentTreeNode[] {
  const nodes = new Map<string, AgentTreeNode>(
    agents.map((agent) => [agent.id, { agent, children: [] }]),
  );
  const roots: AgentTreeNode[] = [];

  for (const agent of agents) {
    const node = nodes.get(agent.id)!;
    const parent = agent.parentId ? nodes.get(agent.parentId) : undefined;

    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export function calculateKpis(agents: AgentRun[]): DashboardKpis {
  return agents.reduce<DashboardKpis>(
    (kpis, agent) => {
      kpis.totalAgents += 1;
      kpis.runningAgents += agent.status === "running" ? 1 : 0;
      kpis.idleAgents += agent.status === "idle" ? 1 : 0;
      kpis.completedAgents += agent.status === "completed" ? 1 : 0;
      kpis.abortedAgents += agent.status === "aborted" ? 1 : 0;
      kpis.failedAgents += agent.status === "failed" ? 1 : 0;
      kpis.totalTokens += agent.tokenUsage.input + agent.tokenUsage.output;
      if (agent.costUsd !== null) {
        kpis.totalCostUsd += agent.costUsd;
        kpis.knownCostAgents += 1;
      }
      if (agent.toolCalls !== null) {
        kpis.totalToolCalls += agent.toolCalls;
        kpis.knownToolCallAgents += 1;
      }
      return kpis;
    },
    {
      totalAgents: 0,
      runningAgents: 0,
      idleAgents: 0,
      completedAgents: 0,
      abortedAgents: 0,
      failedAgents: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      knownCostAgents: 0,
      totalToolCalls: 0,
      knownToolCallAgents: 0,
    },
  );
}

export function durationMs(agent: AgentRun, capturedAt: string): number {
  const end = Date.parse(agent.endedAt ?? capturedAt);
  return Math.max(0, end - Date.parse(agent.startedAt));
}

export function formatResetDuration(
  resetsAt: string,
  capturedAt: string,
): string {
  const remainingMinutes = Math.max(
    0,
    Math.ceil((Date.parse(resetsAt) - Date.parse(capturedAt)) / 60_000),
  );
  const days = Math.floor(remainingMinutes / (24 * 60));
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
  const minutes = remainingMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}hr` : `${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}hr ${minutes}m` : `${hours}hr`;
  }

  return `${minutes}m`;
}

export function percent(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, (value / total) * 100));
}
