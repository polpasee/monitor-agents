import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import {
  claudeWorktreeAgentId,
  type AgentRun,
  type AgentStatus,
  type Event,
  type QuotaLimit,
} from "../telemetry.ts";
import type { CollectorResult } from "./types.ts";

const DEFAULT_MAX_AGENTS = 24;
const STALE_RUNNING_GRACE_MS = 2 * 60 * 1_000;
const TOOL_CALL_TYPES = new Set([
  "custom_tool_call",
  "function_call",
  "tool_search_call",
  "web_search_call",
]);

interface ThreadRow {
  id: string;
  parent_thread_id: string | null;
  rollout_path: string;
  created_at: number;
  created_at_ms: number | null;
  updated_at: number;
  updated_at_ms: number | null;
  cwd: string;
  agent_nickname: string | null;
  agent_role: string | null;
  model: string | null;
  reasoning_effort: string | null;
  thread_source: string | null;
  family_count: number;
}

interface TurnStart {
  turnId: string;
  atMs: number;
}

interface TurnOutcome {
  kind: "complete" | "aborted";
  atMs: number;
}

interface TokenSnapshot {
  input: number;
  output: number;
  cached: number;
  contextUsed: number;
  contextLimit: number;
  atMs: number;
}

interface RateWindow {
  usedPercent: number | null;
  windowMinutes: number;
  resetsAt: string | null;
}

interface RateSnapshot {
  atMs: number;
  primary: RateWindow | null;
  secondary: RateWindow | null;
}

interface ParsedRollout {
  latestStart: TurnStart | null;
  outcomes: Map<string, TurnOutcome>;
  token: TokenSnapshot | null;
  rate: RateSnapshot | null;
  model: string | null;
  effort: string | null;
  cwd: string | null;
  contextLimit: number;
  toolCalls: number;
  malformedLines: number;
  readError: boolean;
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
      provider: "codex",
      connection,
      detail,
      agentCount: 0,
    },
  };
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

function tokenValue(value: unknown): number {
  const number = numberValue(value);
  return number === null ? 0 : Math.max(0, Math.trunc(number));
}

function isoFromMs(value: number): string {
  return new Date(Math.max(0, value)).toISOString();
}

function epochSecondsToIso(value: unknown): string | null {
  const seconds = numberValue(value);
  return seconds === null || seconds < 0 ? null : isoFromMs(seconds * 1_000);
}

function rowTimestampMs(milliseconds: number | null, seconds: number): number {
  return milliseconds !== null && milliseconds > 0
    ? milliseconds
    : Math.max(0, seconds * 1_000);
}

