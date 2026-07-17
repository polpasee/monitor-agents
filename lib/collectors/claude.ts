import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createInterface } from "node:readline";

import type {
  AgentRun,
  AgentStatus,
  Event,
  QuotaLimit,
} from "../telemetry";
import type { CollectorResult } from "./types";

const MAX_ROOTS = 8;
const MAX_SUBAGENTS = 24;
const MAX_QUOTA_AGE_MS = 15 * 60 * 1_000;
const MAX_TASK_LENGTH = 160;
const MAX_NAME_LENGTH = 32;
const SCAN_CONCURRENCY = 8;
const DEAD_SESSION_GRACE_MS = 2 * 60 * 1_000;

const execFileAsync = promisify(execFile);
const CLAUDE_CONTEXT_LIMIT = 200_000;

type JsonRecord = Record<string, unknown>;

interface Diagnostics {
  errors: number;
}

interface RegistrySession {
  sessionId: string;
  jobId: string | null;
  name: string | null;
  pid: number | null;
  cwd: string;
  status: string | null;
  startedAtMs: number;
  updatedAtMs: number;
}

interface JobState {
  state: string | null;
  tempo: string | null;
  inFlight: number;
  name: string | null;
  model: string | null;
  effort: string | null;
  task: string | null;
  fanLabels: Map<string, string>;
  resumeSessionId: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  linkScanPath: string | null;
  costUsd: number | null;
}

interface TranscriptSummary {
  input: number;
  output: number;
  cached: number;
  contextUsed: number;
  toolCalls: number;
  model: string | null;
  stopReason: string | null;
  firstUserText: string | null;
  firstAtMs: number | null;
  lastAtMs: number | null;
  costUsd: number | null;
}

interface StatusLineSnapshot {
  quotaLimits: QuotaLimit[];
  sessionId: string | null;
  effort: string | null;
}

interface SubagentCandidate {
  agentId: string;
  agentType: string;
  description: string | null;
  fanLabel: string | null;
  workflowId: string | null;
  parentId: string;
  rootStatus: AgentStatus;
  rootEffort: string | null;
  cwd: string;
  transcriptPath: string;
  modifiedAtMs: number;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function timestampMs(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric !== null) {
    const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
    return Number.isFinite(milliseconds) && milliseconds <= 8_640_000_000_000_000
      ? milliseconds
      : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function isMissing(error: unknown): boolean {
  return record(error)?.code === "ENOENT";
}

async function loadStatusLineSnapshot(
  path: string,
  diagnostics: Diagnostics,
): Promise<StatusLineSnapshot> {
  const unavailable = {
    quotaLimits: [],
    sessionId: null,
    effort: null,
  };
  const value = await readJsonRecord(path, diagnostics);
  if (!value) {
    return unavailable;
  }

  const observedAtMs = timestampMs(value.timestamp);
  const ageMs = observedAtMs === null ? null : Date.now() - observedAtMs;
  if (ageMs === null || ageMs < -60_000 || ageMs > MAX_QUOTA_AGE_MS) {
    return unavailable;
  }

  function quota(
    id: string,
    label: string,
    period: QuotaLimit["period"],
    windowHours: number,
    usedValue: unknown,
    resetValue: unknown,
  ): QuotaLimit | null {
    const usedPercent = numberValue(usedValue);
    if (usedPercent === null) {
      return null;
    }

    const resetAtMs = timestampMs(resetValue);
    return {
      id,
      provider: "claude",
      label,
      period,
      windowHours,
      usedTokens: null,
      tokenLimit: null,
      usedCostUsd: null,
      costLimitUsd: null,
      usedPercent: Math.min(usedPercent, 100),
      resetsAt: resetAtMs === null ? null : isoTime(resetAtMs),
    };
  }

  return {
    quotaLimits: [
      quota(
        "claude:quota:primary",
        "Claude 5-hour limit",
        "hour",
        5,
        value.blockPercent,
        value.blockResetAt,
      ),
      quota(
        "claude:quota:secondary",
        "Claude weekly limit",
        "week",
        168,
        value.weeklyPercent,
        value.weeklyResetAt,
      ),
    ].filter((limit): limit is QuotaLimit => limit !== null),
    sessionId: stringValue(value.sessionId),
    effort: stringValue(value.effort),
  };
}

async function readJsonRecord(
  path: string,
  diagnostics: Diagnostics,
  missingIsError = false,
): Promise<JsonRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const value = record(parsed);
    if (!value) {
      diagnostics.errors += 1;
    }
    return value;
  } catch (error) {
    if (missingIsError || !isMissing(error)) {
      diagnostics.errors += 1;
    }
    return null;
  }
}

