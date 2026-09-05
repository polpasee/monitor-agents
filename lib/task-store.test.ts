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
