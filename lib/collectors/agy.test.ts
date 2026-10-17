import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { collectAgyTelemetry, parseAgyUsage } from "./agy.ts";

const usageOutput = [
  "Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-24T02:18:45Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-10-17T07:18:45Z",
  "Claude and GPT models\tWeekly Limit Remaining\t46%\t2026-10-21T05:59:18Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-17T08:05:15Z",
].join("\n");

// A fake agy for every collector call in this file; it logs each run.
const fakeAgyDirectory = await mkdtemp(join(tmpdir(), "monitor-agy-bin-"));
const fakeAgyRuns = join(fakeAgyDirectory, "runs");
process.env.AGY_BIN = join(fakeAgyDirectory, "agy");
await writeFile(join(fakeAgyDirectory, "usage"), usageOutput);
await writeFile(
  process.env.AGY_BIN,
  `#!/bin/sh\necho run >> "${fakeAgyRuns}"\ncat "${fakeAgyDirectory}/usage"\n`,
);
await chmod(process.env.AGY_BIN, 0o755);
test.after(() => rm(fakeAgyDirectory, { force: true, recursive: true }));

async function fakeAgyRunCount(): Promise<number> {
  return (await readFile(fakeAgyRuns, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean).length;
}

// Runs first: the module's usage cache is still empty.
test("AGY collector serves cached quota while one agy run refreshes it", async () => {
  const first = await Promise.all([
    collectAgyTelemetry(),
    collectAgyTelemetry(),
  ]);
  assert.deepEqual(
    first.map((result) => result.quotaLimits),
    [[], []],
  );

  while ((await collectAgyTelemetry()).quotaLimits.length === 0) {
    await delay(10);
  }
  const refreshed = await collectAgyTelemetry();
  assert.equal(
    refreshed.quotaLimits.find((quota) => quota.id === "agy-claude-week")
      ?.usedPercent,
    54,
  );
  assert.equal(await fakeAgyRunCount(), 1);
});

const agent = {
  id: "root",
  parentId: null,
  name: "AGY root",
  provider: "agy",
  model: "agy-local",
  effort: "medium",
  status: "running",
  task: "Local AGY session",
  spawnMethod: "root",
  cwd: "/tmp/agy",
  startedAt: "2026-07-12T00:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-07-12T00:01:00.000Z",
  tokenUsage: {
    input: 10,
    output: 5,
    cached: 0,
    contextUsed: 15,
    contextLimit: 1_000,
  },
  costUsd: null,
};

test("AGY collector validates and namespaces an explicit live snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-agy-"));
  const telemetryFile = join(directory, "telemetry.json");
  const previousFile = process.env.AGY_TELEMETRY_FILE;

  try {
    process.env.AGY_TELEMETRY_FILE = telemetryFile;
    await writeFile(
      telemetryFile,
      JSON.stringify({
        agents: [agent],
        events: [
          {
            id: "started",
            agentId: "root",
            provider: "agy",
            kind: "agent.started",
            at: agent.startedAt,
            label: "AGY session started",
          },
        ],
        quotaLimits: [],
      }),
    );

    const result = await collectAgyTelemetry();
    assert.equal(result.source.connection, "connected");
    assert.equal(result.agents[0].id, "agy:root");
    assert.equal(result.agents[0].effort, "medium");
    assert.equal(result.agents[0].costUsd, null);
    assert.equal(result.agents[0].toolCalls, null);
    assert.equal(result.events[0].agentId, "agy:root");
    assert.equal(result.quotaLimits.length, 4);

    await writeFile(
      telemetryFile,
      JSON.stringify({
        agents: [agent],
        events: [
          {
            id: "invalid",
            agentId: "missing",
            kind: "agent.started",
            at: agent.startedAt,
            label: "Invalid reference",
          },
        ],
        quotaLimits: [],
      }),
    );

    const invalid = await collectAgyTelemetry();
    assert.equal(invalid.source.connection, "error");
    assert.equal(invalid.agents.length, 0);
  } finally {
    if (previousFile === undefined) {
      delete process.env.AGY_TELEMETRY_FILE;
    } else {
      process.env.AGY_TELEMETRY_FILE = previousFile;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("AGY collector keeps the newest local conversations and reports the rest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-agy-local-"));
  const previousFile = process.env.AGY_TELEMETRY_FILE;
  const previousHome = process.env.AGY_HOME;
  const previousMaxAgents = process.env.MONITOR_MAX_AGENTS;
  const now = Date.now();

  try {
    delete process.env.AGY_TELEMETRY_FILE;
    process.env.AGY_HOME = directory;
    process.env.MONITOR_MAX_AGENTS = "2";
    for (const [index, conversationId] of ["old", "middle", "new"].entries()) {
      const logs = join(
        directory,
        "brain",
        conversationId,
        ".system_generated",
        "logs",
      );
      await mkdir(logs, { recursive: true });
      await writeFile(
        join(logs, "transcript.jsonl"),
        `${JSON.stringify({
          type: "USER_INPUT",
          content: `<USER_REQUEST>Task ${conversationId}</USER_REQUEST>`,
          created_at: new Date(now - (3 - index) * 60_000).toISOString(),
        })}\n`,
      );
    }

    const result = await collectAgyTelemetry();

    assert.deepEqual(
      result.agents.map((agent) => agent.id),
      ["agy:new", "agy:middle"],
    );
    assert.deepEqual(
      result.agents.map((agent) => agent.cwd),
      ["", ""],
    );
    assert.equal(result.source.hiddenAgents, 1);
    assert.match(result.source.detail, /Limited from 3 by MONITOR_MAX_AGENTS\./u);
  } finally {
    if (previousFile === undefined) {
      delete process.env.AGY_TELEMETRY_FILE;
    } else {
      process.env.AGY_TELEMETRY_FILE = previousFile;
    }
    if (previousHome === undefined) {
      delete process.env.AGY_HOME;
    } else {
      process.env.AGY_HOME = previousHome;
    }
    if (previousMaxAgents === undefined) {
      delete process.env.MONITOR_MAX_AGENTS;
    } else {
      process.env.MONITOR_MAX_AGENTS = previousMaxAgents;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("AGY collector takes cwd from the Claude worktree its transcript names most", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-agy-cwd-"));
  const previousFile = process.env.AGY_TELEMETRY_FILE;
  const previousHome = process.env.AGY_HOME;
  const worktree = "/repo/.claude/worktrees/agent-a6b056b8e34ec0f97";
  const createdAt = new Date().toISOString();

  try {
    delete process.env.AGY_TELEMETRY_FILE;
    process.env.AGY_HOME = directory;
    const logs = join(directory, "brain", "run", ".system_generated", "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(
      join(logs, "transcript.jsonl"),
      [
        { type: "USER_INPUT", content: "Fix it", created_at: createdAt },
        {
          type: "PLANNER_RESPONSE",
          content: `Compare /other/.claude/worktrees/agent-b with file://${worktree}/lib/a.ts.`,
          tool_calls: [
            { name: "run_command", args: { Cwd: JSON.stringify(worktree) } },
          ],
          created_at: createdAt,
        },
      ]
        .map((step) => JSON.stringify(step))
        .join("\n"),
    );

    const result = await collectAgyTelemetry();

    assert.deepEqual(
      result.agents.map((agent) => agent.cwd),
      [worktree],
    );
  } finally {
    if (previousFile === undefined) {
      delete process.env.AGY_TELEMETRY_FILE;
    } else {
      process.env.AGY_TELEMETRY_FILE = previousFile;
    }
    if (previousHome === undefined) {
      delete process.env.AGY_HOME;
    } else {
      process.env.AGY_HOME = previousHome;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("parseAgyUsage reads each AGY model group and window as used percent", () => {
  const quotaLimits = parseAgyUsage(
    `${usageOutput}\nClaude and GPT models\tWeekly Limit Remaining\tsoon\nUnknown\tWeekly Limit Remaining\t5%\t2026-10-21T05:59:18Z\n`,
  );

  assert.deepEqual(
    quotaLimits.map((quota) => [
      quota.id,
      quota.label,
      quota.period,
      quota.windowHours,
      quota.usedPercent,
      quota.resetsAt,
    ]),
    [
      ["agy-gemini-week", "Gemini", "week", 168, 0, "2026-10-24T02:18:45Z"],
      ["agy-gemini-hour", "Gemini", "hour", 5, 0, "2026-10-17T07:18:45Z"],
      ["agy-claude-week", "Claude and GPT", "week", 168, 54, "2026-10-21T05:59:18Z"],
      ["agy-claude-hour", "Claude and GPT", "hour", 5, 0, "2026-10-17T08:05:15Z"],
    ],
  );
  assert.ok(
    quotaLimits.every(
      (quota) => quota.provider === "agy" && quota.usedTokens === null,
    ),
  );
  assert.equal(
    parseAgyUsage("Gemini Models\tWeekly Limit Remaining\t40%\tlater")[0]
      .resetsAt,
    null,
  );
});
