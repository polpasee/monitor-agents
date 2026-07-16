import assert from "node:assert/strict";
import test from "node:test";

import { demoSnapshot } from "./demo-data.ts";
import {
  buildAgentForest,
  calculateKpis,
  durationMs,
  formatResetDuration,
  getAgentChildren,
  getAgentDepths,
  getAgentGroup,
  getProviderQuota,
  linkCodexRootsToClaudeWorktrees,
  percent,
  retainTopologyAgents,
  type AgentRun,
  type QuotaLimit,
} from "./telemetry.ts";

const topologyCapturedAt = "2026-07-11T05:00:00.000Z";
const topologyCapturedAtMs = Date.parse(topologyCapturedAt);

function topologyAgent(
  id: string,
  status: AgentRun["status"],
  ageMs: number,
  parentId: string | null = null,
  hasEndedAt = true,
): AgentRun {
  const activityAt = new Date(topologyCapturedAtMs - ageMs).toISOString();
  return {
    ...demoSnapshot.agents[0],
    id,
    parentId,
    status,
    endedAt: hasEndedAt ? activityAt : null,
    lastActivityAt: activityAt,
  };
}

test("buildAgentForest preserves nested cross-provider relationships", () => {
  const forest = buildAgentForest(demoSnapshot.agents);

  assert.equal(forest.length, 1);
  assert.equal(forest[0].agent.id, "agent-claude-root");
  assert.deepEqual(
    forest[0].children.map((node) => node.agent.id),
    ["agent-codex-api", "agent-agy-ux"],
  );
  assert.deepEqual(
    forest[0].children[0].children.map((node) => node.agent.id),
    ["agent-codex-schema", "agent-claude-tests"],
  );
  assert.equal(
    forest[0].children[0].children[0].children[0].agent.id,
    "agent-agy-cost",
  );
});

test("buildAgentForest treats an agent with a missing parent as a root", () => {
  const orphan = {
    ...demoSnapshot.agents[0],
    id: "agent-orphan",
    parentId: "agent-missing",
  };

  assert.equal(buildAgentForest([orphan])[0].agent.id, "agent-orphan");
});

test("getAgentChildren returns only direct children in source order", () => {
  const children = getAgentChildren(
    demoSnapshot.agents,
    "agent-codex-api",
  );

  assert.deepEqual(
    children.map((agent) => agent.id),
    ["agent-codex-schema", "agent-claude-tests"],
  );
});

test("getAgentGroup returns cross-provider descendants in source order", () => {
  const root = {
    ...topologyAgent("root", "running", 0),
    provider: "claude" as const,
  };
  const child = {
    ...topologyAgent("child", "running", 0, root.id),
    provider: "codex" as const,
  };
  const grandchild = {
    ...topologyAgent("grandchild", "running", 0, child.id),
    provider: "agy" as const,
  };
  const unrelated = topologyAgent("unrelated", "running", 0);

  assert.deepEqual(
    getAgentGroup([unrelated, root, child, grandchild], root.id).map(
      (agent) => agent.id,
    ),
    ["root", "child", "grandchild"],
  );
});

test("getAgentGroup treats a missing-parent agent as the requested root", () => {
  const orphan = topologyAgent("orphan", "running", 0, "missing");
  const child = topologyAgent("child", "running", 0, orphan.id);

  assert.deepEqual(
    getAgentGroup([orphan, child], orphan.id).map((agent) => agent.id),
    ["orphan", "child"],
  );
});

test("getAgentGroup terminates safely on cycles and unknown roots", () => {
  const first = topologyAgent("first", "running", 0, "second");
  const second = topologyAgent("second", "running", 0, "first");
  const child = topologyAgent("child", "running", 0, "second");

  assert.deepEqual(
    getAgentGroup([first, second, child], first.id).map((agent) => agent.id),
    ["first", "second", "child"],
  );
  assert.deepEqual(getAgentGroup([first, second, child], "unknown"), []);
});

