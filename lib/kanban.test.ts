import assert from "node:assert/strict";
import test from "node:test";

import {
  findTaskAgent,
  formatBangkokTime,
  formatDuration,
  formatStatusAge,
  formatTokenCount,
  isKanbanTaskEditable,
  isKanbanStatus,
  kanbanPriorityOf,
  kanbanRepositories,
  kanbanStatusDurations,
  kanbanStatusSince,
  kanbanStatuses,
  parseKanbanPriority,
  parseKanbanTaskPatch,
  parseTaskRunMetadata,
  type KanbanTask,
} from "./kanban.ts";
import type { AgentRun } from "./telemetry.ts";

const tasks: KanbanTask[] = [
  {
    id: "task-1",
    title: "Add repository filter",
    description: "",
    repository: "monitor-agents",
    status: "todo",
    priority: 0,
    claimedBy: null,
    claimedAt: null,
    leaseUntil: null,
    result: null,
    lastError: null,
    attemptCount: 0,
    sessionId: null,
    agentRunId: null,
    model: null,
    effort: null,
    usedTokens: null,
    pullRequestNumber: null,
    summary: null,
    statusHistory: [],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  },
  {
    id: "task-2",
    title: "Review API",
    description: "",
    repository: "cacti-api",
    status: "review",
    priority: 0,
    claimedBy: null,
    claimedAt: null,
    leaseUntil: null,
    result: null,
    lastError: null,
    attemptCount: 0,
    sessionId: null,
    agentRunId: null,
    model: null,
    effort: null,
    usedTokens: null,
    pullRequestNumber: null,
    summary: null,
    statusHistory: [],
    createdAt: "2026-08-04T01:00:00.000Z",
    updatedAt: "2026-08-04T01:00:00.000Z",
  },
];

test("isKanbanStatus accepts only board states", () => {
  assert.equal(isKanbanStatus("in-progress"), true);
  assert.equal(isKanbanStatus("review-queue"), true);
  assert.equal(isKanbanStatus("failed"), false);
  assert.equal(isKanbanStatus("unknown"), false);
});

test("isKanbanTaskEditable allows only Todo tasks", () => {
  assert.deepEqual(
    kanbanStatuses.map((status) =>
      isKanbanTaskEditable({ ...tasks[0], status: status.id }),
    ),
    [true, false, false, false, false],
  );
});

test("parseKanbanTaskPatch preserves the exact status payload", () => {
  assert.deepEqual(parseKanbanTaskPatch({ status: "review" }), {
    status: "review",
  });
  assert.equal(parseKanbanTaskPatch({ status: "unknown" }), null);
  assert.equal(parseKanbanTaskPatch({ status: "todo", title: "Extra" }), null);
});

test("parseKanbanTaskPatch validates exact editable task details", () => {
  assert.deepEqual(
    parseKanbanTaskPatch({
      title: "  Update the board  ",
      repository: "  monitor-agents  ",
      description: "  Keep Todo editable.  ",
    }),
    {
      title: "Update the board",
      repository: "monitor-agents",
      description: "Keep Todo editable.",
    },
  );
  assert.equal(
    parseKanbanTaskPatch({ title: "Partial", repository: "monitor-agents" }),
    null,
  );
  assert.equal(
    parseKanbanTaskPatch({
      title: "Extra",
      repository: "monitor-agents",
      description: "",
      priority: 1,
    }),
    null,
  );
  assert.deepEqual(
    parseKanbanTaskPatch({
      title: "Urgent fix",
      repository: "monitor-agents",
      description: "",
      priority: "high",
    }),
    {
      title: "Urgent fix",
      repository: "monitor-agents",
      description: "",
      priority: 1,
    },
  );
  assert.equal(
    parseKanbanTaskPatch({
      title: "Unknown level",
      repository: "monitor-agents",
      description: "",
      priority: "urgent",
    }),
    null,
  );
  assert.equal(
    parseKanbanTaskPatch({
      title: "Extra",
      repository: "monitor-agents",
      description: "",
      priority: "high",
      status: "done",
    }),
    null,
  );
  assert.equal(
    parseKanbanTaskPatch({
      title: " ",
      repository: "monitor-agents",
      description: "",
    }),
    null,
  );
  assert.equal(
    parseKanbanTaskPatch({
      title: "x".repeat(201),
      repository: "monitor-agents",
      description: "",
    }),
    null,
  );
  assert.equal(
    parseKanbanTaskPatch({
      title: "Too long description",
      repository: "monitor-agents",
      description: "x".repeat(5_001),
    }),
    null,
  );
});