function configuredMaxAgents(): number {
  const parsed = Number.parseInt(process.env.MONITOR_MAX_AGENTS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_AGENTS;
}

function parseRateWindow(value: unknown): RateWindow | null {
  if (!isRecord(value)) {
    return null;
  }

  const windowMinutes = numberValue(value.window_minutes);
  if (windowMinutes === null || windowMinutes <= 0) {
    return null;
  }

  const usedPercent = numberValue(value.used_percent);
  return {
    usedPercent:
      usedPercent === null ? null : Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: epochSecondsToIso(value.resets_at),
  };
}

async function parseRollout(
  rolloutPath: string,
  threadCreatedAtMs: number,
): Promise<ParsedRollout> {
  const parsed: ParsedRollout = {
    latestStart: null,
    outcomes: new Map(),
    token: null,
    rate: null,
    model: null,
    effort: null,
    cwd: null,
    contextLimit: 0,
    toolCalls: 0,
    malformedLines: 0,
    readError: false,
  };
  const toolCallIds = new Set<string>();
  let lineNumber = 0;
  const stream = createReadStream(rolloutPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.length === 0) {
        continue;
      }

      let record: unknown;
      try {
        record = JSON.parse(line) as unknown;
      } catch {
        parsed.malformedLines += 1;
        continue;
      }

      if (!isRecord(record)) {
        continue;
      }

      const timestamp = stringValue(record.timestamp);
      const recordAtMs = timestamp === null ? Number.NaN : Date.parse(timestamp);
      if (!Number.isFinite(recordAtMs) || recordAtMs < threadCreatedAtMs) {
        continue;
      }

      const recordType = stringValue(record.type);
      const payload = record.payload;
      if (!isRecord(payload)) {
        continue;
      }

      if (recordType === "turn_context") {
        parsed.model = stringValue(payload.model) ?? parsed.model;
        parsed.effort = stringValue(payload.effort) ?? parsed.effort;
        parsed.cwd = stringValue(payload.cwd) ?? parsed.cwd;
        continue;
      }

      if (recordType === "response_item") {
        const payloadType = stringValue(payload.type);
        if (payloadType !== null && TOOL_CALL_TYPES.has(payloadType)) {
          const callId =
            stringValue(payload.call_id) ??
            stringValue(payload.id) ??
            `line-${lineNumber}`;
          toolCallIds.add(`${payloadType}:${callId}`);
        }
        continue;
      }

      if (recordType !== "event_msg") {
        continue;
      }

      const eventType = stringValue(payload.type);
      if (eventType === "task_started") {
        const turnId = stringValue(payload.turn_id);
        if (turnId === null) {
          continue;
        }

        const startedAt = numberValue(payload.started_at);
        const atMs = startedAt === null ? recordAtMs : startedAt * 1_000;
        if (parsed.latestStart === null || atMs >= parsed.latestStart.atMs) {
          parsed.latestStart = { turnId, atMs };
        }

        const contextLimit = tokenValue(payload.model_context_window);
        parsed.contextLimit = Math.max(parsed.contextLimit, contextLimit);
        continue;
      }

      if (eventType === "task_complete" || eventType === "turn_aborted") {
        const turnId = stringValue(payload.turn_id);
        if (turnId === null) {
          continue;
        }

        const completedAt = numberValue(payload.completed_at);
        parsed.outcomes.set(turnId, {
          kind: eventType === "task_complete" ? "complete" : "aborted",
          atMs: completedAt === null ? recordAtMs : completedAt * 1_000,
        });
        continue;
      }

      if (eventType !== "token_count") {
        continue;
      }

      const info = payload.info;
      if (isRecord(info)) {
        const total = info.total_token_usage;
        const last = info.last_token_usage;
        const contextLimit = tokenValue(info.model_context_window);
        parsed.contextLimit = Math.max(parsed.contextLimit, contextLimit);

        if (isRecord(total)) {
          const lastTotal = isRecord(last)
            ? tokenValue(last.total_tokens) ||
              tokenValue(last.input_tokens) + tokenValue(last.output_tokens)
            : 0;
          parsed.token = {
            input: tokenValue(total.input_tokens),
            output: tokenValue(total.output_tokens),
            cached: tokenValue(total.cached_input_tokens),
            contextUsed: lastTotal,
            contextLimit: parsed.contextLimit,
            atMs: recordAtMs,
          };
        }
      }

      const rateLimits = payload.rate_limits;
      if (isRecord(rateLimits)) {
        const primary = parseRateWindow(rateLimits.primary);
        const secondary = parseRateWindow(rateLimits.secondary);
        if (primary !== null || secondary !== null) {
          parsed.rate = {
            atMs: recordAtMs,
            primary: primary ?? parsed.rate?.primary ?? null,
            secondary: secondary ?? parsed.rate?.secondary ?? null,
          };
        }
      }
    }
  } catch {
    parsed.readError = true;
  } finally {
    lines.close();
    stream.destroy();
  }

  parsed.toolCalls = toolCallIds.size;
  if (parsed.token !== null) {
    parsed.token.contextLimit = Math.max(
      parsed.token.contextLimit,
      parsed.contextLimit,
    );
  }
  return parsed;
}

