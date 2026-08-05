import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskStore } from "./task-store.ts";

test("TaskStore creates, lists, and updates shared tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-store-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask({
      title: "Implement claim API",
      description: "Return one task atomically.",
      repository: "monitor-agents",
      priority: 2,
    });

    assert.equal(task.status, "todo");
    assert.equal(task.priority, 2);
    assert.deepEqual(store.listTasks(), [task]);
    assert.equal(store.updateTaskStatus(task.id, "done")?.status, "done");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore claims a task once and completes it into review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-claim-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask({
      title: "Run verification",
      repository: "monitor-agents",
    });
    const now = new Date("2026-08-04T00:00:00.000Z");
    const claimed = store.claimTask({
      agentId: "codex-1",
      repositories: ["monitor-agents"],
      now,
      leaseMs: 60_000,
    });

    assert.equal(claimed?.id, task.id);
    assert.equal(claimed?.claimedBy, "codex-1");
    assert.equal(claimed?.attemptCount, 1);
    assert.equal(
      store.claimTask({
        agentId: "codex-2",
        repositories: ["monitor-agents"],
        now,
      }),
      null,
    );
    assert.equal(
      store.completeTask(task.id, "codex-1", "Tests passed", now)?.status,
      "review",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore releases an expired lease for another agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-lease-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask({
      title: "Recover abandoned work",
      repository: "cacti-api",
    });
    store.claimTask({
      agentId: "agent-old",
      repositories: ["cacti-api"],
      now: new Date("2026-08-04T00:00:00.000Z"),
      leaseMs: 1_000,
    });

    const reclaimed = store.claimTask({
      agentId: "agent-new",
      repositories: ["cacti-api"],
      now: new Date("2026-08-04T00:00:02.000Z"),
    });

    assert.equal(reclaimed?.id, task.id);
    assert.equal(reclaimed?.claimedBy, "agent-new");
    assert.equal(reclaimed?.attemptCount, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore rejects completion after the Agent lease expires", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-stale-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask({
      title: "Do not accept stale results",
      repository: "monitor-agents",
    });
    store.claimTask({
      agentId: "agent-stale",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:00:00.000Z"),
      leaseMs: 1_000,
    });

    assert.equal(
      store.completeTask(
        task.id,
        "agent-stale",
        "Late result",
        new Date("2026-08-04T00:00:02.000Z"),
      ),
      null,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
