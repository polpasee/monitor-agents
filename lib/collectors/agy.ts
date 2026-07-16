import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AgentRun,
  AgentStatus,
  Event,
  EventKind,
  QuotaLimit,
  QuotaPeriod,
  SpawnMethod,
  TokenUsage,
} from "../telemetry";
import type { CollectorResult } from "./types";

const AGENT_STATUSES: AgentStatus[] = [
  "queued",
  "running",
  "idle",
  "completed",
  "aborted",
  "failed",
];
const SPAWN_METHODS: SpawnMethod[] = ["root", "native", "bash", "api"];
const EVENT_KINDS: EventKind[] = [
  "agent.started",
  "agent.completed",
  "agent.failed",
  "tool.called",
  "usage.recorded",
];
const QUOTA_PERIODS: QuotaPeriod[] = ["hour", "week"];

class ValidationError extends Error {}

function invalid(message: string): never {
  throw new ValidationError(message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    invalid(`${field} must be a string.`);
  }
  return value;
}

function id(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (parsed.trim().length === 0) {
    invalid(`${field} must not be empty.`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (Number.isNaN(Date.parse(parsed))) {
    invalid(`${field} must be a valid timestamp.`);
  }
  return parsed;
}

function number(
  value: unknown,
  field: string,
  integer = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isInteger(value))
  ) {
    invalid(`${field} must be a non-negative${integer ? " integer" : " number"}.`);
  }
  return value;
}

function nullableNumber(
  value: unknown,
  field: string,
  integer = false,
): number | null {
  return value == null ? null : number(value, field, integer);
}

function choice<T extends string>(
  value: unknown,
  options: T[],
  field: string,
): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    invalid(`${field} has an unsupported value.`);
  }
  return value as T;
}

function agyId(value: unknown, field: string): string {
  const parsed = id(value, field);
  return parsed.startsWith("agy:") ? parsed : `agy:${parsed}`;
}

function validateProvider(value: unknown, field: string): void {
  if (value !== undefined && value !== "agy") {
    invalid(`${field} must be "agy" when provided.`);
  }
}

function parseTokenUsage(value: unknown, field: string): TokenUsage {
  const input = record(value, field);
  return {
    input: number(input.input, `${field}.input`, true),
    output: number(input.output, `${field}.output`, true),
    cached: number(input.cached, `${field}.cached`, true),
    contextUsed: number(input.contextUsed, `${field}.contextUsed`, true),
    contextLimit: number(input.contextLimit, `${field}.contextLimit`, true),
  };
}

function parseAgent(value: unknown, index: number): AgentRun {
  const field = `agents[${index}]`;
  const input = record(value, field);
  validateProvider(input.provider, `${field}.provider`);

  const parentId = input.parentId;
  if (parentId !== null && parentId !== undefined && typeof parentId !== "string") {
    invalid(`${field}.parentId must be a string or null.`);
  }

  const endedAt = input.endedAt;
  if (endedAt !== null && endedAt !== undefined && typeof endedAt !== "string") {
    invalid(`${field}.endedAt must be a timestamp or null.`);
  }

  const spawnCommand = input.spawnCommand;
  if (spawnCommand !== undefined && typeof spawnCommand !== "string") {
    invalid(`${field}.spawnCommand must be a string when provided.`);
  }

  const effort = input.effort;
  if (
    effort !== null &&
    effort !== undefined &&
    typeof effort !== "string"
  ) {
    invalid(`${field}.effort must be a string or null.`);
  }

  return {
    id: agyId(input.id, `${field}.id`),
    parentId:
      typeof parentId === "string"
        ? agyId(parentId, `${field}.parentId`)
        : null,
    name: string(input.name, `${field}.name`),
    provider: "agy",
    model: string(input.model, `${field}.model`),
    effort:
      typeof effort === "string" ? string(effort, `${field}.effort`) : null,
    status: choice(input.status, AGENT_STATUSES, `${field}.status`),
    task: string(input.task, `${field}.task`),
    spawnMethod: choice(
      input.spawnMethod,
      SPAWN_METHODS,
      `${field}.spawnMethod`,
    ),
    ...(spawnCommand === undefined ? {} : { spawnCommand }),
    cwd: string(input.cwd, `${field}.cwd`),
    startedAt: timestamp(input.startedAt, `${field}.startedAt`),
    endedAt:
      typeof endedAt === "string"
        ? timestamp(endedAt, `${field}.endedAt`)
        : null,
    lastActivityAt: timestamp(
      input.lastActivityAt,
      `${field}.lastActivityAt`,
    ),
    tokenUsage: parseTokenUsage(input.tokenUsage, `${field}.tokenUsage`),
    costUsd: nullableNumber(input.costUsd, `${field}.costUsd`),
    toolCalls:
      input.toolCalls == null
        ? null
        : number(input.toolCalls, `${field}.toolCalls`, true),
  };
}

