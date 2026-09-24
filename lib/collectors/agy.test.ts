import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectAgyTelemetry } from "./agy.ts";

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