function deriveLifecycle(
  row: ThreadRow,
  rollout: ParsedRollout,
  isSubagent: boolean,
): { status: AgentStatus; endedAt: string | null } {
  const latestStart = rollout.latestStart;
  if (latestStart === null) {
    return { status: "idle", endedAt: null };
  }

  const outcome = rollout.outcomes.get(latestStart.turnId);
  if (outcome === undefined) {
    const updatedAtMs = rowTimestampMs(row.updated_at_ms, row.updated_at);
    if (Date.now() - updatedAtMs > STALE_RUNNING_GRACE_MS) {
      return { status: "idle", endedAt: null };
    }
    return { status: "running", endedAt: null };
  }
  if (outcome.kind === "aborted") {
    return { status: "aborted", endedAt: isoFromMs(outcome.atMs) };
  }

  return isSubagent || row.thread_source === "subagent"
    ? { status: "completed", endedAt: isoFromMs(outcome.atMs) }
    : { status: "idle", endedAt: null };
}

function agentName(row: ThreadRow, isSubagent: boolean): string {
  if (row.agent_nickname) {
    return row.agent_nickname;
  }
  if (row.agent_role) {
    return `Codex ${row.agent_role}`;
  }
  return isSubagent ? "Codex subagent" : "Codex session";
}

function buildQuotaLimit(
  slot: "primary" | "secondary",
  window: RateWindow,
): QuotaLimit {
  const windowHours = window.windowMinutes / 60;
  const isWeek = window.windowMinutes >= 7 * 24 * 60;
  return {
    id: `codex:quota:${slot}`,
    provider: "codex",
    label: isWeek
      ? "Codex weekly limit"
      : `Codex ${windowHours}-hour limit`,
    period: isWeek ? "week" : "hour",
    windowHours,
    usedTokens: null,
    tokenLimit: null,
    usedCostUsd: null,
    costLimitUsd: null,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
  };
}

function buildEvents(
  agent: AgentRun,
  rawId: string,
  rollout: ParsedRollout,
): Event[] {
  const events: Event[] = [
    {
      id: `codex:event:${rawId}:started`,
      agentId: agent.id,
      kind: "agent.started",
      at: agent.startedAt,
      label: "Codex thread started",
    },
  ];

  if (agent.status === "completed" && agent.endedAt !== null) {
    events.push({
      id: `codex:event:${rawId}:completed`,
      agentId: agent.id,
      kind: "agent.completed",
      at: agent.endedAt,
      label: "Codex subagent completed",
    });
  } else if (agent.status === "aborted" && agent.endedAt !== null) {
    events.push({
      id: `codex:event:${rawId}:aborted`,
      agentId: agent.id,
      kind: "agent.failed",
      at: agent.endedAt,
      label: "Codex turn aborted",
    });
  }

  if (rollout.token !== null) {
    events.push({
      id: `codex:event:${rawId}:usage`,
      agentId: agent.id,
      kind: "usage.recorded",
      at: isoFromMs(rollout.token.atMs),
      label: "Codex token usage recorded",
      inputTokens: rollout.token.input,
      outputTokens: rollout.token.output,
      costUsd: null,
    });
  }

  if (rollout.toolCalls > 0) {
    events.push({
      id: `codex:event:${rawId}:tools`,
      agentId: agent.id,
      kind: "tool.called",
      at: agent.lastActivityAt,
      label: `${rollout.toolCalls} tool calls recorded`,
    });
  }

  return events;
}

