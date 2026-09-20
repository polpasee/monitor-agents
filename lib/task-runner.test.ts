import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanTask } from "./kanban.ts";
import {
  buildTaskPrompt,
  formatCompletionResult,
  maxResultLength,
  parseClaudeOutput,
  parseClaudeRunMetadata,
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
  sessionId: null,
  agentRunId: null,
  model: null,
  effort: null,
  usedTokens: null,
  statusHistory: [],
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

test("parseClaudeRunMetadata reads the session, model, and tokens mid-run", () => {
  const stdout = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "5c8f0c1e",
      model: "claude-opus-5[1m]",
    }),
    "not json",
    JSON.stringify({
      type: "assistant",
      request_id: "req_1",
      parent_tool_use_id: null,
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 800,
          output_tokens: 20,
        },
      },
    }),
    // A subagent's turn names its own model, which is not the task's model.
    JSON.stringify({
      type: "assistant",
      request_id: "req_2",
      parent_tool_use_id: "toolu_1",
      message: {
        id: "msg-2",
        model: "claude-haiku-4-5-20251001",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ].join("\n");

  assert.deepEqual(parseClaudeRunMetadata(stdout), {
    sessionId: "5c8f0c1e",
    model: "claude-opus-5",
    usedTokens: 985,
    // The run the board should open on, named the way the topology names it.
    agentRunId: "claude:5c8f0c1e",
  });
});

test("parseClaudeRunMetadata counts a retried request once", () => {
  const event = (outputTokens: number) =>
    JSON.stringify({
      type: "assistant",
      request_id: "req_1",
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        usage: { input_tokens: 100, output_tokens: outputTokens },
      },
    });

  assert.equal(
    parseClaudeRunMetadata([event(10), event(30)].join("\n")).usedTokens,
    130,
  );
});

test("parseClaudeRunMetadata prefers the final result event's usage", () => {
  const stdout = [
    JSON.stringify({
      type: "assistant",
      request_id: "req_1",
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 400,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 2_000,
        output_tokens: 90,
      },
    }),
  ].join("\n");

  assert.equal(parseClaudeRunMetadata(stdout).usedTokens, 2_590);
});

test("parseClaudeRunMetadata totals every model the run billed", () => {
  // `usage` covers one turn; `modelUsage` is the running total for the whole
  // session, so a run that spawned a subagent is only complete in the latter.
  const stdout = [
    JSON.stringify({
      type: "result",
      result_index: 0,
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: {
        "claude-opus-5": {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 80,
        },
      },
    }),
    JSON.stringify({
      type: "result",
      result_index: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: {
        "claude-opus-5": {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 80,
        },
        "claude-haiku-4-5-20251001": {
          inputTokens: 40,
          outputTokens: 60,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 0,
        },
      },
    }),
  ].join("\n");

  assert.equal(parseClaudeRunMetadata(stdout).usedTokens, 1_700);
});

test("parseClaudeRunMetadata reports nothing for an empty stream", () => {
  assert.deepEqual(parseClaudeRunMetadata(""), {});
});
