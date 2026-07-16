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
