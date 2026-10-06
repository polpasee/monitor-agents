import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanTask } from "./kanban.ts";
import {
  buildTaskPrompt,
  claudeArgs,
  codexArgs,
  formatCompletionResult,
  latestCodexSlug,
  maxResultLength,
  parseClaudeOutput,
  parseClaudeRunMetadata,
  parseCodexOutput,
  parseCodexRunMetadata,
  pullRequestNumberFromUrl,
  repositoryDirectoryName,
  runnerModel,
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
  requestedModel: null,
  requestedEffort: null,
  requestedReviewModel: null,
  requestedReviewEffort: null,
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
  assert.match(prompt, /\/api\/agent\/tasks/);
  assert.match(prompt, /"repository":"polpasee\/monitor-agents"/);
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

test("pullRequestNumberFromUrl reads the number from a pull request URL", () => {
  assert.equal(
    pullRequestNumberFromUrl("https://github.com/polpasee/monitor-agents/pull/20"),
    20,
  );
  assert.equal(pullRequestNumberFromUrl(undefined), undefined);
  assert.equal(
    pullRequestNumberFromUrl("https://github.com/polpasee/monitor-agents"),
    undefined,
  );
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

// Recorded from `codex exec --json` (codex-cli 0.159.2).
const codexSuccess = [
  '{"type":"thread.started","thread_id":"01a0f64e-f903-7903-a145-186c455cc4f8"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":19404,"cached_input_tokens":7168,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join("\n");

const codexRejection = JSON.stringify({
  type: "error",
  status: 400,
  error: {
    type: "invalid_request_error",
    message:
      "The 'gpt-6.1-astra' model is not supported when using Codex with a ChatGPT account.",
  },
});

const codexFailure = [
  JSON.stringify({
    type: "thread.started",
    thread_id: "01a0f64f-30b8-71e1-b164-6e06ec2409da",
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "error",
      message:
        "Model metadata for `gpt-6.1-astra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
    },
  }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "error", message: codexRejection }),
  JSON.stringify({ type: "turn.failed", error: { message: codexRejection } }),
].join("\n");

// Reasoning tokens are already part of output_tokens (gpt-6-luna probe).
const codexLunaUsage =
  '{"type":"turn.completed","usage":{"input_tokens":18324,"cached_input_tokens":7936,"cache_write_input_tokens":0,"output_tokens":19,"reasoning_output_tokens":12}}';

test("runnerModel maps each Kanban model to its provider and CLI name", () => {
  assert.deepEqual(runnerModel(null), { provider: "claude", cli: null });
  assert.deepEqual(runnerModel("claude-fable"), { provider: "claude", cli: "fable" });
  assert.deepEqual(runnerModel("claude-opus"), { provider: "claude", cli: "opus" });
  assert.deepEqual(runnerModel("claude-sonnet"), { provider: "claude", cli: "sonnet" });
  assert.deepEqual(runnerModel("claude-haiku"), { provider: "claude", cli: "haiku" });
  assert.deepEqual(runnerModel("codex-astra"), {
    provider: "codex",
    family: "astra",
    fallback: "gpt-6-astra",
  });
  assert.deepEqual(runnerModel("codex-sol"), {
    provider: "codex",
    family: "sol",
    fallback: "gpt-6.1-sol",
  });
  assert.deepEqual(runnerModel("codex-luna"), {
    provider: "codex",
    family: "luna",
    fallback: "gpt-6-luna",
  });
  assert.throws(() => runnerModel("codex-nova"), /Unknown requested model/);
  // Selectable in the dialogs, but no runner provider exists for them yet.
  assert.throws(() => runnerModel("deepseek"), /Unknown requested model/);
  assert.throws(() => runnerModel("glm"), /Unknown requested model/);
});

// `codex debug models` trimmed to the fields the runner reads.
const codexCatalog = JSON.stringify({
  models: [
    { slug: "gpt-6.1-sol", visibility: "list", upgrade: null },
    { slug: "gpt-6-astra", visibility: "list", upgrade: null },
    { slug: "gpt-6-sol", visibility: "list", upgrade: null },
    { slug: "gpt-6-luna", visibility: "list", upgrade: null },
    { slug: "gpt-reserve", visibility: "hide", upgrade: null },
    { slug: "gpt-5.6-sol", visibility: "list", upgrade: null },
    { slug: "gpt-5.6-terra", visibility: "list", upgrade: null },
    { slug: "gpt-5.6-luna", visibility: "list", upgrade: null },
    { slug: "gpt-5.5", visibility: "list", upgrade: { model: "gpt-6.1-sol" } },
    { slug: "codex-auto-review", visibility: "hide", upgrade: null },
  ],
});

function catalog(...models: { slug: string; visibility?: string; upgrade?: unknown }[]) {
  return JSON.stringify({
    models: models.map((model) => ({ visibility: "list", upgrade: null, ...model })),
  });
}

test("latestCodexSlug picks each family's newest listed slug", () => {
  assert.equal(latestCodexSlug(codexCatalog, "sol", "x"), "gpt-6.1-sol");
  assert.equal(latestCodexSlug(codexCatalog, "astra", "x"), "gpt-6-astra");
  assert.equal(latestCodexSlug(codexCatalog, "luna", "x"), "gpt-6-luna");
});

test("latestCodexSlug follows a newer release and skips hidden or retiring ones", () => {
  assert.equal(
    latestCodexSlug(catalog({ slug: "gpt-6-astra" }, { slug: "gpt-6.1-astra" }), "astra", "x"),
    "gpt-6.1-astra",
  );
  assert.equal(
    latestCodexSlug(
      catalog({ slug: "gpt-6-astra" }, { slug: "gpt-6.1-astra", visibility: "hide" }),
      "astra",
      "x",
    ),
    "gpt-6-astra",
  );
  assert.equal(
    latestCodexSlug(
      catalog({ slug: "gpt-6-astra" }, { slug: "gpt-6.1-astra", upgrade: { model: "gpt-7-astra" } }),
      "astra",
      "x",
    ),
    "gpt-6-astra",
  );
});

test("latestCodexSlug compares versions as numbers", () => {
  assert.equal(
    latestCodexSlug(catalog({ slug: "gpt-6.10-sol" }, { slug: "gpt-6.9-sol" }), "sol", "x"),
    "gpt-6.10-sol",
  );
});

test("latestCodexSlug falls back when the catalog is unreadable or has no match", () => {
  assert.equal(latestCodexSlug("not json", "sol", "gpt-6.1-sol"), "gpt-6.1-sol");
  assert.equal(latestCodexSlug('{"models":[]}', "sol", "gpt-6.1-sol"), "gpt-6.1-sol");
  assert.equal(latestCodexSlug("null", "sol", "gpt-6.1-sol"), "gpt-6.1-sol");
  assert.equal(latestCodexSlug(codexCatalog, "nova", "gpt-6-nova"), "gpt-6-nova");
});

test("claudeArgs keeps today's command and adds model and effort when asked", () => {
  assert.deepEqual(claudeArgs("p", null, null), [
    "-p",
    "p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ]);
  assert.deepEqual(claudeArgs("p", "haiku", "low").slice(-4), [
    "--model",
    "haiku",
    "--effort",
    "low",
  ]);
  const effortOnly = claudeArgs("p", null, "xhigh");
  assert.deepEqual(effortOnly.slice(-2), ["--effort", "xhigh"]);
  assert.ok(!effortOnly.includes("--model"));
});

test("codexArgs runs a stored, sandboxed exec with network in the worktree", () => {
  const args = codexArgs("p", "gpt-6.1-sol", "xhigh", "/wt");
  assert.deepEqual(args, [
    "exec",
    "--json",
    "-s",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-m",
    "gpt-6.1-sol",
    "-c",
    'model_reasoning_effort="xhigh"',
    "-C",
    "/wt",
    "p",
  ]);
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  const noEffort = codexArgs("p", "gpt-6-luna", null, "/wt");
  assert.ok(!noEffort.some((arg) => arg.startsWith("model_reasoning_effort=")));
  assert.ok(!noEffort.includes("--ephemeral"));
  assert.ok(!noEffort.includes("--skip-git-repo-check"));
  assert.equal(noEffort.at(-1), "p");
});

test("parseCodexOutput reads the agent's answer", () => {
  assert.deepEqual(parseCodexOutput(codexSuccess), { result: "OK", isError: false });
});

test("parseCodexOutput reports a failed turn with its message", () => {
  const parsed = parseCodexOutput(codexFailure);
  assert.equal(parsed.isError, true);
  assert.match(parsed.result, /not supported/);
});

test("parseCodexOutput does not treat warnings or retried errors as failure", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "error", message: "Model metadata not found." },
    }),
    JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "Done." },
    }),
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
  ].join("\n");
  assert.deepEqual(parseCodexOutput(stdout), { result: "Done.", isError: false });
});

