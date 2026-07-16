import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