test("kanbanRepositories returns sorted unique repository names", () => {
  assert.deepEqual(
    kanbanRepositories([...tasks, { ...tasks[0], id: "task-3" }]),
    ["cacti-api", "monitor-agents"],
  );
});
const task: KanbanTask = {
  id: "task-1",
  title: "Track state time",
  description: "",
  repository: "monitor-agents",
  status: "review",
  priority: 0,
  claimedBy: null,
  claimedAt: null,
  leaseUntil: null,
  result: null,
  lastError: null,
  attemptCount: 1,
  sessionId: "session-1",
  agentRunId: null,
  model: "claude-opus-5",
  effort: "high",
  usedTokens: 12_345,
  pullRequestNumber: null,
  summary: null,
  statusHistory: [
    { status: "todo", at: "2026-08-04T00:00:00.000Z" },
    { status: "in-progress", at: "2026-08-04T00:01:00.000Z" },
    { status: "todo", at: "2026-08-04T00:02:00.000Z" },
    { status: "in-progress", at: "2026-08-04T00:02:30.000Z" },
    { status: "review", at: "2026-08-04T00:04:30.000Z" },
  ],
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:04:30.000Z",
};

test("kanbanStatusDurations sums every visit to a status", () => {
  assert.deepEqual(
    kanbanStatusDurations(task, new Date("2026-08-04T00:05:30.000Z")),
    [
      { status: "todo", milliseconds: 90_000 },
      { status: "in-progress", milliseconds: 180_000 },
      { status: "review", milliseconds: 60_000 },
    ],
  );
});

test("kanbanStatusDurations stops the clock once a task has finished", () => {
  const finished: KanbanTask = {
    ...task,
    status: "done",
    statusHistory: [
      { status: "todo", at: "2026-08-04T00:00:00.000Z" },
      { status: "in-progress", at: "2026-08-04T00:01:00.000Z" },
      { status: "done", at: "2026-08-04T00:04:00.000Z" },
    ],
  };

  // Viewed weeks later, the finished status must not report the wait as work.
  assert.deepEqual(
    kanbanStatusDurations(finished, new Date("2026-09-20T00:00:00.000Z")),
    [
      { status: "todo", milliseconds: 60_000 },
      { status: "in-progress", milliseconds: 180_000 },
    ],
  );

  // A status the task is still sitting in keeps counting.
  assert.deepEqual(
    kanbanStatusDurations(
      { ...finished, statusHistory: finished.statusHistory.slice(0, 2) },
      new Date("2026-08-04T00:06:00.000Z"),
    ),
    [
      { status: "todo", milliseconds: 60_000 },
      { status: "in-progress", milliseconds: 300_000 },
    ],
  );
});

test("kanbanStatusDurations reports nothing without history", () => {
  assert.deepEqual(kanbanStatusDurations({ ...task, statusHistory: [] }), []);
  // An older server never sent the field at all.
  assert.deepEqual(
    kanbanStatusDurations({
      ...task,
      statusHistory: undefined as unknown as KanbanTask["statusHistory"],
    }),
    [],
  );
});

test("kanbanStatusSince reports when the task entered its current status", () => {
  assert.equal(kanbanStatusSince(task), "2026-08-04T00:04:30.000Z");
  // A re-entered status counts from its latest visit.
  assert.equal(
    kanbanStatusSince({ ...task, status: "in-progress" }),
    "2026-08-04T00:02:30.000Z",
  );
});

test("kanbanStatusSince falls back to the last update without a matching entry", () => {
  assert.equal(
    kanbanStatusSince({ ...task, statusHistory: [] }),
    task.updatedAt,
  );
  assert.equal(
    kanbanStatusSince({
      ...task,
      statusHistory: undefined as unknown as KanbanTask["statusHistory"],
    }),
    task.updatedAt,
  );
  assert.equal(kanbanStatusSince({ ...task, status: "done" }), task.updatedAt);
});

test("formatDuration scales from seconds to days", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(3_900_000), "1h 5m");
  assert.equal(formatDuration(93_600_000), "1d 2h");
});

