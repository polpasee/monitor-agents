import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type {
  AgentRun,
  AgentStatus,
  Event,
  TokenUsage,
} from "../telemetry.ts";
import type { CollectorResult } from "./types.ts";

const DEFAULT_MAX_AGENTS = 24;
const RUNNING_GRACE_MS = 2 * 60 * 1_000;
const DEFAULT_CONTEXT_LIMIT = 1_000_000;
const MAX_TASK_LENGTH = 160;
const MAX_NAME_LENGTH = 32;

interface ParsedChat {
  sessionId: string;
  cwd: string | null;
  model: string | null;
  contextLimit: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
  task: string | null;
  toolCalls: number;
  usage: TokenUsage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoFromMs(atMs: number): string {
  return new Date(atMs).toISOString();
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > limit
    ? `${collapsed.slice(0, limit - 1)}…`
    : collapsed;
}

function maxAgents(): number {
  const parsed = Number.parseInt(process.env.MONITOR_MAX_AGENTS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGENTS;
}

function qwenHome(): string {
  return process.env.QWEN_HOME?.trim() || join(homedir(), ".qwen");
}

function emptyResult(
  connection: CollectorResult["source"]["connection"],
  detail: string,
): CollectorResult {
  return {
    agents: [],
    events: [],
    quotaLimits: [],
    source: {
      provider: "qwen",
      connection,
      detail,
      agentCount: 0,
    },
  };
}

/** Joins the text parts of a Qwen message, which nests them under message.parts. */
function messageText(message: unknown): string | null {
  const parts = isRecord(message) ? message.parts : null;
  if (!Array.isArray(parts)) {
    return null;
  }

  const text = parts
    .map((part) => (isRecord(part) ? stringValue(part.text) : null))
    .filter((part): part is string => part !== null)
    .join(" ");

  return text.length > 0 ? text : null;
}

/**
 * Qwen records prompt tokens as a total that already includes the cached ones,
 * so the uncached remainder is what belongs in `input`.
 */
function tokenUsage(usageMetadata: unknown, contextLimit: number): TokenUsage {
  const usage = isRecord(usageMetadata) ? usageMetadata : {};
  const prompt = numberValue(usage.promptTokenCount) ?? 0;
  const cached = numberValue(usage.cachedContentTokenCount) ?? 0;

  return {
    input: Math.max(0, prompt - cached),
    output: numberValue(usage.candidatesTokenCount) ?? 0,
    cached,
    contextUsed: numberValue(usage.totalTokenCount) ?? 0,
    contextLimit,
  };
}

function parseChat(content: string, fallbackSessionId: string): ParsedChat {
  const chat: ParsedChat = {
    sessionId: fallbackSessionId,
    cwd: null,
    model: null,
    contextLimit: DEFAULT_CONTEXT_LIMIT,
    firstAtMs: null,
    lastAtMs: null,
    task: null,
    toolCalls: 0,
    usage: null,
  };

  for (const line of content.split("\n")) {
    if (line.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    chat.sessionId = stringValue(parsed.sessionId) ?? chat.sessionId;
    chat.cwd = stringValue(parsed.cwd) ?? chat.cwd;

    const atMs = Date.parse(stringValue(parsed.timestamp) ?? "");
    if (Number.isFinite(atMs)) {
      chat.firstAtMs = chat.firstAtMs === null ? atMs : chat.firstAtMs;
      chat.lastAtMs =
        chat.lastAtMs === null ? atMs : Math.max(chat.lastAtMs, atMs);
    }

    if (parsed.type === "tool_result") {
      chat.toolCalls += 1;
      continue;
    }

    if (parsed.type === "user" && parsed.provenance === "real_user") {
      chat.task = chat.task ?? messageText(parsed.message);
      continue;
    }

    if (parsed.type !== "assistant") {
      continue;
    }

    chat.model = stringValue(parsed.model) ?? chat.model;
    chat.contextLimit =
      numberValue(parsed.contextWindowSize) ?? chat.contextLimit;
    if (isRecord(parsed.usageMetadata)) {
      chat.usage = tokenUsage(parsed.usageMetadata, chat.contextLimit);
    }
  }

  return chat;
}

function buildAgent(chat: ParsedChat, capturedAtMs: number): AgentRun {
  const startedAtMs = chat.firstAtMs ?? capturedAtMs;
  const lastAtMs = chat.lastAtMs ?? startedAtMs;
  // Qwen writes no end-of-session record, so recency is the only signal.
  const status: AgentStatus =
    capturedAtMs - lastAtMs <= RUNNING_GRACE_MS ? "running" : "completed";
  const task = chat.task ?? "Qwen session";

  return {
    id: `qwen:${chat.sessionId}`,
    parentId: null,
    name: truncate(task, MAX_NAME_LENGTH),
    provider: "qwen",
    model: chat.model ?? "unknown",
    effort: null,
    status,
    task: truncate(task, MAX_TASK_LENGTH),
    spawnMethod: "root",
    cwd: chat.cwd ?? "",
    startedAt: isoFromMs(startedAtMs),
    endedAt: status === "completed" ? isoFromMs(lastAtMs) : null,
    lastActivityAt: isoFromMs(lastAtMs),
    tokenUsage: chat.usage ?? {
      input: 0,
      output: 0,
      cached: 0,
      contextUsed: 0,
      contextLimit: chat.contextLimit,
    },
    costUsd: null,
    toolCalls: chat.toolCalls,
  };
}

function buildEvents(agent: AgentRun, chat: ParsedChat): Event[] {
  const events: Event[] = [
    {
      id: `qwen:event:${chat.sessionId}:started`,
      agentId: agent.id,
      kind: "agent.started",
      at: agent.startedAt,
      label: "Qwen session started",
    },
  ];

  if (agent.endedAt !== null) {
    events.push({
      id: `qwen:event:${chat.sessionId}:completed`,
      agentId: agent.id,
      kind: "agent.completed",
      at: agent.endedAt,
      label: "Qwen session completed",
    });
  }

  if (chat.usage !== null) {
    events.push({
      id: `qwen:event:${chat.sessionId}:usage`,
      agentId: agent.id,
      kind: "usage.recorded",
      at: agent.lastActivityAt,
      label: "Qwen token usage recorded",
      inputTokens: chat.usage.input,
      outputTokens: chat.usage.output,
      costUsd: null,
    });
  }

  return events;
}

async function findChatFiles(
  projectsDirectory: string,
): Promise<{ path: string; mtimeMs: number }[]> {
  const projects = await readdir(projectsDirectory, { withFileTypes: true });
  const files: { path: string; mtimeMs: number }[] = [];

  for (const project of projects) {
    if (!project.isDirectory()) {
      continue;
    }

    const chatsDirectory = join(projectsDirectory, project.name, "chats");
    let entries: string[];
    try {
      entries = await readdir(chatsDirectory);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }

      const path = join(chatsDirectory, entry);
      try {
        files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      } catch {
        continue;
      }
    }
  }

  return files;
}

export async function collectQwenTelemetry(): Promise<CollectorResult> {
  const projectsDirectory = join(qwenHome(), "projects");
  if (!existsSync(projectsDirectory)) {
    return emptyResult("unconfigured", "No Qwen sessions directory found.");
  }

  let files: { path: string; mtimeMs: number }[];
  try {
    files = await findChatFiles(projectsDirectory);
  } catch {
    return emptyResult("error", "Qwen sessions directory could not be read.");
  }

  const total = files.length;
  const selected = files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxAgents());

  const capturedAtMs = Date.now();
  const agents: AgentRun[] = [];
  const events: Event[] = [];
  let unreadable = 0;

  for (const file of selected) {
    let content: string;
    try {
      content = await readFile(file.path, "utf8");
    } catch {
      unreadable += 1;
      continue;
    }

    const chat = parseChat(content, basename(file.path, ".jsonl"));
    if (chat.firstAtMs === null) {
      continue;
    }

    const agent = buildAgent(chat, capturedAtMs);
    agents.push(agent);
    events.push(...buildEvents(agent, chat));
  }

  events.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

  const notes = [`Loaded ${agents.length} Qwen sessions.`];
  if (total > selected.length) {
    notes.push(`Limited from ${total} by MONITOR_MAX_AGENTS.`);
  }
  if (unreadable > 0) {
    notes.push(`${unreadable} chat files could not be read.`);
  }

  return {
    agents,
    events,
    quotaLimits: [],
    source: {
      provider: "qwen",
      connection: agents.length > 0 ? "connected" : "idle",
      detail: notes.join(" "),
      agentCount: agents.length,
    },
  };
}
