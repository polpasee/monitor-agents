import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectQwenTelemetry } from "./qwen.ts";

const now = Date.now();

function chatLines(options: {
  sessionId: string;
  cwd: string;
  lastAtMs: number;
}): string {
  const { sessionId, cwd, lastAtMs } = options;
  const startedAtMs = lastAtMs - 20_000;
  const base = { sessionId, cwd, version: "0.22.2" };

  return [
    {
      ...base,
      type: "user",
      provenance: "real_user",
      timestamp: new Date(startedAtMs).toISOString(),
      message: { role: "user", parts: [{ text: "Reply with exactly: ok" }] },
    },
    // A later real_user turn must not replace the task the session opened with.
    {
      ...base,
      type: "user",
      provenance: "real_user",
      timestamp: new Date(startedAtMs + 1_000).toISOString(),
      message: { role: "user", parts: [{ text: "and again" }] },
    },
    {
      ...base,
      type: "system",
      subtype: "ui_telemetry",
      timestamp: new Date(startedAtMs + 2_000).toISOString(),
      systemPayload: { uiEvent: { "event.name": "qwen.render" } },
    },
    {
      ...base,
      type: "tool_result",
      provenance: "tool_result",
      timestamp: new Date(startedAtMs + 3_000).toISOString(),
      toolCallResult: { callId: "call-1" },
    },
    {
      ...base,
      type: "assistant",
      provenance: "assistant_output",
      timestamp: new Date(lastAtMs).toISOString(),
      model: "qwen3.6-27b",
      contextWindowSize: 1_000_000,
      message: { role: "model", parts: [{ text: "ok" }] },
      usageMetadata: {
        promptTokenCount: 26_052,
        candidatesTokenCount: 2,
        cachedContentTokenCount: 52,
        totalTokenCount: 26_054,
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
}

async function writeChat(
  qwenHome: string,
  project: string,
  sessionId: string,
  content: string,
): Promise<void> {
  const chats = join(qwenHome, "projects", project, "chats");
  await mkdir(chats, { recursive: true });
  await writeFile(join(chats, `${sessionId}.jsonl`), `${content}\n`);
}

test("Qwen collector reads a session's task, model, tokens and tool calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-qwen-"));
  const previousHome = process.env.QWEN_HOME;

  try {
    process.env.QWEN_HOME = directory;
    await writeChat(
      directory,
      "-Users-dev-repo",
      "live-session",
      chatLines({
        sessionId: "live-session",
        cwd: "/Users/dev/repo",
        lastAtMs: now - 5_000,
      }),
    );
    await writeChat(
      directory,
      "-Users-dev-repo",
      "old-session",
      chatLines({
        sessionId: "old-session",
        cwd: "/Users/dev/repo",
        lastAtMs: now - 60 * 60 * 1_000,
      }),
    );

    const result = await collectQwenTelemetry();
    const live = result.agents.find((agent) => agent.id === "qwen:live-session");
    const old = result.agents.find((agent) => agent.id === "qwen:old-session");

    assert.equal(result.agents.length, 2);
    assert.equal(result.source.provider, "qwen");
    assert.equal(result.source.connection, "connected");
    assert.equal(live?.provider, "qwen");
    assert.equal(live?.parentId, null);
    assert.equal(live?.spawnMethod, "root");
    assert.equal(live?.model, "qwen3.6-27b");
    assert.equal(live?.cwd, "/Users/dev/repo");
    assert.equal(live?.task, "Reply with exactly: ok");
    assert.equal(live?.toolCalls, 1);
    assert.equal(live?.costUsd, null);
    // promptTokenCount already includes the cached tokens.
    assert.equal(live?.tokenUsage.input, 26_000);
    assert.equal(live?.tokenUsage.cached, 52);
    assert.equal(live?.tokenUsage.output, 2);
    assert.equal(live?.tokenUsage.contextUsed, 26_054);
    assert.equal(live?.tokenUsage.contextLimit, 1_000_000);

    // Qwen writes no end-of-session record, so recency decides the status.
    assert.equal(live?.status, "running");
    assert.equal(live?.endedAt, null);
    assert.equal(old?.status, "completed");
    assert.equal(old?.endedAt, new Date(now - 60 * 60 * 1_000).toISOString());
  } finally {
    if (previousHome === undefined) {
      delete process.env.QWEN_HOME;
    } else {
      process.env.QWEN_HOME = previousHome;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Qwen collector skips malformed lines and caps sessions by MONITOR_MAX_AGENTS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-qwen-"));
  const previousHome = process.env.QWEN_HOME;
  const previousMaxAgents = process.env.MONITOR_MAX_AGENTS;

  try {
    process.env.QWEN_HOME = directory;
    delete process.env.MONITOR_MAX_AGENTS;

    // Oldest first, so the cap below keeps the sessions written after it.
    await writeChat(directory, "-Users-dev-other", "empty-session", "");
    for (const sessionId of ["session-a", "session-b"]) {
      await writeChat(
        directory,
        "-Users-dev-repo",
        sessionId,
        `not json\n${chatLines({
          sessionId,
          cwd: "/Users/dev/repo",
          lastAtMs: now - 5_000,
        })}`,
      );
    }

    // A chat holding no timestamped records yields no agent, and the leading
    // malformed line does not stop the rest of a chat from being read.
    const uncapped = await collectQwenTelemetry();
    assert.equal(uncapped.agents.length, 2);
    assert.equal(uncapped.agents[0].task, "Reply with exactly: ok");
    assert.doesNotMatch(uncapped.source.detail, /Limited from/u);

    process.env.MONITOR_MAX_AGENTS = "1";
    const capped = await collectQwenTelemetry();
    assert.equal(capped.agents.length, 1);
    assert.equal(capped.agents[0].id, "qwen:session-b");
    assert.match(capped.source.detail, /Limited from 3 by MONITOR_MAX_AGENTS\./u);
  } finally {
    if (previousHome === undefined) {
      delete process.env.QWEN_HOME;
    } else {
      process.env.QWEN_HOME = previousHome;
    }
    if (previousMaxAgents === undefined) {
      delete process.env.MONITOR_MAX_AGENTS;
    } else {
      process.env.MONITOR_MAX_AGENTS = previousMaxAgents;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Qwen collector reports unconfigured without a sessions directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-qwen-"));
  const previousHome = process.env.QWEN_HOME;

  try {
    process.env.QWEN_HOME = join(directory, "missing");

    const result = await collectQwenTelemetry();

    assert.deepEqual(result.agents, []);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.quotaLimits, []);
    assert.equal(result.source.connection, "unconfigured");
  } finally {
    if (previousHome === undefined) {
      delete process.env.QWEN_HOME;
    } else {
      process.env.QWEN_HOME = previousHome;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