function parseEvent(value: unknown, index: number): Event {
  const field = `events[${index}]`;
  const input = record(value, field);
  validateProvider(input.provider, `${field}.provider`);
  const parsed: Event = {
    id: agyId(input.id, `${field}.id`),
    agentId: agyId(input.agentId, `${field}.agentId`),
    kind: choice(input.kind, EVENT_KINDS, `${field}.kind`),
    at: timestamp(input.at, `${field}.at`),
    label: string(input.label, `${field}.label`),
  };

  if (input.inputTokens !== undefined) {
    parsed.inputTokens = number(
      input.inputTokens,
      `${field}.inputTokens`,
      true,
    );
  }
  if (input.outputTokens !== undefined) {
    parsed.outputTokens = number(
      input.outputTokens,
      `${field}.outputTokens`,
      true,
    );
  }
  if (input.costUsd !== undefined) {
    parsed.costUsd = nullableNumber(input.costUsd, `${field}.costUsd`);
  }

  return parsed;
}

function parseQuota(value: unknown, index: number): QuotaLimit {
  const field = `quotaLimits[${index}]`;
  const input = record(value, field);
  validateProvider(input.provider, `${field}.provider`);

  return {
    id: agyId(input.id, `${field}.id`),
    provider: "agy",
    label: string(input.label, `${field}.label`),
    period: choice(input.period, QUOTA_PERIODS, `${field}.period`),
    windowHours: number(input.windowHours, `${field}.windowHours`),
    usedTokens: nullableNumber(
      input.usedTokens,
      `${field}.usedTokens`,
      true,
    ),
    tokenLimit: nullableNumber(
      input.tokenLimit,
      `${field}.tokenLimit`,
      true,
    ),
    usedCostUsd: nullableNumber(input.usedCostUsd, `${field}.usedCostUsd`),
    costLimitUsd: nullableNumber(input.costLimitUsd, `${field}.costLimitUsd`),
    usedPercent: nullableNumber(input.usedPercent, `${field}.usedPercent`),
    resetsAt:
      input.resetsAt == null
        ? null
        : timestamp(input.resetsAt, `${field}.resetsAt`),
  };
}

function uniqueIds(items: { id: string }[], field: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      invalid(`${field} contains duplicate id "${item.id}".`);
    }
    ids.add(item.id);
  }
}

function parseSnapshot(value: unknown): Omit<CollectorResult, "source"> {
  const input = record(value, "AGY telemetry");
  if (!Array.isArray(input.agents)) {
    invalid("agents must be an array.");
  }
  if (!Array.isArray(input.events)) {
    invalid("events must be an array.");
  }
  if (!Array.isArray(input.quotaLimits)) {
    invalid("quotaLimits must be an array.");
  }

  const agents = input.agents.map(parseAgent);
  const events = input.events.map(parseEvent);
  const quotaLimits = input.quotaLimits.map(parseQuota);
  uniqueIds(agents, "agents");
  uniqueIds(events, "events");
  uniqueIds(quotaLimits, "quotaLimits");

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  for (const agent of agents) {
    if (agent.parentId !== null && !agentsById.has(agent.parentId)) {
      invalid(`agents contains unknown parent id "${agent.parentId}".`);
    }

    const visited = new Set<string>();
    let current: AgentRun | undefined = agent;
    while (current?.parentId) {
      if (visited.has(current.id)) {
        invalid(`agents contains a parent cycle at "${current.id}".`);
      }
      visited.add(current.id);
      current = agentsById.get(current.parentId);
    }
  }

  for (const event of events) {
    if (!agentsById.has(event.agentId)) {
      invalid(`events contains unknown agent id "${event.agentId}".`);
    }
  }

  return { agents, events, quotaLimits };
}