function safeAgentType(value: unknown): string {
  const candidate = stringValue(value);
  return candidate && /^[a-zA-Z0-9:_-]{1,80}$/.test(candidate)
    ? candidate
    : "subagent";
}

function truncateTask(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  return value.length <= MAX_TASK_LENGTH
    ? value
    : `${value.slice(0, MAX_TASK_LENGTH - 1)}…`;
}

function truncateName(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  return value.length <= MAX_NAME_LENGTH
    ? value
    : `${value.slice(0, MAX_NAME_LENGTH - 1)}…`;
}

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapItem: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapItem(items[index]);
      }
    }),
  );
  return results;
}

function respawnFlagValue(value: JsonRecord, flag: string): string | null {
  const flags = Array.isArray(value.respawnFlags) ? value.respawnFlags : [];
  const index = flags.indexOf(flag);
  return index === -1 ? null : stringValue(flags[index + 1]);
}

function fanLabels(value: JsonRecord): Map<string, string> {
  const labels = new Map<string, string>();
  const fan = Array.isArray(value.fan) ? value.fan : [];
  for (const item of fan) {
    const entry = record(item);
    const id = entry ? stringValue(entry.id) : null;
    const label = entry ? stringValue(entry.label) : null;
    const shortLabel = truncateName(label);
    if (id && shortLabel) {
      labels.set(id, shortLabel);
    }
  }
  return labels;
}

function isControlText(text: string): boolean {
  return (
    text.startsWith("<") ||
    text.startsWith("Caveat:") ||
    text.startsWith("[Request interrupted")
  );
}

function firstPromptText(content: unknown): string | null {
  const texts: string[] = [];
  if (typeof content === "string") {
    const text = stringValue(content);
    if (text) {
      texts.push(text);
    }
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const blockRecord = record(block);
      if (blockRecord?.type === "text") {
        const text = stringValue(blockRecord.text);
        if (text) {
          texts.push(text);
        }
      }
    }
  }

  // Skip system-reminder wrappers, local-command caveats, and interruption
  // markers; the first plain text block carries the actual task prompt.
  return texts.find((text) => !isControlText(text)) ?? null;
}

async function isProcessAlive(pid: number | null): Promise<boolean> {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) {
    return true;
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    return record(error)?.code !== "ESRCH";
  }

  if (process.platform === "win32") {
    return true;
  }

  // The pid exists, but registry pids can be recycled by unrelated
  // processes after a crash or reboot; require a Claude-like command name.
  try {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "comm=",
    ]);
    return /claude|node/iu.test(stdout);
  } catch {
    return true;
  }
}

function explicitCost(value: JsonRecord): number | null {
  for (const key of [
    "costUsd",
    "costUSD",
    "totalCostUsd",
    "total_cost_usd",
  ]) {
    const cost = numberValue(value[key]);
    if (cost !== null) {
      return cost;
    }
  }
  return null;
}

