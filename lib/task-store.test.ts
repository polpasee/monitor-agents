import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("TaskStore updates editable details while a task is Todo", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-edit-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask({
      title: "Old title",
      description: "Old description",
      repository: "monitor-agents",
    });
    const updatedAt = new Date("2026-09-04T01:00:00.000Z");
    const updated = store.updateTodoTaskDetails(
      task.id,
      {
        title: "  New title  ",
        description: "  New description  ",
        repository: "  cacti-api  ",
      },
      updatedAt,
    );

    assert.deepEqual(updated, {
      ...task,
      title: "New title",
      description: "New description",
      repository: "cacti-api",
      updatedAt: updatedAt.toISOString(),
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore rejects a stale Todo edit after another connection claims it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-edit-race-"));
  const path = join(directory, "tasks.sqlite");
  const editorStore = new TaskStore(path);
  const agentStore = new TaskStore(path);

  try {
    const task = editorStore.createTask({
      title: "Keep this title",
      description: "Keep this description",
      repository: "monitor-agents",
    });
    assert.equal(editorStore.getTask(task.id)?.status, "todo");

    const claimed = agentStore.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: new Date("2026-09-04T01:00:00.000Z"),
    });
    const staleUpdate = editorStore.updateTodoTaskDetails(task.id, {
      title: "Stale title",
      description: "Stale description",
      repository: "cacti-api",
    });

    assert.equal(claimed?.id, task.id);
    assert.equal(staleUpdate, null);
    assert.equal(editorStore.getTask(task.id)?.status, "in-progress");
    assert.equal(editorStore.getTask(task.id)?.title, "Keep this title");
    assert.equal(
      editorStore.getTask(task.id)?.description,
      "Keep this description",
    );
    assert.equal(editorStore.getTask(task.id)?.repository, "monitor-agents");
  } finally {
    agentStore.close();
    editorStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore deletes tasks in every status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-delete-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    for (const status of [
      "todo",
      "in-progress",
      "review",
      "done",
      "failed",
    ] as const) {
      const task = store.createTask({
        title: `Delete ${status} task`,
        repository: "monitor-agents",
      });
      const currentTask =
        status === "todo"
          ? task
          : store.updateTaskStatus(task.id, status);

      assert.deepEqual(store.deleteTask(task.id), currentTask);
      assert.equal(store.getTask(task.id), null);
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore returns null when deleting a missing task", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "monitor-task-delete-missing-"),
  );
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    assert.equal(store.deleteTask("missing-task"), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "TaskStore deletes a task after another connection claims it",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "monitor-task-delete-race-"));
    const path = join(directory, "tasks.sqlite");
    const editorStore = new TaskStore(path);
    const agentStore = new TaskStore(path);

    try {
      const task = editorStore.createTask({
        title: "Agent is claiming this task",
        repository: "monitor-agents",
      });
      const claimed = agentStore.claimTask({
        agentId: "agent-1",
        repositories: ["monitor-agents"],
        now: new Date("2026-09-05T01:00:00.000Z"),
      });

      assert.equal(claimed?.id, task.id);
      assert.deepEqual(editorStore.deleteTask(task.id), claimed);
      assert.equal(editorStore.getTask(task.id), null);
    } finally {
      agentStore.close();
      editorStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
        agentRunId: "claude:session-1",
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
    assert.equal(completed?.agentRunId, "claude:session-1");
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

async function completedWith(
  resultText: string,
  completion?: { pullRequestNumber?: number; summary?: string },
) {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-pr-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));
  try {
    const task = store.createTask({
      title: "Open a pull request",
      repository: "monitor-agents",
    });
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:00:00.000Z"),
      leaseMs: 600_000,
    });
    const completed = store.completeTask(
      task.id,
      "agent-1",
      resultText,
      new Date("2026-08-04T00:01:00.000Z"),
      undefined,
      completion,
    );
    assert.deepEqual(store.getTask(task.id), completed);
    return completed;
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("TaskStore stores the pull request number and summary an agent reports", async () => {
  const completed = await completedWith("Tests passed", {
    pullRequestNumber: 42,
    summary: "  Did X\n",
  });

  assert.equal(completed?.pullRequestNumber, 42);
  assert.equal(completed?.summary, "Did X");
  assert.equal(completed?.result, "Tests passed");
});

