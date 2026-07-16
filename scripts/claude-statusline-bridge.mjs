#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function percentage(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, 100)
    : null;
}

function epochSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function string(value) {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : null;
}

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const input = Buffer.concat(chunks).toString("utf8");

try {
  const payload = record(JSON.parse(input));
  const rateLimits = record(payload?.rate_limits);
  const effort = string(record(payload?.effort)?.level);
  const sessionId = string(payload?.session_id);
  const fiveHour = record(rateLimits?.five_hour);
  const sevenDay = record(rateLimits?.seven_day);
  const blockPercent = percentage(fiveHour?.used_percentage);
  const weeklyPercent = percentage(sevenDay?.used_percentage);

  if (
    blockPercent !== null ||
    weeklyPercent !== null ||
    (effort !== null && sessionId !== null)
  ) {
    const configuredDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
    const claudeDirectory = configuredDirectory
      ? resolve(configuredDirectory)
      : join(homedir(), ".claude");
    const configuredFile = process.env.CLAUDE_RATE_LIMITS_FILE?.trim();
    const cachePath = configuredFile
      ? resolve(configuredFile)
      : join(claudeDirectory, "usage-status.json");
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;

    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(
      temporaryPath,
      JSON.stringify({
        blockPercent,
        weeklyPercent,
        blockResetAt: epochSeconds(fiveHour?.resets_at),
        weeklyResetAt: epochSeconds(sevenDay?.resets_at),
        effort,
        sessionId,
        timestamp: Date.now(),
      }),
      { mode: 0o600 },
    );
    await rename(temporaryPath, cachePath);
  }
} catch {
  // Telemetry capture must never break the user's existing status line.
}

const [command, ...args] = process.argv.slice(2);
if (command) {
  const exitCode = await new Promise((complete) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", () => complete(0));
    child.on("exit", (code) => complete(code ?? 0));
    child.stdin.end(input);
  });
  process.exitCode = exitCode;
}