async function loadRegistrySessions(
  sessionsDirectory: string,
  diagnostics: Diagnostics,
): Promise<{ missing: boolean; fileCount: number; sessions: RegistrySession[] }> {
  let entries;
  try {
    entries = await readdir(sessionsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return { missing: true, fileCount: 0, sessions: [] };
    }
    diagnostics.errors += 1;
    return { missing: false, fileCount: 0, sessions: [] };
  }

  const files = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  );
  const sessions = await Promise.all(
    files.map(async (entry): Promise<RegistrySession | null> => {
      const path = join(sessionsDirectory, entry.name);
      const [value, metadata] = await Promise.all([
        readJsonRecord(path, diagnostics, true),
        stat(path).catch(() => {
          diagnostics.errors += 1;
          return null;
        }),
      ]);
      if (!value || !metadata) {
        return null;
      }

      const sessionId = stringValue(value.sessionId);
      if (!sessionId) {
        diagnostics.errors += 1;
        return null;
      }

      const startedAtMs =
        timestampMs(value.startedAt) ?? timestampMs(value.updatedAt) ?? metadata.mtimeMs;
      const updatedAtMs =
        timestampMs(value.updatedAt) ??
        timestampMs(value.statusUpdatedAt) ??
        metadata.mtimeMs;

      return {
        sessionId,
        jobId: stringValue(value.jobId),
        name: truncateName(stringValue(value.name)),
        pid: numberValue(value.pid),
        cwd: stringValue(value.cwd) ?? "unknown",
        status: stringValue(value.status),
        startedAtMs,
        updatedAtMs,
      };
    }),
  );

  return {
    missing: false,
    fileCount: files.length,
    sessions: sessions.filter(
      (session): session is RegistrySession => session !== null,
    ),
  };
}

async function loadJobState(
  claudeDirectory: string,
  session: RegistrySession,
  diagnostics: Diagnostics,
): Promise<JobState | null> {
  if (!session.jobId || basename(session.jobId) !== session.jobId) {
    return null;
  }

  const value = await readJsonRecord(
    join(claudeDirectory, "jobs", session.jobId, "state.json"),
    diagnostics,
  );
  if (!value) {
    return null;
  }

  const inFlight = record(value.inFlight);
  return {
    state: stringValue(value.state),
    tempo: stringValue(value.tempo),
    inFlight:
      (numberValue(inFlight?.tasks) ?? 0) +
      (numberValue(inFlight?.queued) ?? 0),
    name: truncateName(stringValue(value.name)),
    model: truncateName(respawnFlagValue(value, "--model")),
    effort: truncateName(respawnFlagValue(value, "--effort")),
    task: truncateTask(stringValue(value.detail) ?? stringValue(value.intent)),
    fanLabels: fanLabels(value),
    resumeSessionId: stringValue(value.resumeSessionId),
    createdAtMs: timestampMs(value.createdAt),
    updatedAtMs: timestampMs(value.updatedAt),
    linkScanPath: stringValue(value.linkScanPath),
    costUsd: explicitCost(value),
  };
}

function statusFromValues(
  job: JobState | null,
  registryStatus: string | null,
): AgentStatus {
  const jobState = job?.state?.toLowerCase() ?? "";
  const tempo = job?.tempo?.toLowerCase() ?? "";
  const registry = registryStatus?.toLowerCase() ?? "";

  if ([jobState, registry].some((value) => ["failed", "error"].includes(value))) {
    return "failed";
  }
  if (
    [jobState, registry].some((value) =>
      ["aborted", "cancelled", "canceled", "interrupted"].includes(value),
    )
  ) {
    return "aborted";
  }
  if (
    [jobState, registry].some((value) =>
      [
        "done",
        "completed",
        "complete",
        "success",
        "closed",
        "ended",
        "finished",
      ].includes(value),
    )
  ) {
    return "completed";
  }
  if (
    (job?.inFlight ?? 0) > 0 ||
    [jobState, tempo, registry].some((value) =>
      ["running", "working", "active", "busy"].includes(value),
    )
  ) {
    return "running";
  }
  return "idle";
}

function isInside(baseDirectory: string, candidate: string): boolean {
  const pathFromBase = relative(resolve(baseDirectory), resolve(candidate));
  return (
    pathFromBase !== "" &&
    !pathFromBase.startsWith("..") &&
    !isAbsolute(pathFromBase)
  );
}

async function findTranscript(
  projectsDirectory: string,
  session: RegistrySession,
  job: JobState | null,
): Promise<string | null> {
  const transcriptSessionId = job?.resumeSessionId ?? session.sessionId;
  const linkedPath = job?.linkScanPath;
  if (
    linkedPath &&
    basename(linkedPath) === `${transcriptSessionId}.jsonl` &&
    isInside(projectsDirectory, linkedPath)
  ) {
    try {
      if ((await stat(linkedPath)).isFile()) {
        return linkedPath;
      }
    } catch {
      // Fall through to the cwd-derived location.
    }
  }

  if (session.cwd !== "unknown") {
    const encodedCwd = session.cwd.replace(/[^a-zA-Z0-9_-]/g, "-");
    const derivedPath = join(
      projectsDirectory,
      encodedCwd,
      `${transcriptSessionId}.jsonl`,
    );
    try {
      if ((await stat(derivedPath)).isFile()) {
        return derivedPath;
      }
    } catch {
      // A session can exist before its transcript is written.
    }
  }

  return null;
}