test("getAgentDepths resolves roots and cross-provider descendants", () => {
  const root = {
    ...topologyAgent("root", "running", 0),
    provider: "claude" as const,
  };
  const child = {
    ...topologyAgent("child", "running", 0, root.id),
    provider: "codex" as const,
  };
  const grandchild = {
    ...topologyAgent("grandchild", "running", 0, child.id),
    provider: "agy" as const,
  };
  const orphan = topologyAgent("orphan", "running", 0, "missing");
  const orphanChild = topologyAgent("orphan-child", "running", 0, orphan.id);
  const agents = [grandchild, orphanChild, child, root, orphan];
  const depths = getAgentDepths(agents);

  assert.deepEqual(
    agents.map((agent) => [agent.id, depths.get(agent.id)]),
    [
      ["grandchild", 2],
      ["orphan-child", 1],
      ["child", 1],
      ["root", 0],
      ["orphan", 0],
    ],
  );
});

test("getAgentDepths resets cycle members and continues through descendants", () => {
  const first = topologyAgent("first", "running", 0, "second");
  const second = topologyAgent("second", "running", 0, "first");
  const child = topologyAgent("child", "running", 0, "second");
  const grandchild = topologyAgent("grandchild", "running", 0, child.id);
  const self = topologyAgent("self", "running", 0, "self");
  const selfChild = topologyAgent("self-child", "running", 0, self.id);
  const depths = getAgentDepths([
    grandchild,
    child,
    first,
    second,
    selfChild,
    self,
  ]);

  assert.deepEqual(
    Object.fromEntries(depths),
    {
      first: 0,
      second: 0,
      child: 1,
      grandchild: 2,
      self: 0,
      "self-child": 1,
    },
  );
});

test("getProviderQuota selects Codex quotas by period instead of slot id", () => {
  const weeklyQuota: QuotaLimit = {
    id: "codex:quota:primary",
    provider: "codex",
    label: "Codex weekly limit",
    period: "week",
    windowHours: 168,
    usedTokens: null,
    tokenLimit: null,
    usedCostUsd: null,
    costLimitUsd: null,
    usedPercent: 6,
    resetsAt: null,
  };

  assert.equal(getProviderQuota([weeklyQuota], "codex", "week"), weeklyQuota);
  assert.equal(getProviderQuota([weeklyQuota], "codex", "hour"), undefined);
});

test("linkCodexRootsToClaudeWorktrees links a unique matching Codex root", () => {
  const agents: AgentRun[] = [
    {
      ...demoSnapshot.agents[0],
      id: "claude:session",
      parentId: null,
      provider: "claude",
    },
    {
      ...demoSnapshot.agents[0],
      id: "claude:session:child-42",
      parentId: "claude:session",
      provider: "claude",
    },
    {
      ...demoSnapshot.agents[1],
      id: "codex:worktree-root",
      parentId: null,
      provider: "codex",
      spawnMethod: "root",
      cwd: "/repo/.claude/worktrees/agent-child-42/project",
    },
    {
      ...demoSnapshot.agents[1],
      id: "codex:native-child",
      parentId: "codex:worktree-root",
      provider: "codex",
      spawnMethod: "native",
      cwd: "/repo/.claude/worktrees/agent-child-42/project",
    },
    {
      ...demoSnapshot.agents[1],
      id: "codex:unmatched",
      parentId: null,
      provider: "codex",
      spawnMethod: "root",
      cwd: "/repo/.claude/worktrees/agent-unknown",
    },
  ];

  const linked = linkCodexRootsToClaudeWorktrees(agents);

  assert.deepEqual(
    linked.map(({ id, parentId, spawnMethod }) => ({
      id,
      parentId,
      spawnMethod,
    })),
    [
      { id: "claude:session", parentId: null, spawnMethod: agents[0].spawnMethod },
      {
        id: "claude:session:child-42",
        parentId: "claude:session",
        spawnMethod: agents[1].spawnMethod,
      },
      {
        id: "codex:worktree-root",
        parentId: "claude:session:child-42",
        spawnMethod: "bash",
      },
      {
        id: "codex:native-child",
        parentId: "codex:worktree-root",
        spawnMethod: "native",
      },
      { id: "codex:unmatched", parentId: null, spawnMethod: "root" },
    ],
  );
  assert.equal(agents[2].parentId, null);
  assert.equal(agents[2].spawnMethod, "root");
});