test("formatBangkokTime converts to GMT+7", () => {
  assert.equal(formatBangkokTime("2026-09-12T07:30:00Z"), "Sep 12, 14:30");
  assert.equal(formatBangkokTime("2026-09-12T20:15:00Z"), "Sep 13, 03:15");
});

test("formatStatusAge counts minutes, hours and days within a week", () => {
  const since = "2026-09-12T07:30:00.000Z";
  const at = (milliseconds: number) =>
    formatStatusAge(since, new Date(Date.parse(since) + milliseconds));
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  assert.equal(at(0), "Last 1 Minute");
  assert.equal(at(119_999), "Last 1 Minute");
  assert.equal(at(2 * minute), "Last 2 Minutes");
  assert.equal(at(59 * minute), "Last 59 Minutes");
  assert.equal(at(hour), "Last 1 Hour");
  assert.equal(at(2 * hour), "Last 2 Hours");
  assert.equal(at(23 * hour + 59 * minute), "Last 23 Hours");
  assert.equal(at(day), "Last 1 Day");
  assert.equal(at(2 * day), "Last 2 Days");
  assert.equal(at(6 * day + 23 * hour), "Last 6 Days");
  assert.equal(at(7 * day), "Sep 12, 14:30");
  assert.equal(at(-5 * minute), "Last 1 Minute");
});

test("formatTokenCount keeps the badge short", () => {
  assert.equal(formatTokenCount(940), "940");
  assert.equal(formatTokenCount(12_345), "12.3k");
  assert.equal(formatTokenCount(2_500_000), "2.50M");
});

test("parseTaskRunMetadata accepts only the fields an agent reports", () => {
  assert.deepEqual(parseTaskRunMetadata({ agentId: "agent-1" }), {});
  assert.deepEqual(
    parseTaskRunMetadata({
      sessionId: "session-1",
      model: "claude-opus-5",
      effort: "high",
      usedTokens: 4_200,
    }),
    {
      sessionId: "session-1",
      model: "claude-opus-5",
      effort: "high",
      usedTokens: 4_200,
    },
  );
  // An agent that serialises "not reported" as null keeps what is stored.
  assert.deepEqual(
    parseTaskRunMetadata({ sessionId: null, usedTokens: null }),
    {},
  );
  assert.equal(parseTaskRunMetadata({ usedTokens: -1 }), null);
  assert.equal(parseTaskRunMetadata({ usedTokens: 1.5 }), null);
  assert.equal(parseTaskRunMetadata({ usedTokens: "4200" }), null);
  assert.equal(parseTaskRunMetadata({ sessionId: "" }), null);
  assert.equal(parseTaskRunMetadata({ model: "m".repeat(201) }), null);
});

function agent(
  id: string,
  parentId: string | null,
  overrides: Partial<AgentRun> = {},
): AgentRun {
  return {
    id,
    parentId,
    name: id,
    provider: "claude",
    model: "claude-opus-5",
    effort: null,
    status: "running",
    task: "",
    spawnMethod: parentId ? "native" : "root",
    cwd: "/repo",
    startedAt: "2026-09-20T10:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-09-20T10:05:00.000Z",
    tokenUsage: {
      input: 0,
      output: 0,
      cached: 0,
      contextUsed: 0,
      contextLimit: 0,
    },
    costUsd: null,
    toolCalls: null,
    ...overrides,
  };
}

// The collector cuts the prompt short, so only the opening of the title is left.
function implementerPrompt(opening: string): string {
  return `You are the IMPLEMENTER for ONE task. Do the work yourself. **Task:** \`${opening}…`;
}

test("findTaskAgent picks the orchestrator that was handed the task", () => {
  const root = agent("claude:session-1", null);
  const agents = [
    root,
    agent("claude:session-1:a1", root.id, { task: implementerPrompt("know") }),
    agent("claude:session-1:a2", root.id, { task: implementerPrompt("topo") }),
    agent("claude:session-1:a3", root.id, { task: implementerPrompt("user") }),
  ];

  // One session works several tasks at once, so each title finds its own run.
  assert.equal(
    findTaskAgent(
      { id: "task-1", agentRunId: null, sessionId: "session-1", title: "`knowledge_base` : multi select" },
      agents,
    )?.id,
    "claude:session-1:a1",
  );
  assert.equal(
    findTaskAgent(
      { id: "task-1", agentRunId: null, sessionId: "session-1", title: "`topology` : group the results" },
      agents,
    )?.id,
    "claude:session-1:a2",
  );
});

