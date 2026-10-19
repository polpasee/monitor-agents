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
      priority: 2,
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

    const details = {
      title: "New title",
      description: "New description",
      repository: "cacti-api",
    };
    assert.equal(
      store.updateTodoTaskDetails(task.id, { ...details, priority: 1 })
        ?.priority,
      1,
    );
    assert.equal(store.updateTodoTaskDetails(task.id, details)?.priority, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore stores the requested model and effort, defaulting to Inherit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-requested-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const inherited = store.createTask({
      title: "Inherit",
      repository: "monitor-agents",
    });
    assert.equal(inherited.requestedModel, null);
    assert.equal(inherited.requestedEffort, null);

    const task = store.createTask({
      title: "Pick a model",
      repository: "cacti-api",
      requestedModel: "claude-opus",
      requestedEffort: "high",
    });
    assert.equal(task.requestedModel, "claude-opus");
    assert.equal(task.requestedEffort, "high");
    assert.deepEqual(store.getTask(task.id), task);

    const details = {
      title: "Pick a model",
      description: "",
      repository: "cacti-api",
    };
    const kept = store.updateTodoTaskDetails(task.id, details);
    assert.equal(kept?.requestedModel, "claude-opus");
    assert.equal(kept?.requestedEffort, "high");

    const changed = store.updateTodoTaskDetails(task.id, {
      ...details,
      requestedModel: "codex-luna",
    });
    assert.equal(changed?.requestedModel, "codex-luna");
    assert.equal(changed?.requestedEffort, "high");

    const reset = store.updateTodoTaskDetails(task.id, {
      ...details,
      requestedModel: null,
      requestedEffort: null,
    });
    assert.equal(reset?.requestedModel, null);
    assert.equal(reset?.requestedEffort, null);

    // The run's actual model is reported separately and leaves the request alone.
    store.updateTodoTaskDetails(task.id, {
      ...details,
      requestedModel: "claude-sonnet",
      requestedEffort: "low",
    });
    const claimed = store.claimTask({
      agentId: "agent-1",
      repositories: ["cacti-api"],
      metadata: { model: "claude-opus-5-5", effort: "max" },
    });
    assert.equal(claimed?.id, task.id);
    assert.equal(claimed?.model, "claude-opus-5-5");
    assert.equal(claimed?.effort, "max");
    assert.equal(claimed?.requestedModel, "claude-sonnet");
    assert.equal(claimed?.requestedEffort, "low");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore stores the review model and effort apart from the coding pair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-review-requested-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const inherited = store.createTask({
      title: "Inherit",
      repository: "monitor-agents",
    });
    assert.equal(inherited.requestedReviewModel, null);
    assert.equal(inherited.requestedReviewEffort, null);

    const task = store.createTask({
      title: "Pick a reviewer",
      repository: "cacti-api",
      requestedModel: "claude-opus",
      requestedEffort: "high",
      requestedReviewModel: "codex-sol",
      requestedReviewEffort: "low",
    });
    assert.equal(task.requestedModel, "claude-opus");
    assert.equal(task.requestedEffort, "high");
    assert.equal(task.requestedReviewModel, "codex-sol");
    assert.equal(task.requestedReviewEffort, "low");
    assert.deepEqual(store.getTask(task.id), task);

    const details = {
      title: "Pick a reviewer",
      description: "",
      repository: "cacti-api",
    };
    const kept = store.updateTodoTaskDetails(task.id, {
      ...details,
      requestedModel: "codex-luna",
    });
    assert.equal(kept?.requestedModel, "codex-luna");
    assert.equal(kept?.requestedReviewModel, "codex-sol");
    assert.equal(kept?.requestedReviewEffort, "low");

    const changed = store.updateTodoTaskDetails(task.id, {
      ...details,
      requestedReviewModel: "claude-haiku",
    });
    assert.equal(changed?.requestedModel, "codex-luna");
    assert.equal(changed?.requestedEffort, "high");
    assert.equal(changed?.requestedReviewModel, "claude-haiku");
    assert.equal(changed?.requestedReviewEffort, "low");

    const reset = store.updateTodoTaskDetails(task.id, {
      ...details,
      requestedReviewModel: null,
      requestedReviewEffort: null,
    });
    assert.equal(reset?.requestedReviewModel, null);
    assert.equal(reset?.requestedReviewEffort, null);
    assert.equal(reset?.requestedEffort, "high");
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
      priority: 1,
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
    assert.equal(editorStore.getTask(task.id)?.priority, 0);
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
      "review-queue",
      "review",
      "done",
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

test("TaskStore claims a task once and completes it into review-queue", async () => {
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
      "review-queue",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore moves a failed task to review-queue with its error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-fail-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const task = store.createTask(
      { title: "Fails", repository: "monitor-agents" },
      new Date("2026-08-04T00:00:00.000Z"),
    );
    store.claimTask({
      agentId: "codex-1",
      repositories: ["monitor-agents"],
      now: new Date("2026-08-04T00:01:00.000Z"),
      leaseMs: 600_000,
    });
    const failed = store.failTask(
      task.id,
      "codex-1",
      "  Tests failed  ",
      new Date("2026-08-04T00:02:00.000Z"),
    );

    assert.equal(failed?.status, "review-queue");
    assert.equal(failed?.lastError, "Tests failed");
    assert.equal(failed?.leaseUntil, null);
    assert.deepEqual(failed?.statusHistory.at(-1), {
      status: "review-queue",
      at: "2026-08-04T00:02:00.000Z",
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore lists and claims higher priority first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-priority-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    const levels = [
      { title: "Low", priority: -1, at: "2026-08-04T00:00:00.000Z" },
      { title: "High", priority: 1, at: "2026-08-04T00:01:00.000Z" },
      { title: "Normal", priority: 0, at: "2026-08-04T00:02:00.000Z" },
    ];
    for (const { title, priority, at } of levels) {
      store.createTask(
        { title, repository: "monitor-agents", priority },
        new Date(at),
      );
    }

    assert.deepEqual(
      store.listTasks().map((task) => task.title),
      ["High", "Normal", "Low"],
    );
    store.updateBoardSettings({ codingLimit: 3 });
    const now = new Date("2026-08-04T00:03:00.000Z");
    const claimed = [1, 2, 3].map(
      (index) =>
        store.claimTask({
          agentId: `agent-${index}`,
          repositories: ["monitor-agents"],
          now,
        })?.title,
    );
    assert.deepEqual(claimed, ["High", "Normal", "Low"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore keeps board limits, defaulting to two each", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-board-settings-"));
  const path = join(directory, "tasks.sqlite");
  const store = new TaskStore(path);

  try {
    assert.deepEqual(store.getBoardSettings(), { codingLimit: 2, reviewLimit: 2 });
    assert.deepEqual(store.updateBoardSettings({ codingLimit: 4 }), {
      codingLimit: 4,
      reviewLimit: 2,
    });
    assert.deepEqual(store.updateBoardSettings({ reviewLimit: 1 }), {
      codingLimit: 4,
      reviewLimit: 1,
    });
  } finally {
    store.close();
  }

  // Reopening an existing database keeps the stored row.
  const reopened = new TaskStore(path);
  try {
    assert.deepEqual(reopened.getBoardSettings(), { codingLimit: 4, reviewLimit: 1 });
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore claims nothing once the coding limit is reached", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-limit-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    for (const title of ["One", "Two", "Three"]) {
      store.createTask({ title, repository: "monitor-agents" });
    }
    const claim = (now = new Date("2026-08-04T00:00:00.000Z")) =>
      store.claimTask({
        agentId: "agent-1",
        repositories: ["monitor-agents"],
        now,
        leaseMs: 60_000,
      });

    store.updateBoardSettings({ codingLimit: 1 });
    const first = claim();
    assert.equal(first?.title, "One");
    assert.equal(claim(), null);

    store.updateBoardSettings({ codingLimit: 2 });
    assert.equal(claim()?.title, "Two");
    assert.equal(claim(), null);

    // A finished task frees its slot.
    store.updateTaskStatus(first!.id, "review-queue");
    assert.equal(claim()?.title, "Three");

    // An expired lease is re-queued before the limit is counted.
    store.updateBoardSettings({ codingLimit: 1 });
    assert.equal(
      claim(new Date("2026-08-04T00:05:00.000Z"))?.status,
      "in-progress",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore skips tasks whose model is excluded from a claim", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-exclude-"));
  const now = new Date("2026-08-04T01:00:00.000Z");
  let store: TaskStore;
  let created = 0;
  // One fresh store per case; created_at is spaced so the queue order is fixed.
  const setup = (cards: { title: string; requestedModel?: string | null }[]) => {
    store = new TaskStore(join(directory, `tasks-${created}.sqlite`));
    store.updateBoardSettings({ codingLimit: 5 });
    return cards.map((card) =>
      store.createTask(
        { ...card, repository: "monitor-agents" },
        new Date(Date.UTC(2026, 7, 4, 0, created++)),
      ),
    );
  };
  const claim = (filter: { excludeModels?: string[]; inheritModel?: string } = {}) =>
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now,
      ...filter,
    });

  try {
    await t.test("no filter keeps the head of the queue, NULL model included", () => {
      setup([{ title: "Null" }, { title: "Codex", requestedModel: "codex-sol" }]);
      assert.equal(claim()?.title, "Null");
      assert.equal(claim({ excludeModels: [] })?.title, "Codex");
      store.close();
    });

    await t.test("an excluded head is skipped and stays todo", () => {
      const [codex] = setup([
        { title: "Codex", requestedModel: "codex-sol" },
        { title: "Opus", requestedModel: "claude-opus" },
      ]);
      assert.equal(claim({ excludeModels: ["codex-sol"] })?.title, "Opus");
      assert.equal(store.getTask(codex.id)?.status, "todo");
      assert.equal(store.getTask(codex.id)?.attemptCount, 0);
      store.close();
    });

    await t.test("Inherit tasks take inheritModel", () => {
      const [nullModel, inherit] = setup([
        { title: "Null" },
        { title: "Inherit", requestedModel: "inherit" },
        { title: "Codex", requestedModel: "codex-sol" },
        { title: "Opus", requestedModel: "claude-opus" },
      ]);
      const drained = { excludeModels: ["claude-opus"], inheritModel: "claude-opus" };
      assert.equal(claim(drained)?.title, "Codex");
      assert.equal(claim(drained), null);
      assert.equal(store.getTask(nullModel.id)?.status, "todo");
      assert.equal(store.getTask(inherit.id)?.status, "todo");

      const other = { excludeModels: ["claude-opus"], inheritModel: "codex-sol" };
      assert.equal(claim(other)?.title, "Null");
      assert.equal(claim(other)?.title, "Inherit");
      store.close();
    });

    await t.test("an Inherit task is claimable when no inheritModel is sent", () => {
      setup([
        { title: "Opus", requestedModel: "claude-opus" },
        { title: "Null" },
        { title: "Inherit", requestedModel: "inherit" },
      ]);
      assert.equal(claim({ excludeModels: ["claude-opus"] })?.title, "Null");
      assert.equal(claim({ excludeModels: ["claude-opus"] })?.title, "Inherit");
      store.close();
    });

    await t.test("every task excluded claims nothing and changes nothing", () => {
      const tasks = setup([
        { title: "Codex", requestedModel: "codex-sol" },
        { title: "Null" },
      ]);
      assert.equal(
        claim({ excludeModels: ["codex-sol", "claude-opus"], inheritModel: "claude-opus" }),
        null,
      );
      assert.deepEqual(store.listTasks(), tasks);
      store.close();
    });

    await t.test("the coding limit still stops a claim", () => {
      setup([
        { title: "Opus", requestedModel: "claude-opus" },
        { title: "Codex", requestedModel: "codex-sol" },
      ]);
      store.updateBoardSettings({ codingLimit: 1 });
      assert.equal(claim()?.title, "Opus");
      assert.equal(claim({ excludeModels: ["claude-opus"] }), null);
      store.close();
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore records the run a claim names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-claim-run-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));

  try {
    store.createTask({ title: "Run", repository: "monitor-agents" });
    const claimed = store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      metadata: { sessionId: "session-1", agentRunId: "claude:session-1:worker" },
    });
    assert.equal(claimed?.sessionId, "session-1");
    assert.equal(claimed?.agentRunId, "claude:session-1:worker");
    assert.equal(claimed?.usedTokens, null);

    store.updateTaskStatus(claimed!.id, "todo");
    // A new attempt names its own run, or none; the last attempt's run is gone.
    const reclaimed = store.claimTask({
      agentId: "agent-2",
      repositories: ["monitor-agents"],
      metadata: { sessionId: "session-2" },
    });
    assert.equal(reclaimed?.sessionId, "session-2");
    assert.equal(reclaimed?.agentRunId, null);
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
      { status: "review-queue", at: "2026-08-04T00:03:00.000Z" },
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

test("TaskStore stores workflow steps from a heartbeat, complete and fail, replacing the list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-steps-"));
  const path = join(directory, "tasks.sqlite");
  const store = new TaskStore(path);
  const step = (number: number, usedTokens: number) => ({
    step: number,
    model: "codex-astra",
    effort: "high",
    usedTokens,
    startedAt: "2026-08-04T00:00:00.000Z",
    endedAt: "2026-08-04T00:04:12.000Z",
  });

  try {
    for (const finish of ["complete", "fail"] as const) {
      const task = store.createTask({
        title: `Report steps then ${finish}`,
        repository: "monitor-agents",
      });
      assert.deepEqual(task.workflowSteps, []);
      store.claimTask({
        agentId: "agent-1",
        repositories: ["monitor-agents"],
        now: new Date("2026-08-04T00:00:00.000Z"),
        leaseMs: 600_000,
      });
      const at = (seconds: number) =>
        new Date(`2026-08-04T00:00:${seconds}.000Z`);

      const first = store.heartbeatTask(task.id, "agent-1", at(10), 600_000, {
        workflowSteps: [step(1, 510_000)],
      });
      assert.deepEqual(first?.workflowSteps, [step(1, 510_000)]);

      // The reporter resends its whole list, so the new one replaces the old.
      const second = store.heartbeatTask(task.id, "agent-1", at(20), 600_000, {
        workflowSteps: [step(1, 510_000), step(2, 2_120_000)],
      });
      assert.deepEqual(second?.workflowSteps, [
        step(1, 510_000),
        step(2, 2_120_000),
      ]);

      // A report without the field leaves the stored list alone.
      const third = store.heartbeatTask(task.id, "agent-1", at(30), 600_000, {
        usedTokens: 5,
      });
      assert.deepEqual(third?.workflowSteps, second?.workflowSteps);
      assert.deepEqual(
        store.heartbeatTask(task.id, "agent-1", at(31), 600_000)?.workflowSteps,
        second?.workflowSteps,
      );

      const finished =
        finish === "complete"
          ? store.completeTask(task.id, "agent-1", "done", at(40), {
              workflowSteps: [step(3, 3_110_000)],
            })
          : store.failTask(task.id, "agent-1", "boom", at(40), {
              workflowSteps: [step(3, 3_110_000)],
            });
      assert.deepEqual(finished?.workflowSteps, [step(3, 3_110_000)]);
      assert.deepEqual(store.getTask(task.id)?.workflowSteps, [
        step(3, 3_110_000),
      ]);

      // Sending an empty list is a report too, and clears the steps.
      store.updateTaskStatus(task.id, "todo", at(45));
      store.claimTask({
        agentId: "agent-1",
        repositories: ["monitor-agents"],
        now: at(46),
        leaseMs: 600_000,
      });
      // A retry's claim keeps what the earlier attempt reported.
      assert.deepEqual(store.getTask(task.id)?.workflowSteps, [
        step(3, 3_110_000),
      ]);
      assert.deepEqual(
        store.heartbeatTask(task.id, "agent-1", at(47), 600_000, {
          workflowSteps: [],
        })?.workflowSteps,
        [],
      );
      store.updateTaskStatus(task.id, "done", at(50));
    }
  } finally {
    store.close();
  }

  // A column that holds something other than a JSON array reads as no steps.
  const raw = new DatabaseSync(path);
  raw.exec("UPDATE tasks SET workflow_steps = 'not json'");
  raw.close();
  const reopened = new TaskStore(path);
  try {
    assert.deepEqual(
      reopened.listTasks().map((task) => task.workflowSteps),
      [[], []],
    );
  } finally {
    reopened.close();
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
    assert.equal(task?.requestedModel, null);
    assert.equal(task?.requestedEffort, null);
    assert.equal(task?.requestedReviewModel, null);
    assert.equal(task?.requestedReviewEffort, null);
    assert.deepEqual(task?.workflowSteps, []);
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

test("TaskStore moves failed tasks of a database that still allows failed to review-queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-review-queue-"));
  const path = join(directory, "tasks.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      repository TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('todo', 'in-progress', 'review', 'done', 'failed')
      ),
      priority INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      claimed_at TEXT,
      lease_until TEXT,
      result TEXT,
      last_error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      agent_run_id TEXT,
      model TEXT,
      effort TEXT,
      used_tokens INTEGER,
      carried_tokens INTEGER NOT NULL DEFAULT 0,
      pull_request_number INTEGER,
      summary TEXT,
      status_history TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX tasks_queue
      ON tasks (status, repository, priority DESC, created_at ASC);
    INSERT INTO tasks (
      id, title, repository, status, last_error, status_history,
      created_at, updated_at
    ) VALUES
    (
      'old-failed', 'Broke', 'monitor-agents', 'failed', 'Tests failed',
      json_array(
        json_object('status', 'todo', 'at', '2026-08-04T00:00:00.000Z'),
        json_object('status', 'failed', 'at', '2026-08-04T00:02:00.000Z')
      ),
      '2026-08-04T00:00:00.000Z', '2026-08-04T00:02:00.000Z'
    ),
    (
      'old-done', 'Shipped', 'monitor-agents', 'done', NULL,
      json_array(
        json_object('status', 'todo', 'at', '2026-08-04T00:00:00.000Z'),
        json_object('status', 'done', 'at', '2026-08-04T00:03:00.000Z')
      ),
      '2026-08-04T00:00:00.000Z', '2026-08-04T00:03:00.000Z'
    );
  `);
  old.close();

  const store = new TaskStore(path);
  try {
    const failed = store.getTask("old-failed");
    assert.equal(failed?.status, "review-queue");
    assert.equal(failed?.lastError, "Tests failed");
    assert.deepEqual(failed?.statusHistory, [
      { status: "todo", at: "2026-08-04T00:00:00.000Z" },
      { status: "review-queue", at: "2026-08-04T00:02:00.000Z" },
    ]);
    assert.equal(store.getTask("old-done")?.status, "done");

    assert.equal(
      store.updateTaskStatus("old-done", "review-queue")?.status,
      "review-queue",
    );
  } finally {
    store.close();
  }

  const reopened = new DatabaseSync(path);
  try {
    assert.throws(() =>
      reopened.exec("UPDATE tasks SET status = 'failed' WHERE id = 'old-done'"),
    );
    assert.deepEqual(
      reopened
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND sql IS NOT NULL")
        .all()
        .map((row) => row.name),
      ["tasks_queue"],
    );
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore keeps the review score a report sends and leaves it when one does not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-score-"));
  const path = join(directory, "tasks.sqlite");
  const store = new TaskStore(path);
  try {
    const task = store.createTask({ title: "Scored", repository: "monitor-agents" });
    assert.equal(task.reviewScore, null);
    const at = (seconds: number) => new Date(`2026-08-04T00:00:${seconds}.000Z`);
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: at(10),
      leaseMs: 600_000,
    });

    assert.equal(
      store.heartbeatTask(task.id, "agent-1", at(20), 600_000, { reviewScore: 7.5 })
        ?.reviewScore,
      7.5,
    );
    // A report without a score leaves the stored one alone, 0 included.
    assert.equal(
      store.heartbeatTask(task.id, "agent-1", at(30), 600_000, { usedTokens: 5 })
        ?.reviewScore,
      7.5,
    );
    assert.equal(
      store.completeTask(task.id, "agent-1", "done", at(40), { reviewScore: 0 })
        ?.reviewScore,
      0,
    );
    assert.equal(store.getTask(task.id)?.reviewScore, 0);
  } finally {
    store.close();
  }

  // A database from before the column existed gains it, empty.
  const raw = new DatabaseSync(path);
  raw.exec(`
    DROP TRIGGER tasks_performance_snapshot;
    ALTER TABLE tasks DROP COLUMN review_score;
  `);
  raw.close();
  const reopened = new TaskStore(path);
  try {
    assert.deepEqual(reopened.listTasks().map((task) => task.reviewScore), [null]);
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore keeps a scored task's performance after the task is deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-performance-"));
  const path = join(directory, "tasks.sqlite");
  const steps = [
    {
      step: 3,
      model: "claude-opus-5-5",
      effort: "low",
      usedTokens: 10,
      inputTokens: 1,
      cacheWriteTokens: 2,
      cacheReadTokens: 3,
      outputTokens: 4,
      startedAt: null,
      endedAt: null,
    },
  ];
  const store = new TaskStore(path);
  try {
    const scored = store.createTask({ title: "Scored", repository: "monitor-agents" });
    const unscored = store.createTask({ title: "Unscored", repository: "monitor-agents" });
    const at = (seconds: number) => new Date(`2026-08-04T00:00:${seconds}.000Z`);
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: at(10),
      leaseMs: 600_000,
    });
    store.heartbeatTask(scored.id, "agent-1", at(20), 600_000, {
      model: "opus",
      effort: "low",
      workflowSteps: steps,
      reviewScore: 7,
    });
    store.completeTask(scored.id, "agent-1", "done", at(30), { reviewScore: 9 });

    assert.deepEqual(store.listPerformanceSnapshots(), [
      {
        taskId: scored.id,
        model: "opus",
        effort: "low",
        reviewScore: 9,
        workflowSteps: steps,
        recordedAt: at(30).toISOString(),
        title: "Scored",
        pullRequestNumber: null,
        attemptCount: 1,
        workType: null,
        filesChanged: null,
        additions: null,
        deletions: null,
        testFilesChanged: null,
        hasMigration: null,
        hasNewDependency: null,
      },
    ]);

    // A re-run on another model starts unscored and keeps the last run's
    // snapshot until it is scored itself.
    store.updateTaskStatus(scored.id, "todo", at(40));
    const rerun = store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: at(50),
      leaseMs: 600_000,
      metadata: { model: "gpt-6.1-sol" },
    });
    assert.equal(rerun?.id, scored.id);
    assert.equal(rerun?.reviewScore, null);
    assert.deepEqual(
      store.listPerformanceSnapshots().map((row) => [row.model, row.reviewScore]),
      [["opus", 9]],
    );
    store.heartbeatTask(scored.id, "agent-1", at(55), 600_000, { reviewScore: 6 });
    assert.deepEqual(
      store.listPerformanceSnapshots().map((row) => [row.model, row.reviewScore]),
      [["gpt-6.1-sol", 6]],
    );

    store.deleteTask(scored.id);
    store.deleteTask(unscored.id);
    assert.equal(store.listPerformanceSnapshots()[0]?.taskId, scored.id);
  } finally {
    store.close();
  }

  // Scored tasks from before the table existed are copied in on start.
  const raw = new DatabaseSync(path);
  raw.exec("DROP TABLE performance_snapshots");
  raw
    .prepare(`
      INSERT INTO tasks (id, title, repository, status, requested_model, review_score, created_at, updated_at)
      VALUES ('old', 'Old', 'monitor-agents', 'done', 'claude-sonnet', 6, ?, ?)
    `)
    .run("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  raw.close();
  const reopened = new TaskStore(path);
  try {
    assert.deepEqual(
      reopened.listPerformanceSnapshots().map((row) => [row.taskId, row.model, row.reviewScore]),
      [["old", "claude-sonnet", 6]],
    );
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore snapshots the work type, PR number and size a run reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-perf-size-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));
  const at = (seconds: number) => new Date(`2026-08-04T00:00:${seconds}.000Z`);
  try {
    const task = store.createTask({
      title: "Add SFP column",
      repository: "monitor-agents",
      workType: "table-column",
    });
    assert.equal(task.workType, "table-column");
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: at(10),
      leaseMs: 600_000,
    });
    store.heartbeatTask(task.id, "agent-1", at(20), 600_000, {
      reviewScore: 8,
      filesChanged: 3,
      additions: 40,
      deletions: 2,
      testFilesChanged: 1,
      hasMigration: false,
      hasNewDependency: true,
    });
    const snapshot = () => {
      const [row] = store.listPerformanceSnapshots();
      return {
        title: row.title,
        pullRequestNumber: row.pullRequestNumber,
        attemptCount: row.attemptCount,
        workType: row.workType,
        filesChanged: row.filesChanged,
        additions: row.additions,
        deletions: row.deletions,
        testFilesChanged: row.testFilesChanged,
        hasMigration: row.hasMigration,
        hasNewDependency: row.hasNewDependency,
      };
    };
    const reported = {
      title: "Add SFP column",
      pullRequestNumber: null,
      attemptCount: 1,
      workType: "table-column",
      filesChanged: 3,
      additions: 40,
      deletions: 2,
      testFilesChanged: 1,
      hasMigration: false,
      hasNewDependency: true,
    };
    assert.deepEqual(snapshot(), reported);
    assert.equal(store.getTask(task.id)?.hasNewDependency, true);

    // A report without the size keeps it; a later PR number and size refresh the row.
    store.heartbeatTask(task.id, "agent-1", at(30), 600_000, { usedTokens: 5 });
    assert.deepEqual(snapshot(), reported);
    store.completeTask(
      task.id,
      "agent-1",
      "done",
      at(40),
      { additions: 55, hasMigration: true },
      { pullRequestNumber: 42 },
    );
    assert.deepEqual(snapshot(), {
      ...reported,
      pullRequestNumber: 42,
      additions: 55,
      hasMigration: true,
    });

    // A claim nulls the score, so the retry writes no snapshot until it is scored.
    store.updateTaskStatus(task.id, "todo", at(50));
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: at(55),
      leaseMs: 600_000,
      metadata: { filesChanged: 9 },
    });
    assert.equal(store.getTask(task.id)?.attemptCount, 2);
    assert.deepEqual(snapshot(), {
      ...reported,
      pullRequestNumber: 42,
      additions: 55,
      hasMigration: true,
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore boots on a snapshot table from before the work columns existed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-perf-old-"));
  const path = join(directory, "tasks.sqlite");
  new TaskStore(path).close();

  const raw = new DatabaseSync(path);
  raw.exec(`
    DROP TRIGGER tasks_performance_snapshot;
    DROP TABLE performance_snapshots;
    CREATE TABLE performance_snapshots (
      task_id TEXT PRIMARY KEY,
      model TEXT,
      effort TEXT,
      review_score REAL NOT NULL,
      workflow_steps TEXT NOT NULL DEFAULT '[]',
      recorded_at TEXT NOT NULL
    );
    INSERT INTO performance_snapshots VALUES
      ('gone-1', 'opus', 'low', 7, '[{"step":3,"model":"opus","effort":"low","usedTokens":10,"startedAt":null,"endedAt":null}]', '2026-08-01T00:00:00.000Z'),
      ('gone-2', NULL, NULL, 9.5, '[]', '2026-08-02T00:00:00.000Z');
  `);
  raw.close();

  const store = new TaskStore(path);
  try {
    const empty = {
      title: null,
      pullRequestNumber: null,
      attemptCount: null,
      workType: null,
      filesChanged: null,
      additions: null,
      deletions: null,
      testFilesChanged: null,
      hasMigration: null,
      hasNewDependency: null,
    };
    assert.deepEqual(store.listPerformanceSnapshots(), [
      {
        taskId: "gone-1",
        model: "opus",
        effort: "low",
        reviewScore: 7,
        workflowSteps: [
          { step: 3, model: "opus", effort: "low", usedTokens: 10, startedAt: null, endedAt: null },
        ],
        recordedAt: "2026-08-01T00:00:00.000Z",
        ...empty,
      },
      {
        taskId: "gone-2",
        model: null,
        effort: null,
        reviewScore: 9.5,
        workflowSteps: [],
        recordedAt: "2026-08-02T00:00:00.000Z",
        ...empty,
      },
    ]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore refreshes a scored task's snapshot when its Todo details are edited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-perf-rename-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));
  const at = (seconds: number) => new Date(`2026-08-04T00:00:${seconds}.000Z`);
  try {
    const task = store.createTask({ title: "Old title", repository: "monitor-agents" });
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: at(10),
      leaseMs: 600_000,
    });
    store.completeTask(task.id, "agent-1", "done", at(20), { reviewScore: 8 });
    store.updateTaskStatus(task.id, "todo", at(30));
    store.updateTodoTaskDetails(
      task.id,
      { title: "New title", description: "", repository: "monitor-agents" },
      at(40),
    );

    const [snapshot] = store.listPerformanceSnapshots();
    assert.equal(snapshot.title, "New title");
    assert.equal(snapshot.recordedAt, at(40).toISOString());
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("TaskStore clears the last attempt's size on a retry claim but keeps its PR number", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-task-perf-retry-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));
  const at = (seconds: number) => new Date(`2026-08-04T00:00:${seconds}.000Z`);
  const claim = (seconds: number, metadata?: { model?: string; filesChanged?: number; hasMigration?: boolean }) =>
    store.claimTask({
      agentId: "agent-1",
      repositories: ["monitor-agents"],
      now: at(seconds),
      leaseMs: 600_000,
      metadata,
    });
  const size = (row: {
    filesChanged?: number | null;
    additions?: number | null;
    deletions?: number | null;
    testFilesChanged?: number | null;
    hasMigration?: boolean | null;
    hasNewDependency?: boolean | null;
  } | null | undefined) => [
    row?.filesChanged,
    row?.additions,
    row?.deletions,
    row?.testFilesChanged,
    row?.hasMigration,
    row?.hasNewDependency,
  ];
  try {
    const task = store.createTask({ title: "Retried", repository: "monitor-agents" });
    claim(10, { model: "opus" });
    store.completeTask(
      task.id,
      "agent-1",
      "done",
      at(20),
      {
        reviewScore: 5,
        filesChanged: 10,
        additions: 100,
        deletions: 20,
        testFilesChanged: 2,
        hasMigration: true,
        hasNewDependency: false,
      },
      { pullRequestNumber: 42 },
    );

    // (a) A claim without sizes clears them; the next score snapshots them empty.
    store.updateTaskStatus(task.id, "todo", at(30));
    claim(35, { model: "gpt-6.1-sol" });
    const retried = store.getTask(task.id);
    assert.deepEqual(size(retried), [null, null, null, null, null, null]);
    // (c) The PR number survives the claim.
    assert.equal(retried?.pullRequestNumber, 42);
    store.heartbeatTask(task.id, "agent-1", at(40), 600_000, { reviewScore: 7 });
    const [snapshot] = store.listPerformanceSnapshots();
    assert.deepEqual(
      [snapshot.model, snapshot.reviewScore, snapshot.pullRequestNumber],
      ["gpt-6.1-sol", 7, 42],
    );
    assert.deepEqual(size(snapshot), [null, null, null, null, null, null]);

    // (b) A claim that sends sizes stores them, and they reach the snapshot.
    store.updateTaskStatus(task.id, "todo", at(45));
    claim(50, { filesChanged: 3, hasMigration: false });
    assert.deepEqual(size(store.getTask(task.id)), [3, null, null, null, false, null]);
    store.heartbeatTask(task.id, "agent-1", at(55), 600_000, { reviewScore: 9 });
    assert.deepEqual(size(store.listPerformanceSnapshots()[0]), [3, null, null, null, false, null]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
