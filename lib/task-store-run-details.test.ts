import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TaskStore } from "./task-store.ts";

test("TaskStore records every status a task passes through", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-history-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask(
      { title: "Track state time", repository: "monitor-agents" },
      new Date("2026-08-04T00:00:00.000Z"),
    );
    assert.deepEqual(task.statusHistory, [
      { status: "todo", at: "2026-08-04T00:00:00.000Z" },
    ]);

    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:01:00.000Z"),
      leaseMs: 600_000,
    });
    const completed = store.completeTask(
      task.id,
      "agent-1",
      "Done",
      new Date("2026-08-04T00:03:00.000Z"),
      {
        sessionId: "session-1",
        model: "claude-opus-5",
        effort: "high",
        usedTokens: 4_200,
      },
    );

    assert.deepEqual(completed?.statusHistory, [
      { status: "todo", at: "2026-08-04T00:00:00.000Z" },
      { status: "in-progress", at: "2026-08-04T00:01:00.000Z" },
      { status: "review", at: "2026-08-04T00:03:00.000Z" },
    ]);
    assert.equal(completed?.sessionId, "session-1");
    assert.equal(completed?.model, "claude-opus-5");
    assert.equal(completed?.effort, "high");
    assert.equal(completed?.usedTokens, 4_200);

    const moved = store.updateTaskStatus(
      task.id,
      "done",
      new Date("2026-08-04T00:04:00.000Z"),
    );
    assert.equal(moved?.statusHistory.at(-1)?.status, "done");

    // Dropping a card back on its own column must not add a second entry.
    const again = store.updateTaskStatus(
      task.id,
      "done",
      new Date("2026-08-04T00:05:00.000Z"),
    );
    assert.equal(again?.statusHistory.length, 4);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore returns an expired lease to Todo in the history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-release-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask(
      { title: "Lease expires", repository: "monitor-agents" },
      new Date("2026-08-04T00:00:00.000Z"),
    );
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:01:00.000Z"),
      leaseMs: 1_000,
    });
    store.claimTask({
      agentId: "agent-2",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:05:00.000Z"),
      leaseMs: 60_000,
    });

    assert.deepEqual(
      store.getTask(task.id)?.statusHistory.map((event) => event.status),
      ["todo", "in-progress", "todo", "in-progress"],
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore keeps run details reported by a heartbeat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-heartbeat-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask({
      title: "Report tokens while running",
      repository: "monitor-agents",
    });
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:00:00.000Z"),
      leaseMs: 60_000,
    });

    const first = store.heartbeatTask(
      task.id,
      "agent-1",
      new Date("2026-08-04T00:00:10.000Z"),
      60_000,
      { sessionId: "session-1", model: "claude-opus-5", usedTokens: 1_000 },
    );
    assert.equal(first?.usedTokens, 1_000);

    // A heartbeat that omits a field must not erase what is already stored.
    const second = store.heartbeatTask(
      task.id,
      "agent-1",
      new Date("2026-08-04T00:00:20.000Z"),
      60_000,
      { usedTokens: 2_500 },
    );
    assert.equal(second?.usedTokens, 2_500);
    assert.equal(second?.sessionId, "session-1");
    assert.equal(second?.statusHistory.length, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore upgrades a database written before run details existed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-migrate-"));
  const path = join(directory, "tasks.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      repository TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      claimed_at TEXT,
      lease_until TEXT,
      result TEXT,
      last_error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO tasks (
      id, title, description, repository, status, priority,
      claimed_by, claimed_at, created_at, updated_at
    ) VALUES (
      'legacy-1', 'Old task', '', 'monitor-agents', 'in-progress', 0,
      'agent-1', '2026-08-04T00:01:00.000Z',
      '2026-08-04T00:00:00.000Z', '2026-08-04T00:02:00.000Z'
    );
  `);
  legacy.close();

  const store = new TaskStore(path);
  try {
    const task = store.getTask("legacy-1");
    assert.equal(task?.usedTokens, null);
    assert.equal(task?.sessionId, null);
    assert.deepEqual(task?.statusHistory, [
      { status: "todo", at: "2026-08-04T00:00:00.000Z" },
      { status: "in-progress", at: "2026-08-04T00:01:00.000Z" },
    ]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
