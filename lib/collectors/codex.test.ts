import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { collectCodexTelemetry } from "./codex.ts";

test("Codex collector loads multiple recent native families under one agent cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-codex-"));
  const previousCodexHome = process.env.CODEX_HOME;
  const previousMaxAgents = process.env.MONITOR_MAX_AGENTS;
  const previousWorkspace = process.env.MONITOR_WORKSPACE;
  const workspace = "/workspace/repo";
  const claudeWorktree = `${workspace}/.claude/worktrees/agent-child-42`;
  const now = Date.now();
  const createdAtMs = now - 60_000;
  const threads = [
    { id: "root-a", updatedAtMs: now - 3_000, cwd: workspace },
    { id: "root-b", updatedAtMs: now - 4_000, cwd: claudeWorktree },
    { id: "child-a", updatedAtMs: now, cwd: workspace },
    { id: "child-b", updatedAtMs: now - 1_000, cwd: claudeWorktree },
    { id: "older-child-a", updatedAtMs: now - 5_000, cwd: workspace },
  ];

  try {
    process.env.CODEX_HOME = directory;
    process.env.MONITOR_MAX_AGENTS = "4";
    delete process.env.MONITOR_WORKSPACE;

    await Promise.all(
      threads.map(({ id }) => {
        const records: unknown[] = [
          {
            timestamp: new Date(createdAtMs + 1_000).toISOString(),
            type: "event_msg",
            payload: {
              type: "task_started",
              turn_id: `turn-${id}`,
              started_at: (createdAtMs + 1_000) / 1_000,
            },
          },
        ];
        if (id === "root-b") {
          records.push({
            timestamp: new Date(createdAtMs + 2_000).toISOString(),
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: `turn-${id}`,
              completed_at: (createdAtMs + 2_000) / 1_000,
            },
          });
        }
        return writeFile(
          join(directory, `${id}.jsonl`),
          `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        );
      }),
    );

    const database = new DatabaseSync(join(directory, "state_5.sqlite"));
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_at_ms INTEGER,
        updated_at INTEGER NOT NULL,
        updated_at_ms INTEGER,
        cwd TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        agent_nickname TEXT,
        agent_role TEXT,
        model TEXT,
        reasoning_effort TEXT,
        thread_source TEXT
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    const insertThread = database.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, created_at_ms, updated_at, updated_at_ms,
        cwd, model, reasoning_effort, thread_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const thread of threads) {
      insertThread.run(
        thread.id,
        join(directory, `${thread.id}.jsonl`),
        Math.floor(createdAtMs / 1_000),
        createdAtMs,
        Math.floor(thread.updatedAtMs / 1_000),
        thread.updatedAtMs,
        thread.cwd,
        "test-model",
        "high",
        thread.id.startsWith("root-") ? "user" : "subagent",
      );
    }
    const insertEdge = database.prepare(`
      INSERT INTO thread_spawn_edges (
        parent_thread_id, child_thread_id, status
      ) VALUES (?, ?, ?)
    `);
    insertEdge.run("root-a", "child-a", "open");
    insertEdge.run("root-b", "child-b", "open");
    insertEdge.run("root-a", "older-child-a", "open");
    database.close();

    const result = await collectCodexTelemetry();

    assert.deepEqual(
      result.agents.map((agent) => ({
        id: agent.id,
        parentId: agent.parentId,
        status: agent.status,
        spawnMethod: agent.spawnMethod,
      })),
      [
        {
          id: "codex:root-a",
          parentId: null,
          status: "running",
          spawnMethod: "root",
        },
        {
          id: "codex:root-b",
          parentId: null,
          status: "completed",
          spawnMethod: "bash",
        },
        {
          id: "codex:child-a",
          parentId: "codex:root-a",
          status: "running",
          spawnMethod: "native",
        },
        {
          id: "codex:child-b",
          parentId: "codex:root-b",
          status: "running",
          spawnMethod: "native",
        },
      ],
    );
    assert.notEqual(result.agents[1].endedAt, null);
    assert.equal(result.agents.length, 4);
    assert.match(result.source.detail, /Limited from 5 by MONITOR_MAX_AGENTS/);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousMaxAgents === undefined) {
      delete process.env.MONITOR_MAX_AGENTS;
    } else {
      process.env.MONITOR_MAX_AGENTS = previousMaxAgents;
    }
    if (previousWorkspace === undefined) {
      delete process.env.MONITOR_WORKSPACE;
    } else {
      process.env.MONITOR_WORKSPACE = previousWorkspace;
    }
    await rm(directory, { force: true, recursive: true });
  }
});