function emptyResult(
  connection: "unconfigured" | "error" | "idle",
  detail: string,
): CollectorResult {
  return {
    agents: [],
    events: [],
    quotaLimits: [],
    source: { provider: "agy", connection, detail, agentCount: 0 },
  };
}

async function parseLocalAgyAgent(
  conversationId: string,
): Promise<AgentRun | null> {
  const brainDir = join(homedir(), ".gemini", "antigravity-cli", "brain");
  const transcriptPath = join(
    brainDir,
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );

  let contents: string;
  try {
    contents = await readFile(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const lines = contents.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  let startedAt = "";
  let lastActivityAt = "";
  let task = "Unknown task";
  let model = "Gemini";
  let toolCalls = 0;

  for (const line of lines) {
    try {
      const step = JSON.parse(line) as Record<string, unknown>;
      if (!startedAt && typeof step.created_at === "string") {
        startedAt = step.created_at;
      }
      if (typeof step.created_at === "string") {
        lastActivityAt = step.created_at;
      }
      if (
        step.type === "USER_INPUT" &&
        task === "Unknown task" &&
        typeof step.content === "string"
      ) {
        const match = step.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        task = match ? match[1].trim() : step.content.substring(0, 100);
      }
      if (step.type === "USER_SETTINGS_CHANGE" && typeof step.content === "string") {
        const match = step.content.match(/from .*? to (.*?)\./);
        if (match) {
          model = match[1].trim();
        }
      }
      if (Array.isArray(step.tool_calls)) {
        toolCalls += step.tool_calls.length;
      }
    } catch {
      // Ignore parse errors on individual lines
    }
  }

  if (!startedAt) return null;

  const now = Date.now();
  const lastActivityMs = Date.parse(lastActivityAt);
  const isCompleted = now - lastActivityMs > 15 * 60 * 1000;

  return {
    id: `agy:${conversationId}`,
    parentId: null,
    name: "Antigravity",
    provider: "agy",
    model,
    effort: null,
    status: isCompleted ? "completed" : "running",
    task: task.substring(0, 200),
    spawnMethod: "root",
    cwd: process.cwd(),
    startedAt,
    endedAt: isCompleted ? lastActivityAt : null,
    lastActivityAt,
    tokenUsage: {
      input: 0,
      output: 0,
      cached: 0,
      contextUsed: 0,
      contextLimit: 0,
    },
    costUsd: null,
    toolCalls,
  };
}

async function collectLocalAgyAgents(): Promise<AgentRun[]> {
  const brainDir = join(homedir(), ".gemini", "antigravity-cli", "brain");
  let entries: string[] = [];
  try {
    entries = await readdir(brainDir);
  } catch {
    return [];
  }
  const agents = (await Promise.all(entries.map(parseLocalAgyAgent))).filter(
    (agent): agent is AgentRun => agent !== null,
  );
  return agents;
}

export async function collectAgyTelemetry(): Promise<CollectorResult> {
  const file = process.env.AGY_TELEMETRY_FILE?.trim();
  if (!file) {
    try {
      const agents = await collectLocalAgyAgents();
      if (agents.length === 0) {
        return emptyResult(
          "idle",
          "No AGY telemetry file configured and no local AGY agents found.",
        );
      }
      return {
        agents,
        events: [],
        quotaLimits: [],
        source: {
          provider: "agy",
          connection: "connected",
          detail: `Loaded ${agents.length} agents from local transcript logs.`,
          agentCount: agents.length,
        },
      };
    } catch {
      return emptyResult(
        "unconfigured",
        "Set AGY_TELEMETRY_FILE to an AGY telemetry JSON file.",
      );
    }
  }

  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    return emptyResult("error", "Unable to read the AGY telemetry file.");
  }

  try {
    const telemetry = parseSnapshot(JSON.parse(contents) as unknown);
    return {
      ...telemetry,
      source: {
        provider: "agy",
        connection: "connected",
        detail: "Loaded the configured AGY telemetry file.",
        agentCount: telemetry.agents.length,
      },
    };
  } catch (error) {
    const detail =
      error instanceof ValidationError
        ? `Invalid AGY telemetry: ${error.message}`
        : "The AGY telemetry file does not contain valid JSON.";
    return emptyResult("error", detail);
  }
}