test("TaskStore reads the pull request number from the result when none is sent", async () => {
  const fromUrl = await completedWith(
    "3 file(s) changed on task/x.\nPull request: https://github.com/o/r/pull/20",
  );
  assert.equal(fromUrl?.pullRequestNumber, 20);
  assert.equal(fromUrl?.summary, null);

  const fromMention = await completedWith(
    "PR #7 merged via https://github.com/o/r/pull/9",
  );
  assert.equal(fromMention?.pullRequestNumber, 7);

  const prose = await completedWith(
    "No code change needed - already shipped in PR #1998",
  );
  assert.equal(prose?.pullRequestNumber, null);
  assert.equal((await completedWith("see PR #0"))?.pullRequestNumber, null);
  assert.equal((await completedWith("PR #0 opened"))?.pullRequestNumber, null);

  const reported = await completedWith(
    "PR #7 merged via https://github.com/o/r/pull/9",
    { pullRequestNumber: 11 },
  );
  assert.equal(reported?.pullRequestNumber, 11);
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
      claimed_by, claimed_at, result, created_at, updated_at
    ) VALUES
    (
      'legacy-1', 'Old task', '', 'monitor-agents', 'in-progress', 0,
      'agent-1', '2026-08-04T00:01:00.000Z', NULL,
      '2026-08-04T00:00:00.000Z', '2026-08-04T00:02:00.000Z'
    ),
    (
      'legacy-2', 'Finished task', '', 'monitor-agents', 'done', 0,
      'agent-1', '2026-08-04T00:01:00.000Z', 'PR #5 https://github.com/o/r/pull/5 - open',
      '2026-08-04T00:00:00.000Z', '2026-08-04T00:09:00.000Z'
    ),
    (
      'legacy-3', 'Never claimed', '', 'monitor-agents', 'done', 0,
      NULL, NULL, NULL,
      '2026-08-04T00:00:00.000Z', '2026-08-04T00:09:00.000Z'
    );
  `);
  legacy.close();

  const store = new TaskStore(path);
  try {
    const task = store.getTask("legacy-1");
    assert.equal(task?.usedTokens, null);
    assert.equal(task?.sessionId, null);
    assert.equal(task?.agentRunId, null);
    assert.equal(task?.pullRequestNumber, null);
    assert.equal(task?.summary, null);
    assert.equal(store.getTask("legacy-2")?.pullRequestNumber, 5);
    assert.deepEqual(task?.statusHistory, [
      { status: "todo", at: "2026-08-04T00:00:00.000Z" },
      { status: "in-progress", at: "2026-08-04T00:01:00.000Z" },
    ]);

    // A finished task kept its claim timestamp, so the run time it spent
    // in-progress must not be booked to the status it ended on.
    assert.deepEqual(store.getTask("legacy-2")?.statusHistory, [
      { status: "todo", at: "2026-08-04T00:00:00.000Z" },
      { status: "in-progress", at: "2026-08-04T00:01:00.000Z" },
      { status: "done", at: "2026-08-04T00:09:00.000Z" },
    ]);
    assert.deepEqual(store.getTask("legacy-3")?.statusHistory, [
      { status: "todo", at: "2026-08-04T00:00:00.000Z" },
      { status: "done", at: "2026-08-04T00:09:00.000Z" },
    ]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore adds a retry's tokens to what earlier attempts spent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-retry-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask({
      title: "Fails once, then succeeds",
      repository: "monitor-agents",
    });

    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:00:00.000Z"),
      leaseMs: 600_000,
    });
    assert.equal(
      store.heartbeatTask(
        task.id,
        "agent-1",
        new Date("2026-08-04T00:01:00.000Z"),
        600_000,
        { usedTokens: 30_000 },
      )?.usedTokens,
      30_000,
    );

    // Sending the task back to Todo banks what the first attempt spent.
    store.updateTaskStatus(task.id, "todo", new Date("2026-08-04T00:02:00.000Z"));
    assert.equal(store.getTask(task.id)?.usedTokens, null);

    store.claimTask({
      agentId: "agent-2",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:03:00.000Z"),
      leaseMs: 600_000,
    });
    const completed = store.completeTask(
      task.id,
      "agent-2",
      "Done",
      new Date("2026-08-04T00:05:00.000Z"),
      { usedTokens: 12_000 },
    );

    assert.equal(completed?.usedTokens, 42_000);
    assert.equal(completed?.attemptCount, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore banks an expired attempt's tokens before the next one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-expired-tokens-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask({
      title: "Lease expires mid-run",
      repository: "monitor-agents",
    });
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:00:00.000Z"),
      leaseMs: 1_000,
    });
    store.heartbeatTask(
      task.id,
      "agent-1",
      new Date("2026-08-04T00:00:00.500Z"),
      1_000,
      { usedTokens: 5_000 },
    );

    store.claimTask({
      agentId: "agent-2",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:01:00.000Z"),
      leaseMs: 600_000,
    });
    assert.equal(
      store.heartbeatTask(
        task.id,
        "agent-2",
        new Date("2026-08-04T00:02:00.000Z"),
        600_000,
        { usedTokens: 1_500 },
      )?.usedTokens,
      6_500,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore upgrades a database that has run details but no carry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-carry-"));
  const path = join(directory, "tasks.sqlite");
  const partial = new DatabaseSync(path);
  partial.exec(`
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
      session_id TEXT,
      model TEXT,
      effort TEXT,
      used_tokens INTEGER,
      status_history TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  partial.close();

  const store = new TaskStore(path);
  try {
    const task = store.createTask({
      title: "Reported before the carry column existed",
      repository: "monitor-agents",
    });
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:00:00.000Z"),
      leaseMs: 600_000,
    });

    // Every write names `carried_tokens`, so a half-upgraded database would
    // fail here rather than at the next release.
    assert.equal(
      store.heartbeatTask(
        task.id,
        "agent-1",
        new Date("2026-08-04T00:01:00.000Z"),
        600_000,
        { usedTokens: 7_000 },
      )?.usedTokens,
      7_000,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore reopens an already migrated database without losing history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-reopen-"));
  const path = join(directory, "tasks.sqlite");

  const first = new TaskStore(path);
  const task = first.createTask(
    { title: "Survives a restart", repository: "monitor-agents" },
    new Date("2026-08-04T00:00:00.000Z"),
  );
  first.updateTaskStatus(
    task.id,
    "done",
    new Date("2026-08-04T00:02:00.000Z"),
  );
  first.close();

  const second = new TaskStore(path);
  try {
    assert.deepEqual(second.getTask(task.id)?.statusHistory, [
      { status: "todo", at: "2026-08-04T00:00:00.000Z" },
      { status: "done", at: "2026-08-04T00:02:00.000Z" },
    ]);
  } finally {
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