test("parseCodexOutput keeps the last agent message", () => {
  const message = (text: string) =>
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  const stdout = [
    message("Looking at the board."),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution" } }),
    message("Added the filter."),
  ].join("\n");
  assert.equal(parseCodexOutput(stdout).result, "Added the filter.");
});

test("parseCodexOutput skips noise and falls back to raw output", () => {
  assert.deepEqual(parseCodexOutput(`not json\n{broken\n${codexSuccess}`), {
    result: "OK",
    isError: false,
  });
  assert.deepEqual(parseCodexOutput("plain text failure"), {
    result: "plain text failure",
    isError: false,
  });
  assert.deepEqual(parseCodexOutput(""), { result: "", isError: false });
});

test("parseCodexRunMetadata names the thread the way the topology does", () => {
  const metadata = parseCodexRunMetadata(codexSuccess);
  assert.deepEqual(metadata, {
    sessionId: "01a0f64e-f903-7903-a145-186c455cc4f8",
    agentRunId: "codex:01a0f64e-f903-7903-a145-186c455cc4f8",
    usedTokens: 19_409,
  });
  assert.ok(!("model" in metadata));
});

test("parseCodexRunMetadata reports the thread before any usage arrives", () => {
  const metadata = parseCodexRunMetadata(codexSuccess.split("\n")[0]);
  assert.equal(metadata.sessionId, "01a0f64e-f903-7903-a145-186c455cc4f8");
  assert.equal(metadata.agentRunId, "codex:01a0f64e-f903-7903-a145-186c455cc4f8");
  assert.equal(metadata.usedTokens, undefined);
});