test("linkCodexRootsToClaudeWorktrees leaves ambiguous matches unchanged", () => {
  const agents: AgentRun[] = [
    {
      ...demoSnapshot.agents[0],
      id: "claude:first:shared",
      parentId: "claude:first",
      provider: "claude",
    },
    {
      ...demoSnapshot.agents[0],
      id: "claude:second:shared",
      parentId: "claude:second",
      provider: "claude",
    },
    {
      ...demoSnapshot.agents[1],
      id: "codex:ambiguous",
      parentId: null,
      provider: "codex",
      spawnMethod: "root",
      cwd: "C:\\repo\\.claude\\worktrees\\agent-shared",
    },
  ];

  const linked = linkCodexRootsToClaudeWorktrees(agents);

  assert.equal(linked[2].parentId, null);
  assert.equal(linked[2].spawnMethod, "root");
});

test("retainTopologyAgents keeps active and recently inactive agents", () => {
  const agents = [
    topologyAgent("queued", "queued", 120_000),
    topologyAgent("running", "running", 120_000),
    {
      ...topologyAgent("recent-idle", "idle", 59_999),
      provider: "codex" as const,
    },
    {
      ...topologyAgent("expired-idle", "idle", 60_000),
      provider: "codex" as const,
    },
    topologyAgent("recent", "completed", 59_999),
    topologyAgent("expired", "completed", 60_000),
    topologyAgent("fallback-recent", "aborted", 59_999, null, false),
    topologyAgent("fallback-expired", "failed", 60_000, null, false),
  ];

  assert.deepEqual(
    retainTopologyAgents(agents, topologyCapturedAt).map((agent) => agent.id),
    ["queued", "running", "recent-idle", "recent", "fallback-recent"],
  );
});

test("retainTopologyAgents keeps an expired idle ancestor of an active agent", () => {
  const agents = [
    {
      ...topologyAgent("idle-root", "idle", 120_000),
      provider: "codex" as const,
    },
    topologyAgent("running-child", "running", 120_000, "idle-root"),
  ];

  assert.deepEqual(
    retainTopologyAgents(agents, topologyCapturedAt).map((agent) => agent.id),
    ["idle-root", "running-child"],
  );
});

test("retainTopologyAgents keeps required ancestors and source order", () => {
  const agents = [
    topologyAgent("expired-sibling", "completed", 60_001, "root"),
    topologyAgent("running-leaf", "running", 120_000, "middle"),
    topologyAgent("root", "completed", 120_000),
    topologyAgent("recent-leaf", "aborted", 59_999, "root"),
    topologyAgent("middle", "failed", 90_000, "root"),
  ];

  assert.deepEqual(
    retainTopologyAgents(agents, topologyCapturedAt).map((agent) => agent.id),
    ["running-leaf", "root", "recent-leaf", "middle"],
  );
});

test("retainTopologyAgents prunes all-expired terminal branches", () => {
  const agents = [
    topologyAgent("root", "completed", 60_000),
    topologyAgent("middle", "aborted", 90_000, "root"),
    topologyAgent("leaf", "failed", 120_000, "middle"),
  ];

  assert.deepEqual(retainTopologyAgents(agents, topologyCapturedAt), []);
});

test("retainTopologyAgents terminates safely on parent cycles", () => {
  const agents = [
    topologyAgent("active-a", "running", 120_000, "active-b"),
    topologyAgent("active-b", "completed", 120_000, "active-a"),
    topologyAgent("expired-a", "completed", 120_000, "expired-b"),
    topologyAgent("expired-b", "failed", 120_000, "expired-a"),
  ];

  assert.deepEqual(
    retainTopologyAgents(agents, topologyCapturedAt).map((agent) => agent.id),
    ["active-a", "active-b"],
  );
});