test("findTaskAgent prefers a live orchestrator over an abandoned one", () => {
  const root = agent("claude:session-1", null);
  const abandoned = agent("claude:session-1:a1", root.id, {
    status: "aborted",
    task: implementerPrompt("know"),
    startedAt: "2026-09-20T11:00:00.000Z",
  });
  const retried = agent("claude:session-1:a2", root.id, {
    status: "completed",
    task: implementerPrompt("know"),
  });

  assert.equal(
    findTaskAgent(
      { id: "task-1", agentRunId: null, sessionId: "session-1", title: "`knowledge_base` : multi select" },
      [root, abandoned, retried],
    )?.id,
    "claude:session-1:a2",
  );
});

test("findTaskAgent takes a reported run over anything it could infer", () => {
  const root = agent("claude:session-1", null);
  const guessed = agent("claude:session-1:a1", root.id, {
    task: implementerPrompt("know"),
  });
  // A reported run is exact, so it wins even from another session's tree.
  const reported = agent("claude:session-9:a7", "claude:session-9");

  assert.equal(
    findTaskAgent(
      {
        id: "task-1",
        agentRunId: "claude:session-9:a7",
        sessionId: "session-1",
        title: "`knowledge_base` : multi select",
      },
      [root, guessed, reported],
    ),
    reported,
  );

  // A run that is no longer in the snapshot leaves the inference to work.
  assert.equal(
    findTaskAgent(
      {
        id: "task-1",
        agentRunId: "claude:session-9:gone",
        sessionId: "session-1",
        title: "`knowledge_base` : multi select",
      },
      [root, guessed],
    ),
    guessed,
  );
});

test("findTaskAgent trusts a task id in the prompt over the title", () => {
  const root = agent("claude:session-1", null);
  const named = agent("claude:session-1:a1", root.id, {
    task: "Kanban task 3f6a1c2e-9b44-4d1e-8f0a-77c2b1d5e900. Do the work.",
  });
  const lookalike = agent("claude:session-1:a2", root.id, {
    task: implementerPrompt("know"),
  });

  assert.equal(
    findTaskAgent(
      {
        id: "3f6a1c2e-9b44-4d1e-8f0a-77c2b1d5e900",
        agentRunId: null,
        sessionId: "session-1",
        title: "`knowledge_base` : multi select",
      },
      [root, lookalike, named],
    )?.id,
    // Both candidates are running, so only the id breaks the tie.
    "claude:session-1:a1",
  );
});

test("findTaskAgent falls back to the session's own run", () => {
  const root = agent("claude:session-1", null);
  const other = agent("claude:session-1:a1", root.id, {
    task: implementerPrompt("topo"),
  });
  const grandchild = agent("claude:session-1:a2", "claude:session-1:a1", {
    task: implementerPrompt("know"),
  });

  // A task no orchestrator claims, and a nested worker, both leave the session.
  assert.equal(
    findTaskAgent(
      { id: "task-1", agentRunId: null, sessionId: "session-1", title: "`knowledge_base` : multi select" },
      [root, other, grandchild],
    ),
    root,
  );
  assert.equal(
    findTaskAgent({ id: "task-1", agentRunId: null, sessionId: "session-2", title: "anything" }, [root]),
    null,
  );
  assert.equal(
    findTaskAgent({ id: "task-1", agentRunId: null, sessionId: null, title: "anything" }, [root]),
    null,
  );
});


test("parseKanbanPriority defaults to Normal and accepts only known levels", () => {
  assert.equal(parseKanbanPriority(undefined), 0);
  assert.equal(parseKanbanPriority(null), 0);
  assert.equal(parseKanbanPriority("low"), -1);
  assert.equal(parseKanbanPriority("normal"), 0);
  assert.equal(parseKanbanPriority("high"), 1);
  for (const value of ["urgent", 1, "High", ""]) {
    assert.equal(parseKanbanPriority(value), null);
  }
});

test("kanbanPriorityOf reads the level from the sign of the stored number", () => {
  assert.equal(kanbanPriorityOf(2).id, "high");
  assert.equal(kanbanPriorityOf(-5).id, "low");
  assert.equal(kanbanPriorityOf(0).id, "normal");
  assert.equal(kanbanPriorityOf(1).label, "High");
});