async function summarizeTranscript(path: string): Promise<TranscriptSummary> {
  const requests = new Map<
    string,
    {
      input: number;
      output: number;
      cached: number;
      contextUsed: number;
      toolCalls: number;
    }
  >();
  let anonymousRequest = 0;
  let model: string | null = null;
  let stopReason: string | null = null;
  let firstUserText: string | null = null;
  let firstAtMs: number | null = null;
  let lastAtMs: number | null = null;
  let costUsd: number | null = null;
  let latestContextUsed = 0;

  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    let value: JsonRecord | null = null;
    try {
      value = record(JSON.parse(line) as unknown);
    } catch {
      // Claude may still be appending the final JSONL record.
    }
    if (!value) {
      continue;
    }

    const atMs = timestampMs(value.timestamp);
    if (atMs !== null) {
      firstAtMs = firstAtMs === null ? atMs : Math.min(firstAtMs, atMs);
      lastAtMs = lastAtMs === null ? atMs : Math.max(lastAtMs, atMs);
    }

    costUsd = explicitCost(value) ?? costUsd;
    if (
      firstUserText === null &&
      value.type === "user" &&
      value.isMeta !== true
    ) {
      const text = firstPromptText(record(value.message)?.content);
      if (text) {
        firstUserText = truncateTask(text.replace(/\s+/gu, " ").trim());
      }
    }
    if (value.type !== "assistant") {
      continue;
    }

    const message = record(value.message);
    if (!message) {
      continue;
    }

    const messageModel = stringValue(message.model);
    if (messageModel && messageModel !== "<synthetic>") {
      model = messageModel;
    }
    stopReason = stringValue(message.stop_reason) ?? stopReason;

    const content = Array.isArray(message.content) ? message.content : [];
    const toolCalls = content.filter(
      (block) => record(block)?.type === "tool_use",
    ).length;

    const usage = record(message.usage);
    if (!usage) {
      continue;
    }

    const uncachedInput =
      (numberValue(usage.input_tokens) ?? 0) +
      (numberValue(usage.cache_creation_input_tokens) ?? 0);
    const cached = numberValue(usage.cache_read_input_tokens) ?? 0;
    const input = uncachedInput + cached;
    const output = numberValue(usage.output_tokens) ?? 0;
    const requestKey =
      stringValue(value.requestId) ??
      stringValue(message.id) ??
      stringValue(value.uuid) ??
      `anonymous-${anonymousRequest++}`;

    latestContextUsed = input + output;
    const existing = requests.get(requestKey);
    requests.set(requestKey, {
      input,
      output,
      cached,
      contextUsed: latestContextUsed,
      toolCalls: (existing?.toolCalls ?? 0) + toolCalls,
    });
  }

  let input = 0;
  let output = 0;
  let cached = 0;
  let toolCalls = 0;
  for (const usage of requests.values()) {
    input += usage.input;
    output += usage.output;
    cached += usage.cached;
    toolCalls += usage.toolCalls;
  }

  return {
    input,
    output,
    cached,
    contextUsed: latestContextUsed,
    toolCalls,
    model,
    stopReason,
    firstUserText,
    firstAtMs,
    lastAtMs,
    costUsd,
  };
}