test("parseCodexRunMetadata sums every completed turn without double counting", () => {
  assert.equal(parseCodexRunMetadata(codexLunaUsage).usedTokens, 18_343);
  assert.equal(
    parseCodexRunMetadata([codexSuccess, codexLunaUsage].join("\n")).usedTokens,
    19_409 + 18_343,
  );
  assert.deepEqual(parseCodexRunMetadata(""), {});
});

test("parseClaudeRunMetadata reads a run started with --model haiku", () => {
  const stdout = [
    '{"type":"system","subtype":"init","model":"claude-haiku-4-5-20251001","session_id":"f5655906-c847-4b1d-aea7-554ec8d74abd"}',
    '{"type":"assistant","message":{"id":"msg_011Cfb6ybejjzDNtzCBzb9MZ","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":10,"cache_creation_input_tokens":15071,"cache_read_input_tokens":14263,"output_tokens":4}},"session_id":"f5655906-c847-4b1d-aea7-554ec8d74abd"}',
    '{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"f5655906-c847-4b1d-aea7-554ec8d74abd","modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":10,"outputTokens":40,"cacheReadInputTokens":14263,"cacheCreationInputTokens":15071}}}',
  ].join("\n");
  assert.deepEqual(parseClaudeRunMetadata(stdout), {
    sessionId: "f5655906-c847-4b1d-aea7-554ec8d74abd",
    model: "claude-haiku-4-5-20251001",
    usedTokens: 29_384,
    agentRunId: "claude:f5655906-c847-4b1d-aea7-554ec8d74abd",
  });
});
