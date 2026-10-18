import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

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
const DEFAULT_MAX_AGENTS = 24;
const execFileAsync = promisify(execFile);
const USAGE_CACHE_MS = 5 * 60_000;
const USAGE_RETRY_CACHE_MS = 60_000;
const USAGE_TIMEOUT_MS = 45_000;
const USAGE_GROUPS = new Map([
  ["Gemini Models", { id: "agy-gemini", label: "Gemini" }],
  ["Claude and GPT models", { id: "agy-claude", label: "Claude and GPT" }],
]);
const USAGE_WINDOWS = new Map<string, { period: QuotaPeriod; windowHours: number }>([
  ["Weekly Limit Remaining", { period: "week", windowHours: 168 }],
  ["Five Hour Limit Remaining", { period: "hour", windowHours: 5 }],
]);

// On globalThis so every module copy Next dev loads shares one cache.
const usageGlobal = globalThis as typeof globalThis & {
  monitorAgyUsage?: {
    cached: { expiresAt: number; quotaLimits: QuotaLimit[] } | null;
    pending: Promise<void> | null;
  };
};

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

function maxAgents(): number {
  const parsed = Number.parseInt(process.env.MONITOR_MAX_AGENTS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGENTS;
}

function agyHome(): string {
  return (
    process.env.AGY_HOME?.trim() || join(homedir(), ".gemini", "antigravity-cli")
  );
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

// AGY transcripts carry no cwd field; the run's directory is the `Cwd` its
// run_command calls carry, stored JSON-encoded (`"Cwd":"\"/repo\""`).
function runCommandCwd(call: unknown): string | null {
  const cwd = (call as { args?: { Cwd?: unknown } } | null)?.args?.Cwd;
  if (typeof cwd !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(cwd);
    return typeof parsed === "string" && isAbsolute(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function parseLocalAgyAgent(
  conversationId: string,
): Promise<AgentRun | null> {
  const brainDir = join(agyHome(), "brain");
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
  const cwdCounts = new Map<string, number>();

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
        for (const call of step.tool_calls) {
          const toolCwd = runCommandCwd(call);
          if (toolCwd) {
            cwdCounts.set(toolCwd, (cwdCounts.get(toolCwd) ?? 0) + 1);
          }
        }
      }
    } catch {
      // Ignore parse errors on individual lines
    }
  }

  if (!startedAt) return null;

  // Stable sort: on a tie the Cwd seen first wins.
  const cwd =
    [...cwdCounts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";

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
    cwd,
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

async function collectLocalAgyAgents(): Promise<{
  agents: AgentRun[];
  total: number;
}> {
  const brainDir = join(agyHome(), "brain");
  let entries: string[] = [];
  try {
    entries = await readdir(brainDir);
  } catch {
    return { agents: [], total: 0 };
  }
  const agents = (await Promise.all(entries.map(parseLocalAgyAgent))).filter(
    (agent): agent is AgentRun => agent !== null,
  );
  const selected = agents
    .sort(
      (left, right) =>
        Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
    )
    .slice(0, maxAgents());
  return { agents: selected, total: agents.length };
}

// `agy -p /usage` prints "<group>\t<window> Limit Remaining\t<pct>%\t<reset>".
export function parseAgyUsage(stdout: string): QuotaLimit[] {
  return stdout.split("\n").flatMap((line): QuotaLimit[] => {
    const parts = line.trim().split("\t");
    const group = USAGE_GROUPS.get(parts[0]);
    const window = USAGE_WINDOWS.get(parts[1]);
    const remaining = /^(\d+(?:\.\d+)?)%$/u.exec(parts[2] ?? "");
    if (parts.length !== 4 || !group || !window || !remaining) {
      return [];
    }

    return [
      {
        id: `${group.id}-${window.period}`,
        provider: "agy",
        label: group.label,
        period: window.period,
        windowHours: window.windowHours,
        usedTokens: null,
        tokenLimit: null,
        usedCostUsd: null,
        costLimitUsd: null,
        usedPercent: 100 - Number(remaining[1]),
        resetsAt: Number.isNaN(Date.parse(parts[3])) ? null : parts[3],
      },
    ];
  });
}

async function loadAgyUsage(): Promise<QuotaLimit[]> {
  try {
    const pending = execFileAsync(
      process.env.AGY_BIN?.trim() || join(homedir(), ".local", "bin", "agy"),
      ["-p", "/usage", "--model", "gemini-3.8-flash-low"],
      { cwd: tmpdir(), timeout: USAGE_TIMEOUT_MS },
    );
    pending.child.stdin?.end();
    return parseAgyUsage((await pending).stdout);
  } catch {
    return [];
  }
}

// Snapshots never wait on agy: they get the last cached quota, and a stale
// cache starts one background refresh. A failed refresh keeps the old quota.
function collectAgyUsage(): QuotaLimit[] {
  const usage = (usageGlobal.monitorAgyUsage ??= { cached: null, pending: null });
  if (!usage.pending && (usage.cached?.expiresAt ?? 0) <= Date.now()) {
    usage.pending = loadAgyUsage().then((quotaLimits) => {
      usage.cached =
        quotaLimits.length > 0
          ? { expiresAt: Date.now() + USAGE_CACHE_MS, quotaLimits }
          : {
              expiresAt: Date.now() + USAGE_RETRY_CACHE_MS,
              quotaLimits: usage.cached?.quotaLimits ?? [],
            };
      usage.pending = null;
    });
  }
  return usage.cached?.quotaLimits ?? [];
}

// `agy -p /usage` signs in, so it only runs when a card is going to use AGY.
export async function collectAgyTelemetry(
  checkUsage = true,
): Promise<CollectorResult> {
  const usage = checkUsage ? collectAgyUsage() : [];
  const result = await collectAgyAgents();
  return { ...result, quotaLimits: [...result.quotaLimits, ...usage] };
}

async function collectAgyAgents(): Promise<CollectorResult> {
  const file = process.env.AGY_TELEMETRY_FILE?.trim();
  if (!file) {
    try {
      const { agents, total } = await collectLocalAgyAgents();
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
          detail: `Loaded ${agents.length} agents from local transcript logs.${
            total > agents.length
              ? ` Limited from ${total} by MONITOR_MAX_AGENTS.`
              : ""
          }`,
          agentCount: agents.length,
          hiddenAgents: total - agents.length,
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
