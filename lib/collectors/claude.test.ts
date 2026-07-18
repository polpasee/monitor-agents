import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectClaudeTelemetry } from "./claude.ts";

test("Claude collector loads only fresh status-line telemetry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-claude-"));
  const cacheFile = join(directory, "usage-status.json");
  const previousDirectory = process.env.CLAUDE_CONFIG_DIR;
  const previousRateLimitsFile = process.env.CLAUDE_RATE_LIMITS_FILE;
  const previousWorkspace = process.env.MONITOR_WORKSPACE;
  const resetAtSeconds = Math.floor(Date.now() / 1_000) + 3_600;

  try {
    process.env.CLAUDE_CONFIG_DIR = directory;
    delete process.env.CLAUDE_RATE_LIMITS_FILE;
    delete process.env.MONITOR_WORKSPACE;
    await mkdir(join(directory, "sessions"));
    await writeFile(
      join(directory, "sessions", "active.json"),
      JSON.stringify({
        sessionId: "active-session",
        cwd: directory,
        status: "running",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    await writeFile(
      cacheFile,
      JSON.stringify({
        blockPercent: 23.5,
        weeklyPercent: 41.2,
        blockResetAt: resetAtSeconds,
        weeklyResetAt: resetAtSeconds + 86_400,
        effort: "high",
        sessionId: "active-session",
        timestamp: Date.now(),
      }),
    );
    const fresh = await collectClaudeTelemetry();
    assert.equal(fresh.agents[0].effort, "high");
    assert.deepEqual(
      fresh.quotaLimits.map((quota) => ({
        id: quota.id,
        period: quota.period,
        usedPercent: quota.usedPercent,
      })),
      [
        {
          id: "claude:quota:primary",
          period: "hour",
          usedPercent: 23.5,
        },
        {
          id: "claude:quota:secondary",
          period: "week",
          usedPercent: 41.2,
        },
      ],
    );

    await writeFile(
      cacheFile,
      JSON.stringify({
        blockPercent: 90,
        weeklyPercent: 90,
        timestamp: Date.now() - 16 * 60 * 1_000,
      }),
    );

    const stale = await collectClaudeTelemetry();
    assert.equal(stale.quotaLimits.length, 0);
    assert.equal(stale.agents[0].effort, null);
  } finally {
    if (previousDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousDirectory;
    }
    if (previousRateLimitsFile === undefined) {
      delete process.env.CLAUDE_RATE_LIMITS_FILE;
    } else {
      process.env.CLAUDE_RATE_LIMITS_FILE = previousRateLimitsFile;
    }
    if (previousWorkspace === undefined) {
      delete process.env.MONITOR_WORKSPACE;
    } else {
      process.env.MONITOR_WORKSPACE = previousWorkspace;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("Claude collector filters the exact workspace before limiting roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-claude-workspace-"));
  const sessionsDirectory = join(directory, "sessions");
  const previousDirectory = process.env.CLAUDE_CONFIG_DIR;
  const previousRateLimitsFile = process.env.CLAUDE_RATE_LIMITS_FILE;
  const previousWorkspace = process.env.MONITOR_WORKSPACE;
  const workspace = "/workspace/repo";
  const now = Date.now();

  try {
    process.env.CLAUDE_CONFIG_DIR = directory;
    delete process.env.CLAUDE_RATE_LIMITS_FILE;
    process.env.MONITOR_WORKSPACE = workspace;
    await mkdir(sessionsDirectory);

    const sessions = [
      {
        sessionId: "other-newest",
        cwd: "/workspace/other",
        status: "running",
        updatedAt: new Date(now).toISOString(),
      },
      {
        sessionId: "nested-newer",
        cwd: `${workspace}/nested`,
        status: "running",
        updatedAt: new Date(now - 1_000).toISOString(),
      },
      {
        sessionId: "matching-newer",
        cwd: workspace,
        status: "running",
        updatedAt: new Date(now - 2_000).toISOString(),
      },
      {
        sessionId: "matching-older",
        cwd: workspace,
        status: "closed",
        updatedAt: new Date(now - 3_000).toISOString(),
      },
      {
        sessionId: "matching-oldest",
        cwd: workspace,
        status: "running",
        updatedAt: new Date(now - 4_000).toISOString(),
      },
    ];

    await Promise.all(
      sessions.map((session) =>
        writeFile(
          join(sessionsDirectory, `${session.sessionId}.json`),
          JSON.stringify({
            ...session,
            startedAt: new Date(now - 60_000).toISOString(),
          }),
        ),
      ),
    );

    const result = await collectClaudeTelemetry();
    assert.deepEqual(
      result.agents.map((agent) => ({ id: agent.id, status: agent.status })),
      [
        { id: "claude:matching-newer", status: "running" },
        { id: "claude:matching-older", status: "completed" },
        { id: "claude:matching-oldest", status: "running" },
      ],
    );
  } finally {
    if (previousDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousDirectory;
    }
    if (previousRateLimitsFile === undefined) {
      delete process.env.CLAUDE_RATE_LIMITS_FILE;
    } else {
      process.env.CLAUDE_RATE_LIMITS_FILE = previousRateLimitsFile;
    }
    if (previousWorkspace === undefined) {
      delete process.env.MONITOR_WORKSPACE;
    } else {
      process.env.MONITOR_WORKSPACE = previousWorkspace;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("Claude collector enriches roots from registry and job state and finds subagents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-claude-rich-"));
  const workspace = "/workspace/repo";
  const sessionId = "rich-session";
  const projectDirectory = join(directory, "projects", "-workspace-repo");
  const subagentsDirectory = join(projectDirectory, sessionId, "subagents");
  const workflowDirectory = join(subagentsDirectory, "workflows", "wf-1");
  const previousDirectory = process.env.CLAUDE_CONFIG_DIR;
  const previousRateLimitsFile = process.env.CLAUDE_RATE_LIMITS_FILE;
  const previousWorkspace = process.env.MONITOR_WORKSPACE;
  const now = Date.now();

  try {
    process.env.CLAUDE_CONFIG_DIR = directory;
    delete process.env.CLAUDE_RATE_LIMITS_FILE;
    process.env.MONITOR_WORKSPACE = workspace;
    await mkdir(join(directory, "sessions"), { recursive: true });
    await mkdir(join(directory, "jobs", "job-rich"), { recursive: true });
    await mkdir(workflowDirectory, { recursive: true });
    await writeFile(
      join(directory, "sessions", "rich.json"),
      JSON.stringify({
        sessionId,
        jobId: "job-rich",
        name: "IPPORTAL",
        pid: process.pid,
        cwd: workspace,
        status: "busy",
        startedAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      }),
    );
    await writeFile(
      join(directory, "jobs", "job-rich", "state.json"),
      JSON.stringify({
        state: "working",
        detail: "Check open PRs",
        respawnFlags: ["--agent", "claude", "--model", "fable", "--effort", "xhigh"],
        fan: [{ id: "wfchild", kind: "workflow", label: "verify:stash0" }],
        createdAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      }),
    );
    await writeFile(join(projectDirectory, `${sessionId}.jsonl`), "");
    await writeFile(join(subagentsDirectory, "agent-nodepth.jsonl"), "");
    await writeFile(
      join(subagentsDirectory, "agent-nodepth.meta.json"),
      JSON.stringify({ agentType: "code-reviewer", description: "Code review" }),
    );
    await writeFile(join(subagentsDirectory, "agent-deep.jsonl"), "");
    await writeFile(
      join(subagentsDirectory, "agent-deep.meta.json"),
      JSON.stringify({ agentType: "worker", spawnDepth: 2 }),
    );
    for (const extra of ["s1", "s2", "s3", "s4", "s5"]) {
      await writeFile(join(subagentsDirectory, `agent-${extra}.jsonl`), "");
      await writeFile(
        join(subagentsDirectory, `agent-${extra}.meta.json`),
        JSON.stringify({ agentType: "worker" }),
      );
    }
    await writeFile(
      join(workflowDirectory, "agent-wfchild.jsonl"),
      `${JSON.stringify({
        type: "user",
        timestamp: new Date(now - 30_000).toISOString(),
        message: { role: "user", content: "Verify the stash entry" },
      })}\n`,
    );
    await writeFile(
      join(workflowDirectory, "agent-wfchild.meta.json"),
      JSON.stringify({ agentType: "workflow-subagent" }),
    );
    const longText =
      "Audit the git branch supersession state in this repository";
    await writeFile(
      join(workflowDirectory, "agent-longtext.jsonl"),
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: longText },
      })}\n`,
    );
    await writeFile(
      join(workflowDirectory, "agent-longtext.meta.json"),
      JSON.stringify({ agentType: "workflow-subagent" }),
    );
    await writeFile(join(workflowDirectory, "agent-wfempty.jsonl"), "");
    await writeFile(
      join(workflowDirectory, "agent-wfempty.meta.json"),
      JSON.stringify({ agentType: "workflow-subagent" }),
    );

    const result = await collectClaudeTelemetry();
    const root = result.agents.find(
      (agent) => agent.id === `claude:${sessionId}`,
    );
    const direct = result.agents.find(
      (agent) => agent.id === `claude:${sessionId}:nodepth`,
    );
    const workflowChild = result.agents.find(
      (agent) => agent.id === `claude:${sessionId}:wfchild`,
    );
    const longTextChild = result.agents.find(
      (agent) => agent.id === `claude:${sessionId}:longtext`,
    );
    const emptyChild = result.agents.find(
      (agent) => agent.id === `claude:${sessionId}:wfempty`,
    );

    assert.equal(root?.name, "IPPORTAL");
    assert.equal(root?.model, "fable");
    assert.equal(root?.effort, "xhigh");
    assert.equal(root?.task, "Check open PRs");
    assert.equal(root?.status, "running");
    assert.equal(direct?.name, "Code review");
    assert.equal(direct?.task, "Direct Claude subagent (code-reviewer)");
    assert.equal(direct?.effort, "xhigh");
    assert.equal(workflowChild?.name, "verify:stash0");
    assert.equal(workflowChild?.task, "Verify the stash entry");
    assert.equal(workflowChild?.effort, "xhigh");
    assert.equal(longTextChild?.name, `${longText.slice(0, 31)}…`);
    assert.equal(longTextChild?.task, longText);
    assert.equal(emptyChild?.name, "Claude workflow-subagent");
    assert.equal(
      result.agents.filter((agent) => agent.parentId === root?.id).length,
      9,
    );
    assert.equal(
      result.agents.some((agent) => agent.id === `claude:${sessionId}:deep`),
      false,
    );
  } finally {
    if (previousDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousDirectory;
    }
    if (previousRateLimitsFile === undefined) {
      delete process.env.CLAUDE_RATE_LIMITS_FILE;
    } else {
      process.env.CLAUDE_RATE_LIMITS_FILE = previousRateLimitsFile;
    }
    if (previousWorkspace === undefined) {
      delete process.env.MONITOR_WORKSPACE;
    } else {
      process.env.MONITOR_WORKSPACE = previousWorkspace;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("Claude collector completes dead-process sessions and counts tool calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-claude-live-"));
  const workspace = "/workspace/repo";
  const projectDirectory = join(directory, "projects", "-workspace-repo");
  const previousDirectory = process.env.CLAUDE_CONFIG_DIR;
  const previousRateLimitsFile = process.env.CLAUDE_RATE_LIMITS_FILE;
  const previousWorkspace = process.env.MONITOR_WORKSPACE;
  const now = Date.now();

  try {
    process.env.CLAUDE_CONFIG_DIR = directory;
    delete process.env.CLAUDE_RATE_LIMITS_FILE;
    process.env.MONITOR_WORKSPACE = workspace;
    await mkdir(join(directory, "sessions"), { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
      join(directory, "sessions", "dead.json"),
      JSON.stringify({
        sessionId: "dead-session",
        pid: 999_999_999,
        cwd: workspace,
        status: "busy",
        startedAt: new Date(now - 600_000).toISOString(),
        updatedAt: new Date(now - 180_000).toISOString(),
      }),
    );
    await writeFile(
      join(directory, "sessions", "fresh-dead.json"),
      JSON.stringify({
        sessionId: "fresh-dead-session",
        pid: 999_999_999,
        cwd: workspace,
        status: "busy",
        startedAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 2_000).toISOString(),
      }),
    );
    await writeFile(
      join(directory, "sessions", "dead-failed.json"),
      JSON.stringify({
        sessionId: "dead-failed-session",
        pid: 999_999_999,
        cwd: workspace,
        status: "failed",
        startedAt: new Date(now - 600_000).toISOString(),
        updatedAt: new Date(now - 180_000).toISOString(),
      }),
    );
    await writeFile(
      join(directory, "sessions", "live.json"),
      JSON.stringify({
        sessionId: "live-session",
        pid: process.pid,
        cwd: workspace,
        status: "busy",
        startedAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      }),
    );
    await writeFile(
      join(directory, "sessions", "live-sonnet.json"),
      JSON.stringify({
        sessionId: "live-sonnet-session",
        pid: process.pid,
        cwd: workspace,
        status: "busy",
        startedAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      }),
    );
    const assistantLine = (content: unknown[], model = "claude-fable-5") =>
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(now - 30_000).toISOString(),
        requestId: "req-1",
        message: {
          id: "msg-1",
          model,
          content,
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      });
    const userLine = (content: unknown, isMeta?: boolean) =>
      JSON.stringify({
        type: "user",
        ...(isMeta === undefined ? {} : { isMeta }),
        message: { role: "user", content },
      });
    const transcriptLines = [
      userLine("meta housekeeping text", true),
      userLine("<system-reminder>reminder</system-reminder>"),
      userLine("Caveat: The messages below were generated locally."),
      userLine([{ type: "tool_result", content: "tool output" }]),
      userLine("[Request interrupted by user]"),
      userLine([
        { type: "text", text: "<system-reminder>wrapped</system-reminder>" },
        { type: "text", text: "Fix the login bug" },
      ]),
      assistantLine([{ type: "tool_use", name: "Read" }]),
      assistantLine([{ type: "tool_use", name: "Edit" }]),
    ];
    await writeFile(
      join(projectDirectory, "live-session.jsonl"),
      `${transcriptLines.join("\n")}\n`,
    );
    await writeFile(
      join(projectDirectory, "live-sonnet-session.jsonl"),
      `${assistantLine(
        [{ type: "tool_use", name: "Read" }],
        "claude-sonnet-5",
      )}\n`,
    );

    const result = await collectClaudeTelemetry();
    const dead = result.agents.find(
      (agent) => agent.id === "claude:dead-session",
    );
    const freshDead = result.agents.find(
      (agent) => agent.id === "claude:fresh-dead-session",
    );
    const deadFailed = result.agents.find(
      (agent) => agent.id === "claude:dead-failed-session",
    );
    const live = result.agents.find(
      (agent) => agent.id === "claude:live-session",
    );
    const liveSonnet = result.agents.find(
      (agent) => agent.id === "claude:live-sonnet-session",
    );

    assert.equal(dead?.status, "completed");
    assert.notEqual(dead?.endedAt, null);
    assert.equal(freshDead?.status, "running");
    assert.equal(deadFailed?.status, "failed");
    assert.equal(live?.status, "running");
    assert.equal(live?.name, "Claude session live-ses");
    assert.equal(live?.model, "claude-fable-5");
    assert.equal(live?.task, "Fix the login bug");
    assert.equal(live?.toolCalls, 2);
    assert.equal(live?.tokenUsage.input, 100);
    assert.equal(live?.tokenUsage.output, 20);
    assert.equal(live?.tokenUsage.contextLimit, 1_000_000);
    assert.equal(liveSonnet?.model, "claude-sonnet-5");
    assert.equal(liveSonnet?.tokenUsage.contextLimit, 200_000);
  } finally {
    if (previousDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousDirectory;
    }
    if (previousRateLimitsFile === undefined) {
      delete process.env.CLAUDE_RATE_LIMITS_FILE;
    } else {
      process.env.CLAUDE_RATE_LIMITS_FILE = previousRateLimitsFile;
    }
    if (previousWorkspace === undefined) {
      delete process.env.MONITOR_WORKSPACE;
    } else {
      process.env.MONITOR_WORKSPACE = previousWorkspace;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("Claude collector keeps only the newest registry record per session id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-claude-dedup-"));
  const workspace = "/workspace/repo";
  const previousDirectory = process.env.CLAUDE_CONFIG_DIR;
  const previousRateLimitsFile = process.env.CLAUDE_RATE_LIMITS_FILE;
  const previousWorkspace = process.env.MONITOR_WORKSPACE;
  const now = Date.now();

  try {
    process.env.CLAUDE_CONFIG_DIR = directory;
    delete process.env.CLAUDE_RATE_LIMITS_FILE;
    process.env.MONITOR_WORKSPACE = workspace;
    await mkdir(join(directory, "sessions"), { recursive: true });
    await writeFile(
      join(directory, "sessions", "a-stale.json"),
      JSON.stringify({
        sessionId: "dup-session",
        pid: 999_999_999,
        cwd: workspace,
        status: "busy",
        startedAt: new Date(now - 600_000).toISOString(),
        updatedAt: new Date(now - 180_000).toISOString(),
      }),
    );
    await writeFile(
      join(directory, "sessions", "b-fresh.json"),
      JSON.stringify({
        sessionId: "dup-session",
        pid: process.pid,
        cwd: workspace,
        status: "busy",
        startedAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      }),
    );

    const result = await collectClaudeTelemetry();
    const matches = result.agents.filter(
      (agent) => agent.id === "claude:dup-session",
    );

    assert.equal(matches.length, 1);
    assert.equal(matches[0].status, "running");
  } finally {
    if (previousDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousDirectory;
    }
    if (previousRateLimitsFile === undefined) {
      delete process.env.CLAUDE_RATE_LIMITS_FILE;
    } else {
      process.env.CLAUDE_RATE_LIMITS_FILE = previousRateLimitsFile;
    }
    if (previousWorkspace === undefined) {
      delete process.env.MONITOR_WORKSPACE;
    } else {
      process.env.MONITOR_WORKSPACE = previousWorkspace;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("Claude collector closes an unresolved child with its completed parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-claude-child-"));
  const workspace = "/workspace/repo";
  const sessionId = "parent-session";
  const projectDirectory = join(directory, "projects", "-workspace-repo");
  const subagentsDirectory = join(
    projectDirectory,
    sessionId,
    "subagents",
  );
  const previousDirectory = process.env.CLAUDE_CONFIG_DIR;
  const previousRateLimitsFile = process.env.CLAUDE_RATE_LIMITS_FILE;
  const previousWorkspace = process.env.MONITOR_WORKSPACE;
  const now = Date.now();

  try {
    process.env.CLAUDE_CONFIG_DIR = directory;
    delete process.env.CLAUDE_RATE_LIMITS_FILE;
    process.env.MONITOR_WORKSPACE = workspace;
    await mkdir(join(directory, "sessions"), { recursive: true });
    await mkdir(join(directory, "jobs", "job-1"), { recursive: true });
    await mkdir(subagentsDirectory, { recursive: true });
    await writeFile(
      join(directory, "sessions", "parent.json"),
      JSON.stringify({
        sessionId,
        jobId: "job-1",
        cwd: workspace,
        status: "busy",
        startedAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      }),
    );
    await writeFile(
      join(directory, "jobs", "job-1", "state.json"),
      JSON.stringify({
        state: "done",
        tempo: "idle",
        createdAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      }),
    );
    await writeFile(join(projectDirectory, `${sessionId}.jsonl`), "");
    await writeFile(join(subagentsDirectory, "agent-child.jsonl"), "");
    await writeFile(
      join(subagentsDirectory, "agent-child.meta.json"),
      JSON.stringify({ spawnDepth: 1, agentType: "worker" }),
    );

    const result = await collectClaudeTelemetry();
    const parent = result.agents.find(
      (agent) => agent.id === `claude:${sessionId}`,
    );
    const child = result.agents.find(
      (agent) => agent.id === `claude:${sessionId}:child`,
    );

    assert.equal(parent?.status, "completed");
    assert.equal(child?.status, "completed");
    assert.equal(child?.parentId, parent?.id);
    assert.notEqual(child?.endedAt, null);
  } finally {
    if (previousDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousDirectory;
    }
    if (previousRateLimitsFile === undefined) {
      delete process.env.CLAUDE_RATE_LIMITS_FILE;
    } else {
      process.env.CLAUDE_RATE_LIMITS_FILE = previousRateLimitsFile;
    }
    if (previousWorkspace === undefined) {
      delete process.env.MONITOR_WORKSPACE;
    } else {
      process.env.MONITOR_WORKSPACE = previousWorkspace;
    }
    await rm(directory, { force: true, recursive: true });
  }
});

test("Claude collector distinguishes resumed, stalled, and spare sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-claude-status-"));
  const workspace = "/workspace/repo";
  const projectDirectory = join(directory, "projects", "-workspace-repo");
  const previousDirectory = process.env.CLAUDE_CONFIG_DIR;
  const previousRateLimitsFile = process.env.CLAUDE_RATE_LIMITS_FILE;
  const previousWorkspace = process.env.MONITOR_WORKSPACE;
  const now = Date.now();

  try {
    process.env.CLAUDE_CONFIG_DIR = directory;
    delete process.env.CLAUDE_RATE_LIMITS_FILE;
    process.env.MONITOR_WORKSPACE = workspace;
    await mkdir(join(directory, "sessions"), { recursive: true });
    await mkdir(join(directory, "jobs", "job-resumed"), { recursive: true });
    await mkdir(join(directory, "jobs", "job-stalled"), { recursive: true });
    await mkdir(projectDirectory, { recursive: true });

    // A resumed background job keeps state "done" from its finished turn
    // while tempo reports the new activity.
    await writeFile(
      join(directory, "sessions", "resumed.json"),
      JSON.stringify({
        sessionId: "resumed-session",
        jobId: "job-resumed",
        kind: "bg",
        pid: process.pid,
        cwd: workspace,
        status: "busy",
        startedAt: new Date(now - 120_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      }),
    );
    await writeFile(
      join(directory, "jobs", "job-resumed", "state.json"),
      JSON.stringify({
        state: "done",
        tempo: "active",
        createdAt: new Date(now - 120_000).toISOString(),
        updatedAt: new Date(now - 1_000).toISOString(),
      }),
    );

    // An open turn whose tempo settled to idle is waiting, not computing.
    await writeFile(
      join(directory, "sessions", "stalled.json"),
      JSON.stringify({
        sessionId: "stalled-session",
        jobId: "job-stalled",
        kind: "bg",
        pid: process.pid,
        cwd: workspace,
        status: "idle",
        startedAt: new Date(now - 120_000).toISOString(),
        updatedAt: new Date(now - 2_000).toISOString(),
      }),
    );
    await writeFile(
      join(directory, "jobs", "job-stalled", "state.json"),
      JSON.stringify({
        state: "working",
        tempo: "idle",
        createdAt: new Date(now - 120_000).toISOString(),
        updatedAt: new Date(now - 2_000).toISOString(),
      }),
    );

    // A pre-warmed spare registers a session but has no job state and no
    // transcript.
    await writeFile(
      join(directory, "sessions", "spare.json"),
      JSON.stringify({
        sessionId: "spare-session",
        jobId: "spare-session",
        kind: "bg",
        pid: process.pid,
        cwd: workspace,
        status: "idle",
        startedAt: new Date(now - 3_000).toISOString(),
        updatedAt: new Date(now - 3_000).toISOString(),
      }),
    );

    const result = await collectClaudeTelemetry();
    const resumed = result.agents.find(
      (agent) => agent.id === "claude:resumed-session",
    );
    const stalled = result.agents.find(
      (agent) => agent.id === "claude:stalled-session",
    );

    assert.equal(resumed?.status, "running");
    assert.equal(resumed?.endedAt, null);
    assert.equal(stalled?.status, "queued");
    assert.equal(
      result.agents.some((agent) => agent.id === "claude:spare-session"),
      false,
    );
    assert.match(result.source.detail, /Loaded 2 Claude sessions/u);
  } finally {
    if (previousDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousDirectory;
    }
    if (previousRateLimitsFile === undefined) {
      delete process.env.CLAUDE_RATE_LIMITS_FILE;
    } else {
      process.env.CLAUDE_RATE_LIMITS_FILE = previousRateLimitsFile;
    }
    if (previousWorkspace === undefined) {
      delete process.env.MONITOR_WORKSPACE;
    } else {
      process.env.MONITOR_WORKSPACE = previousWorkspace;
    }
    await rm(directory, { force: true, recursive: true });
  }
});