async function collectSubagentsInDirectory(
  agentDirectory: string,
  workflowId: string | null,
  parent: AgentRun,
  labels: ReadonlyMap<string, string>,
  diagnostics: Diagnostics,
): Promise<SubagentCandidate[]> {
  let entries;
  try {
    entries = await readdir(agentDirectory, { withFileTypes: true });
  } catch (error) {
    if (!isMissing(error)) {
      diagnostics.errors += 1;
    }
    return [];
  }

  const candidates = await mapWithLimit(
    entries,
    SCAN_CONCURRENCY,
    async (entry): Promise<SubagentCandidate | null> => {
      const match = /^agent-([a-zA-Z0-9_-]+)\.jsonl$/.exec(entry.name);
      if (!entry.isFile() || !match) {
        return null;
      }

      const transcript = join(agentDirectory, entry.name);
      const meta = await readJsonRecord(
        join(agentDirectory, `agent-${match[1]}.meta.json`),
        diagnostics,
      );
      // Older Claude Code versions omit spawnDepth from direct-subagent
      // metadata; only an explicit deeper depth marks a nested spawn.
      const spawnDepth = meta ? numberValue(meta.spawnDepth) : null;
      if (!meta || (spawnDepth !== null && spawnDepth !== 1)) {
        return null;
      }

      try {
        return {
          agentId: match[1],
          agentType: safeAgentType(meta.agentType),
          description: truncateName(stringValue(meta.description)),
          fanLabel: labels.get(match[1]) ?? null,
          workflowId,
          parentId: parent.id,
          rootStatus: parent.status,
          rootEffort: parent.effort,
          cwd: parent.cwd,
          transcriptPath: transcript,
          modifiedAtMs: (await stat(transcript)).mtimeMs,
        };
      } catch (error) {
        if (!isMissing(error)) {
          diagnostics.errors += 1;
        }
        return null;
      }
    },
  );

  return candidates.filter(
    (candidate): candidate is SubagentCandidate => candidate !== null,
  );
}