export async function collectCodexTelemetry(): Promise<CollectorResult> {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const statePath = join(codexHome, "state_5.sqlite");
  const workspace = process.env.MONITOR_WORKSPACE?.trim() || null;
  const maxAgents = configuredMaxAgents();
  let database: DatabaseSync | null = null;

  if (!existsSync(statePath)) {
    return emptyResult("unconfigured", "Codex state database was not found.");
  }

  try {
    database = new DatabaseSync(statePath, {
      readOnly: true,
      timeout: 1_000,
    });
  } catch {
    return emptyResult(
      "error",
      "Codex state database exists but could not be opened read-only.",
    );
  }

  try {
    const candidateSql = `
      SELECT id
      FROM threads
      WHERE archived = 0
        ${workspace === null ? "" : "AND cwd = ?"}
      ORDER BY COALESCE(NULLIF(updated_at_ms, 0), updated_at * 1000) DESC, id DESC
      LIMIT ?
    `;
    const candidateBindings: Array<string | number> = [];
    if (workspace !== null) {
      candidateBindings.push(workspace);
    }
    candidateBindings.push(maxAgents);
    const candidates = database
      .prepare(candidateSql)
      .all(...candidateBindings) as unknown as { id: string }[];

    if (candidates.length === 0) {
      return emptyResult(
        "idle",
        workspace === null
          ? "No non-archived Codex threads were found."
          : "No non-archived Codex threads match MONITOR_WORKSPACE.",
      );
    }

    const parentSql = `
      SELECT edge.parent_thread_id
      FROM thread_spawn_edges AS edge
      JOIN threads AS parent ON parent.id = edge.parent_thread_id
      WHERE edge.child_thread_id = ?
        AND parent.archived = 0
        ${workspace === null ? "" : "AND parent.cwd = ?"}
      LIMIT 1
    `;
    const parentStatement = database.prepare(parentSql);
    const rootIds: string[] = [];
    const includedRoots = new Set<string>();
    for (const candidate of candidates) {
      const visited = new Set<string>();
      let rootId = candidate.id;
      while (!visited.has(rootId)) {
        visited.add(rootId);
        const parent = parentStatement.get(
          rootId,
          ...(workspace === null ? [] : [workspace]),
        ) as { parent_thread_id: string } | undefined;
        if (parent === undefined) {
          break;
        }
        rootId = parent.parent_thread_id;
      }
      if (!includedRoots.has(rootId)) {
        includedRoots.add(rootId);
        rootIds.push(rootId);
      }
    }

    const rootValues = rootIds.map(() => "(?, ?)").join(", ");
    const familySql = `
      WITH RECURSIVE roots(id, root_rank) AS (
        VALUES ${rootValues}
      ),
      family(id, depth, path, root_rank) AS (
        SELECT roots.id, 0, ',' || roots.id || ',', roots.root_rank
        FROM roots
        UNION ALL
        SELECT edge.child_thread_id,
               family.depth + 1,
               family.path || edge.child_thread_id || ',',
               family.root_rank
        FROM family
        JOIN thread_spawn_edges AS edge ON edge.parent_thread_id = family.id
        JOIN threads AS child ON child.id = edge.child_thread_id
        WHERE child.archived = 0
          ${workspace === null ? "" : "AND child.cwd = ?"}
          AND instr(family.path, ',' || edge.child_thread_id || ',') = 0
      )
      SELECT thread.id,
             edge.parent_thread_id,
             thread.rollout_path,
             thread.created_at,
             thread.created_at_ms,
             thread.updated_at,
             thread.updated_at_ms,
             thread.cwd,
             thread.agent_nickname,
             thread.agent_role,
             thread.model,
             thread.reasoning_effort,
             thread.thread_source,
             COUNT(*) OVER () AS family_count
      FROM family
      JOIN threads AS thread ON thread.id = family.id
      LEFT JOIN thread_spawn_edges AS edge ON edge.child_thread_id = thread.id
      ORDER BY family.depth ASC,
               COALESCE(NULLIF(thread.updated_at_ms, 0), thread.updated_at * 1000) DESC,
               family.root_rank ASC,
               thread.id ASC
      LIMIT ?
    `;
    const familyBindings: Array<string | number> = rootIds.flatMap(
      (rootId, index) => [rootId, index],
    );
    if (workspace !== null) {
      familyBindings.push(workspace);
    }
    familyBindings.push(maxAgents);
    const rows = database.prepare(familySql).all(...familyBindings) as unknown as
      | ThreadRow[];

    if (rows.length === 0) {
      return emptyResult("idle", "The selected Codex thread families are empty.");
    }

    const includedIds = new Set(rows.map((row) => row.id));
    const parsedRows = await Promise.all(
      rows.map(async (row) => ({
        row,
        rollout: await parseRollout(
          row.rollout_path,
          rowTimestampMs(row.created_at_ms, row.created_at),
        ),
      })),
    );
    const quotaRows = database
      .prepare(
        `SELECT rollout_path, created_at, created_at_ms
         FROM threads
         WHERE archived = 0
         ORDER BY COALESCE(NULLIF(updated_at_ms, 0), updated_at * 1000) DESC
         LIMIT ?`,
      )
      .all(maxAgents) as unknown as Pick<
      ThreadRow,
      "rollout_path" | "created_at" | "created_at_ms"
    >[];
    const quotaRollouts = await Promise.all(
      quotaRows.map((row) =>
        parseRollout(
          row.rollout_path,
          rowTimestampMs(row.created_at_ms, row.created_at),
        ),
      ),
    );

    const agents: AgentRun[] = [];
    const events: Event[] = [];
    let latestRate: RateSnapshot | null = null;
    let unavailableRollouts = 0;
    let malformedLines = 0;

    for (const { row, rollout } of parsedRows) {
      unavailableRollouts += rollout.readError ? 1 : 0;
      malformedLines += rollout.malformedLines;
      const hasParent =
        row.parent_thread_id !== null && includedIds.has(row.parent_thread_id);
      const cwd = rollout.cwd ?? row.cwd;
      const isClaudeWorktreeRoot =
        !hasParent && claudeWorktreeAgentId(cwd) !== null;
      const isSubagent = hasParent || isClaudeWorktreeRoot;
      const lifecycle = deriveLifecycle(row, rollout, isSubagent);
      const startedAtMs = rowTimestampMs(row.created_at_ms, row.created_at);
      const updatedAtMs = rowTimestampMs(row.updated_at_ms, row.updated_at);
      const token = rollout.token;
      const agent: AgentRun = {
        id: `codex:${row.id}`,
        parentId: hasParent ? `codex:${row.parent_thread_id}` : null,
        name: agentName(row, isSubagent),
        provider: "codex",
        model: rollout.model ?? row.model ?? "unknown",
        effort: rollout.effort ?? row.reasoning_effort,
        status: lifecycle.status,
        task: isSubagent ? "Codex subagent" : "Codex session",
        spawnMethod: hasParent
          ? "native"
          : isClaudeWorktreeRoot
            ? "bash"
            : "root",
        cwd,
        startedAt: isoFromMs(startedAtMs),
        endedAt: lifecycle.endedAt,
        lastActivityAt: isoFromMs(updatedAtMs),
        tokenUsage: {
          input: token?.input ?? 0,
          output: token?.output ?? 0,
          cached: token?.cached ?? 0,
          contextUsed: token?.contextUsed ?? 0,
          contextLimit: token?.contextLimit ?? rollout.contextLimit,
        },
        costUsd: null,
        toolCalls: rollout.readError ? null : rollout.toolCalls,
      };
      agents.push(agent);
      events.push(...buildEvents(agent, row.id, rollout));
    }

    for (const rollout of quotaRollouts) {
      if (
        rollout.rate !== null &&
        (latestRate === null || rollout.rate.atMs >= latestRate.atMs)
      ) {
        latestRate = rollout.rate;
      }
    }

    const quotaLimits: QuotaLimit[] = [];
    if (latestRate?.primary) {
      quotaLimits.push(buildQuotaLimit("primary", latestRate.primary));
    }
    if (latestRate?.secondary) {
      quotaLimits.push(buildQuotaLimit("secondary", latestRate.secondary));
    }

    events.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
    const familyCount = rows[0]?.family_count ?? rows.length;
    const notes: string[] = [`Loaded ${agents.length} live Codex agents.`];
    if (familyCount > rows.length) {
      notes.push(`Limited from ${familyCount} by MONITOR_MAX_AGENTS.`);
    }
    if (unavailableRollouts > 0) {
      notes.push(`${unavailableRollouts} rollout files could not be read.`);
    }
    if (malformedLines > 0) {
      notes.push(`${malformedLines} malformed rollout records were ignored.`);
    }

    return {
      agents,
      events,
      quotaLimits,
      source: {
        provider: "codex",
        connection: "connected",
        detail: notes.join(" "),
        agentCount: agents.length,
      },
    };
  } catch {
    return emptyResult(
      "error",
      "Codex state exists but its telemetry schema could not be read.",
    );
  } finally {
    database.close();
  }
}
