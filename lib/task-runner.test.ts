import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanTask } from "./kanban.ts";
import {
  buildTaskPrompt,
  formatCompletionResult,
  maxResultLength,
  parseClaudeOutput,
  repositoryDirectoryName,
  stagePathspecs,
  taskBranchName,
  truncate,
} from "./task-runner.ts";

const task: KanbanTask = {
  id: "3f6a1c2e-9b44-4d1e-8f0a-77c2b1d5e900",
  title: "Add repository filter to the board",
  description: "Filter tasks by repository name.",
  repository: "polpasee/monitor-agents",
  status: "todo",
  priority: 0,
  claimedBy: null,
  claimedAt: null,
  leaseUntil: null,
  result: null,
  lastError: null,
  attemptCount: 0,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

test("repositoryDirectoryName keeps only the checkout directory segment", () => {
  assert.equal(repositoryDirectoryName("polpasee/monitor-agents"), "monitor-agents");
  assert.equal(repositoryDirectoryName("monitor-agents"), "monitor-agents");
  assert.equal(repositoryDirectoryName(" IP-CORE-Transport/cacti-api "), "cacti-api");
  assert.equal(repositoryDirectoryName("   "), "");
});

test("taskBranchName builds a stable git-safe branch", () => {
  assert.equal(
    taskBranchName(task),
    "task/add-repository-filter-to-the-board-3f6a1c2e",
  );
  assert.equal(
    taskBranchName({ id: "abc-123", title: "!!! ???" }),
    "task/task-abc123",
  );
  assert.equal(
    taskBranchName(task, 3),
    "task/add-repository-filter-to-the-board-3f6a1c2e-a3",
  );
});

test("buildTaskPrompt carries the task and forbids git publishing", () => {
  const prompt = buildTaskPrompt(task);
  assert.match(prompt, /Add repository filter to the board/);
  assert.match(prompt, /Filter tasks by repository name\./);
  assert.match(prompt, /Do not run git commit/);
});

test("parseClaudeOutput reads the final result event of a stream", () => {
  const stdout = [
    '{"type":"system","subtype":"init"}',
    'not json',
    '{"type":"assistant","message":{"content":[]}}',
    '{"type":"result","is_error":false,"result":"Added the filter."}',
  ].join("\n");
  assert.deepEqual(parseClaudeOutput(stdout), {
    result: "Added the filter.",
    isError: false,
  });
});

test("parseClaudeOutput reports an errored run and falls back to raw output", () => {
  assert.equal(
    parseClaudeOutput('{"type":"result","is_error":true,"result":"Ran out of turns."}')
      .isError,
    true,
  );
  assert.deepEqual(parseClaudeOutput("plain text failure"), {
    result: "plain text failure",
    isError: false,
  });
});

test("formatCompletionResult reports changes, the branch, and the pull request", () => {
  assert.equal(
    formatCompletionResult({
      summary: "Added the filter.",
      branch: "task/add-filter-3f6a1c2e",
      pullRequestUrl: "https://github.com/polpasee/monitor-agents/pull/20",
      changedFiles: 3,
    }),
    [
      "3 file(s) changed on task/add-filter-3f6a1c2e.",
      "Pull request: https://github.com/polpasee/monitor-agents/pull/20",
      "",
      "Added the filter.",
    ].join("\n"),
  );
});

test("formatCompletionResult states when a run produced no changes", () => {
  const result = formatCompletionResult({
    summary: "Nothing needed changing.",
    branch: "task/no-op-1234",
    changedFiles: 0,
  });
  assert.match(result, /^No file changes were produced\./);
  assert.doesNotMatch(result, /Pull request/);
});

test("stagePathspecs excludes agent tool droppings from the commit", () => {
  assert.deepEqual(stagePathspecs([".serena", ".claude/", " "]), [
    ".",
    ":(exclude).serena/**",
    ":(exclude).claude/**",
    ":(exclude).serena",
    ":(exclude).claude",
  ]);
  assert.deepEqual(stagePathspecs([]), ["."]);
});

test("truncate keeps results inside the API limit", () => {
  const long = "x".repeat(maxResultLength + 500);
  const shortened = truncate(long, maxResultLength);
  assert.equal(shortened.length, maxResultLength);
  assert.match(shortened, /…$/);
});