async function findDirectSubagents(
  transcriptPath: string,
  parent: AgentRun,
  labels: ReadonlyMap<string, string>,
  diagnostics: Diagnostics,
): Promise<SubagentCandidate[]> {
  const subagentsDirectory = join(
    dirname(transcriptPath),
    basename(transcriptPath, ".jsonl"),
    "subagents",
  );
  const candidates = await collectSubagentsInDirectory(
    subagentsDirectory,
    null,
    parent,
    labels,
    diagnostics,
  );

  const workflowsDirectory = join(subagentsDirectory, "workflows");
  let workflowEntries;
  try {
    workflowEntries = await readdir(workflowsDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    if (!isMissing(error)) {
      diagnostics.errors += 1;
    }
    return candidates;
  }

  const workflowCandidates = await mapWithLimit(
    workflowEntries.filter((entry) => entry.isDirectory()),
    SCAN_CONCURRENCY,
    (entry) =>
      collectSubagentsInDirectory(
        join(workflowsDirectory, entry.name),
        entry.name,
        parent,
        labels,
        diagnostics,
      ),
  );

  return candidates.concat(workflowCandidates.flat());
}

function subagentStatus(
  stopReason: string | null,
  rootStatus: AgentStatus,
): AgentStatus {
  const reason = stopReason?.toLowerCase() ?? "";
  if (["error", "failed", "refusal"].includes(reason)) {
    return "failed";
  }
  if (["cancelled", "canceled", "interrupted", "max_tokens"].includes(reason)) {
    return "aborted";
  }
  if (["end_turn", "stop", "stop_sequence"].includes(reason)) {
    return "completed";
  }
  if (["completed", "failed", "aborted"].includes(rootStatus)) {
    return rootStatus;
  }
  if (rootStatus === "running") {
    return "running";
  }
  return "idle";
}

function eventsFor(agents: AgentRun[]): Event[] {
  const events: Event[] = [];
  for (const agent of agents) {
    events.push({
      id: `claude:event:${agent.id}:started`,
      agentId: agent.id,
      kind: "agent.started",
      at: agent.startedAt,
      label: agent.parentId
        ? "Claude direct subagent observed"
        : "Claude session observed",
    });

    if (["completed", "failed", "aborted"].includes(agent.status)) {
      events.push({
        id: `claude:event:${agent.id}:${agent.status}`,
        agentId: agent.id,
        kind:
          agent.status === "failed" || agent.status === "aborted"
            ? "agent.failed"
            : "agent.completed",
        at: agent.endedAt ?? agent.lastActivityAt,
        label: `Claude agent ${agent.status}`,
      });
    }

    if (
      agent.tokenUsage.input > 0 ||
      agent.tokenUsage.output > 0 ||
      agent.costUsd !== null
    ) {
      events.push({
        id: `claude:event:${agent.id}:usage`,
        agentId: agent.id,
        kind: "usage.recorded",
        at: agent.lastActivityAt,
        label: "Claude usage recorded",
        inputTokens: agent.tokenUsage.input,
        outputTokens: agent.tokenUsage.output,
        costUsd: agent.costUsd,
      });
    }
  }
  return events;
}

function emptyResult(
  connection: "idle" | "unconfigured" | "error",
  detail: string,
  quotaLimits: QuotaLimit[],
): CollectorResult {
  return {
    agents: [],
    events: [],
    quotaLimits,
    source: { provider: "claude", connection, detail, agentCount: 0 },
  };
}

export async function collectClaudeTelemetry(): Promise<CollectorResult> {
  const diagnostics: Diagnostics = { errors: 0 };
  const configuredDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  const claudeDirectory = configuredDirectory
    ? resolve(configuredDirectory)
    : join(homedir(), ".claude");
  const configuredWorkspace = process.env.MONITOR_WORKSPACE?.trim();
  const workspace = configuredWorkspace || null;
  const configuredRateLimitsFile = process.env.CLAUDE_RATE_LIMITS_FILE?.trim();
  const statusLine = await loadStatusLineSnapshot(
    configuredRateLimitsFile
      ? resolve(configuredRateLimitsFile)
      : join(claudeDirectory, "usage-status.json"),
    diagnostics,
  );
  const quotaLimits = statusLine.quotaLimits;
  const registry = await loadRegistrySessions(
    join(claudeDirectory, "sessions"),
    diagnostics,
  );

  if (registry.missing) {
    return emptyResult(
      "unconfigured",
      "Claude Code session registry is not configured.",
      quotaLimits,
    );
  }
  if (registry.sessions.length === 0) {
    return emptyResult(
      registry.fileCount > 0 || diagnostics.errors > 0 ? "error" : "idle",
      registry.fileCount > 0 || diagnostics.errors > 0
        ? "Claude Code session registry could not be read."
        : "No Claude Code sessions are currently registered.",
      quotaLimits,
    );
  }

  const matchingSessions =
    workspace === null
      ? registry.sessions
      : registry.sessions.filter((session) => session.cwd === workspace);
  if (matchingSessions.length === 0) {
    return emptyResult(
      "idle",
      "No Claude Code sessions match MONITOR_WORKSPACE.",
      quotaLimits,
    );
  }

  const seenSessionIds = new Set<string>();
  const sessions = matchingSessions
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .filter((session) => {
      if (seenSessionIds.has(session.sessionId)) {
        return false;
      }
      seenSessionIds.add(session.sessionId);
      return true;
    })
    .slice(0, MAX_ROOTS);
  const projectsDirectory = join(claudeDirectory, "projects");
  const agents: AgentRun[] = [];
  const subagentCandidates: SubagentCandidate[] = [];

  for (const session of sessions) {
    const job = await loadJobState(claudeDirectory, session, diagnostics);
    let status = statusFromValues(job, session.status);
    const lastSeenMs = Math.max(session.updatedAtMs, job?.updatedAtMs ?? 0);
    if (
      (status === "running" || status === "idle" || status === "queued") &&
      Date.now() - lastSeenMs > DEAD_SESSION_GRACE_MS &&
      !(await isProcessAlive(session.pid))
    ) {
      status = "completed";
    }
    const transcriptPath = await findTranscript(
      projectsDirectory,
      session,
      job,
    );
    let transcript: TranscriptSummary | null = null;
    if (transcriptPath) {
      try {
        transcript = await summarizeTranscript(transcriptPath);
      } catch {
        diagnostics.errors += 1;
      }
    }

    const startedAtMs = job?.createdAtMs ?? session.startedAtMs;
    const lastActivityAtMs = Math.max(
      session.updatedAtMs,
      job?.updatedAtMs ?? 0,
      transcript?.lastAtMs ?? 0,
    );
    const endedAtMs =
      status === "completed" || status === "failed" || status === "aborted"
        ? (job?.updatedAtMs ?? lastActivityAtMs)
        : null;
    const statusLineEffort =
      statusLine.sessionId === session.sessionId ? statusLine.effort : null;
    const root: AgentRun = {
      id: `claude:${session.sessionId}`,
      parentId: null,
      name:
        session.name ??
        job?.name ??
        `Claude session ${session.sessionId.slice(0, 8)}`,
      provider: "claude",
      model: transcript?.model ?? job?.model ?? "unknown",
      effort: statusLineEffort ?? job?.effort ?? null,
      status,
      task:
        job?.task ??
        transcript?.firstUserText ??
        "Local Claude Code session",
      spawnMethod: "root",
      cwd: session.cwd,
      startedAt: isoTime(startedAtMs),
      endedAt: endedAtMs === null ? null : isoTime(endedAtMs),
      lastActivityAt: isoTime(lastActivityAtMs),
      tokenUsage: {
        input: transcript?.input ?? 0,
        output: transcript?.output ?? 0,
        cached: transcript?.cached ?? 0,
        contextUsed: transcript?.contextUsed ?? 0,
        contextLimit:
          (transcript?.contextUsed ?? 0) > 0 ? CLAUDE_CONTEXT_LIMIT : 0,
      },
      costUsd: job?.costUsd ?? transcript?.costUsd ?? null,
      toolCalls: transcript?.toolCalls ?? null,
    };
    agents.push(root);

    if (transcriptPath) {
      subagentCandidates.push(
        ...(await findDirectSubagents(
          transcriptPath,
          root,
          job?.fanLabels ?? new Map(),
          diagnostics,
        )),
      );
    }
  }

  for (const candidate of subagentCandidates
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
    .slice(0, MAX_SUBAGENTS)) {
    let transcript: TranscriptSummary;
    try {
      transcript = await summarizeTranscript(candidate.transcriptPath);
    } catch {
      diagnostics.errors += 1;
      continue;
    }

    const status = subagentStatus(transcript.stopReason, candidate.rootStatus);
    const startedAtMs = transcript.firstAtMs ?? candidate.modifiedAtMs;
    const lastActivityAtMs = transcript.lastAtMs ?? candidate.modifiedAtMs;
    agents.push({
      id: `${candidate.parentId}:${candidate.agentId}`,
      parentId: candidate.parentId,
      name:
        candidate.description ??
        candidate.fanLabel ??
        truncateName(transcript.firstUserText) ??
        `Claude ${candidate.agentType}`,
      provider: "claude",
      model: transcript.model ?? "unknown",
      effort: candidate.rootEffort,
      status,
      task:
        transcript.firstUserText ??
        (candidate.workflowId
          ? `Workflow ${candidate.workflowId} subagent (${candidate.agentType})`
          : `Direct Claude subagent (${candidate.agentType})`),
      spawnMethod: "native",
      cwd: candidate.cwd,
      startedAt: isoTime(startedAtMs),
      endedAt:
        status === "completed" || status === "failed" || status === "aborted"
          ? isoTime(lastActivityAtMs)
          : null,
      lastActivityAt: isoTime(lastActivityAtMs),
      tokenUsage: {
        input: transcript.input,
        output: transcript.output,
        cached: transcript.cached,
        contextUsed: transcript.contextUsed,
        contextLimit: transcript.contextUsed > 0 ? CLAUDE_CONTEXT_LIMIT : 0,
      },
      costUsd: transcript.costUsd,
      toolCalls: transcript.toolCalls,
    });
  }

  const running = agents.some((agent) => agent.status === "running");
  const warning = diagnostics.errors > 0
    ? ` ${diagnostics.errors} optional telemetry file${diagnostics.errors === 1 ? " was" : "s were"} unreadable.`
    : "";
  return {
    agents,
    events: eventsFor(agents),
    quotaLimits,
    source: {
      provider: "claude",
      connection: running ? "connected" : "idle",
      detail: `Loaded ${sessions.length} Claude session${sessions.length === 1 ? "" : "s"} and ${agents.length - sessions.length} direct subagent${agents.length - sessions.length === 1 ? "" : "s"}.${warning}`,
      agentCount: agents.length,
    },
  };
}
