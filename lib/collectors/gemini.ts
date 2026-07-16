import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { QuotaLimit, QuotaPeriod } from "../telemetry";
import type { CollectorResult } from "./types";

const RPC_SERVICE = "exa.language_server_pb.LanguageServerService";
const RPC_TIMEOUT_MS = 2_500;
const SUCCESS_CACHE_MS = 60_000;
const RETRY_CACHE_MS = 10_000;

type JsonRecord = Record<string, unknown>;

let cachedResult: { expiresAt: number; result: CollectorResult } | null = null;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function fraction(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

function windowHours(value: unknown): number | null {
  if (typeof value === "string") {
    const seconds = value.match(/^(\d+(?:\.\d+)?)s$/u)?.[1];
    if (seconds) {
      return Number(seconds) / 3_600;
    }
  }

  const seconds = record(value)?.seconds;
  return typeof seconds === "number" || typeof seconds === "string"
    ? Number(seconds) / 3_600
    : null;
}

function bucketPeriod(bucket: JsonRecord): QuotaPeriod | null {
  const hours = windowHours(bucket.window);
  const label = `${bucket.displayName ?? ""} ${bucket.description ?? ""}`.toLowerCase();

  if (hours === 5 || /(?:five|5)[ -]?hour/u.test(label)) {
    return "hour";
  }
  if (hours === 168 || label.includes("weekly")) {
    return "week";
  }
  return null;
}

function quotaFromBucket(bucket: JsonRecord): QuotaLimit | null {
  if (bucket.disabled === true) {
    return null;
  }

  const period = bucketPeriod(bucket);
  const remaining =
    fraction(bucket.remainingFraction) ??
    fraction(record(bucket.remaining)?.remainingFraction);
  if (period === null || remaining === null) {
    return null;
  }

  const isWeek = period === "week";
  return {
    id: `gemini:quota:${isWeek ? "secondary" : "primary"}`,
    provider: "gemini",
    label: `Gemini ${isWeek ? "weekly" : "5-hour"} limit`,
    period,
    windowHours: isWeek ? 168 : 5,
    usedTokens: null,
    tokenLimit: null,
    usedCostUsd: null,
    costLimitUsd: null,
    usedPercent: Math.min(100, Math.max(0, (1 - remaining) * 100)),
    resetsAt: timestamp(bucket.resetTime),
  };
}

export function parseGeminiQuotaSummary(value: unknown): QuotaLimit[] {
  const root = record(value);
  const response = record(root?.response) ?? root;
  const groups = Array.isArray(response?.groups) ? response.groups : [];
  const geminiGroup = groups
    .map(record)
    .find((group) =>
      `${group?.displayName ?? ""} ${group?.description ?? ""}`
        .toLowerCase()
        .includes("gemini"),
    );
  const buckets = Array.isArray(geminiGroup?.buckets)
    ? geminiGroup.buckets
    : [];
  const quotas = new Map<QuotaPeriod, QuotaLimit>();

  for (const value of buckets) {
    const bucket = record(value);
    const quota = bucket ? quotaFromBucket(bucket) : null;
    if (quota && !quotas.has(quota.period)) {
      quotas.set(quota.period, quota);
    }
  }

  return [quotas.get("hour"), quotas.get("week")].filter(
    (quota): quota is QuotaLimit => quota !== undefined,
  );
}

export function parseGeminiModelStatus(value: unknown): QuotaLimit | null {
  const root = record(value);
  const userStatus = record(root?.userStatus);
  const modelData = record(userStatus?.cascadeModelConfigData);
  const models = Array.isArray(modelData?.clientModelConfigs)
    ? modelData.clientModelConfigs
    : [];
  let candidate: { remaining: number; resetsAt: string | null } | null = null;

  for (const value of models) {
    const model = record(value);
    if (!String(model?.label ?? "").toLowerCase().startsWith("gemini ")) {
      continue;
    }
    const quota = record(model?.quotaInfo);
    const remaining = fraction(quota?.remainingFraction);
    if (remaining !== null && (!candidate || remaining < candidate.remaining)) {
      candidate = { remaining, resetsAt: timestamp(quota?.resetTime) };
    }
  }

  return candidate
    ? quotaFromBucket({
        displayName: "Five Hour Limit",
        remainingFraction: candidate.remaining,
        resetTime: candidate.resetsAt,
      })
    : null;
}

export function findAntigravityHttpPort(log: string): number | null {
  const matches = [...log.matchAll(/port at (\d+) for HTTP\b/gu)];
  const port = Number(matches.at(-1)?.[1]);
  return Number.isInteger(port) && port >= 1_024 && port <= 65_535
    ? port
    : null;
}

async function activeAntigravityRpcUrls(): Promise<string[]> {
  const directory =
    process.env.ANTIGRAVITY_CLI_DIR?.trim() ||
    join(homedir(), ".gemini", "antigravity-cli");
  let names: string[];
  try {
    names = (await readdir(join(directory, "log")))
      .filter((name) => name.startsWith("cli-") && name.endsWith(".log"))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const urls: string[] = [];
  for (const name of names) {
    try {
      const port = findAntigravityHttpPort(
        await readFile(join(directory, "log", name), "utf8"),
      );
      if (port !== null) {
        urls.push(`http://127.0.0.1:${port}`);
      }
    } catch {
      // Try the next Antigravity CLI log.
    }
  }
  return urls;
}

async function rpc(
  baseUrl: string,
  method: "GetUserStatus" | "RetrieveUserQuotaSummary",
): Promise<unknown | null> {
  try {
    const response = await fetch(`${baseUrl}/${RPC_SERVICE}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify(
        method === "RetrieveUserQuotaSummary"
          ? { request: {}, forceRefresh: false }
          : {},
      ),
      cache: "no-store",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    return response.ok ? ((await response.json()) as unknown) : null;
  } catch {
    return null;
  }
}

function emptyResult(
  connection: "idle" | "error",
  detail: string,
): CollectorResult {
  return {
    agents: [],
    events: [],
    quotaLimits: [],
    source: { provider: "gemini", connection, detail, agentCount: 0 },
  };
}

async function loadGeminiTelemetry(): Promise<CollectorResult> {
  const baseUrls = await activeAntigravityRpcUrls();
  if (baseUrls.length === 0) {
    return emptyResult("idle", "Start Antigravity CLI to load Gemini quota.");
  }

  let summary: unknown | null = null;
  let status: unknown | null = null;

  for (const baseUrl of baseUrls) {
    const [currentSummary, currentStatus] = await Promise.all([
      rpc(baseUrl, "RetrieveUserQuotaSummary"),
      rpc(baseUrl, "GetUserStatus"),
    ]);

    if (currentSummary !== null || currentStatus !== null) {
      summary = currentSummary;
      status = currentStatus;
      break;
    }
  }

  if (summary === null && status === null) {
    return emptyResult(
      "error",
      "Unable to read quota from the running Antigravity CLI.",
    );
  }

  const quotaLimits = parseGeminiQuotaSummary(summary);
  const fallback = parseGeminiModelStatus(status);
  if (!quotaLimits.some((quota) => quota.period === "hour") && fallback) {
    quotaLimits.unshift(fallback);
  }
  if (quotaLimits.length === 0) {
    return emptyResult("idle", "Gemini quota is unavailable from Antigravity CLI.");
  }

  return {
    agents: [],
    events: [],
    quotaLimits,
    source: {
      provider: "gemini",
      connection: "connected",
      detail: quotaLimits.some((quota) => quota.period === "week")
        ? "Loaded Gemini quota from the running Antigravity CLI."
        : "Loaded Gemini five-hour quota; weekly quota is unavailable.",
      agentCount: 0,
    },
  };
}

export async function collectGeminiTelemetry(): Promise<CollectorResult> {
  const now = Date.now();
  if (cachedResult && cachedResult.expiresAt > now) {
    return cachedResult.result;
  }

  const result = await loadGeminiTelemetry();
  const hasWeeklyQuota = result.quotaLimits.some(
    (quota) => quota.period === "week",
  );
  cachedResult = {
    expiresAt:
      now +
      (result.source.connection === "connected" && hasWeeklyQuota
        ? SUCCESS_CACHE_MS
        : RETRY_CACHE_MS),
    result,
  };
  return result;
}