test("calculateKpis aggregates status, tokens, cost, and tool calls", () => {
  const kpis = calculateKpis(demoSnapshot.agents);

  assert.deepEqual(kpis, {
    totalAgents: 7,
    runningAgents: 3,
    idleAgents: 0,
    completedAgents: 3,
    abortedAgents: 0,
    failedAgents: 1,
    totalTokens: 62_200,
    totalCostUsd: 0.55,
    knownCostAgents: 7,
    totalToolCalls: 25,
    knownToolCallAgents: 7,
  });
});

test("calculateKpis does not turn unavailable telemetry into zero-value reports", () => {
  const agent = {
    ...demoSnapshot.agents[0],
    status: "idle" as const,
    costUsd: null,
    toolCalls: null,
  };
  const kpis = calculateKpis([agent]);

  assert.equal(kpis.idleAgents, 1);
  assert.equal(kpis.totalCostUsd, 0);
  assert.equal(kpis.knownCostAgents, 0);
  assert.equal(kpis.totalToolCalls, 0);
  assert.equal(kpis.knownToolCallAgents, 0);
});

test("demo quota usage matches provider usage events", () => {
  for (const quota of demoSnapshot.quotaLimits) {
    const providerAgentIds = new Set(
      demoSnapshot.agents
        .filter((agent) => agent.provider === quota.provider)
        .map((agent) => agent.id),
    );
    const usage = demoSnapshot.events
      .filter(
        (event) =>
          event.kind === "usage.recorded" &&
          providerAgentIds.has(event.agentId),
      )
      .reduce(
        (total, event) => ({
          tokens:
            total.tokens +
            (event.inputTokens ?? 0) +
            (event.outputTokens ?? 0),
          costUsd: total.costUsd + (event.costUsd ?? 0),
        }),
        { tokens: 0, costUsd: 0 },
      );

    assert.equal(usage.tokens, quota.usedTokens);
    assert.notEqual(quota.usedCostUsd, null);
    assert.ok(Math.abs(usage.costUsd - quota.usedCostUsd!) < 1e-10);
  }
});

test("durationMs uses completion time or the snapshot capture time", () => {
  const completed = demoSnapshot.agents.find(
    (agent) => agent.id === "agent-codex-api",
  )!;
  const running = demoSnapshot.agents.find(
    (agent) => agent.id === "agent-claude-root",
  )!;

  assert.equal(durationMs(completed, demoSnapshot.capturedAt), 70 * 60 * 1_000);
  assert.equal(durationMs(running, demoSnapshot.capturedAt), 4 * 60 * 60 * 1_000);
});

test("formatResetDuration uses compact remaining-time units", () => {
  const capturedAt = "2026-07-14T00:00:00.000Z";
  const capturedAtMs = Date.parse(capturedAt);
  const resetsIn = (milliseconds: number) =>
    new Date(capturedAtMs + milliseconds).toISOString();

  assert.equal(formatResetDuration(resetsIn(53 * 60_000), capturedAt), "53m");
  assert.equal(
    formatResetDuration(resetsIn((6 * 60 + 43) * 60_000), capturedAt),
    "6hr 43m",
  );
  assert.equal(
    formatResetDuration(
      resetsIn(((24 + 16) * 60 + 43) * 60_000),
      capturedAt,
    ),
    "1d 16hr",
  );
  assert.equal(formatResetDuration(resetsIn(60 * 60_000), capturedAt), "1hr");
  assert.equal(formatResetDuration(resetsIn(24 * 60 * 60_000), capturedAt), "1d");
  assert.equal(formatResetDuration(resetsIn(1_000), capturedAt), "1m");
  assert.equal(formatResetDuration(resetsIn(-1_000), capturedAt), "0m");
});

test("percent returns a value clamped to the zero-to-100 range", () => {
  assert.equal(percent(25, 100), 25);
  assert.equal(percent(125, 100), 100);
  assert.equal(percent(-5, 100), 0);
  assert.equal(percent(25, 0), 0);
});
