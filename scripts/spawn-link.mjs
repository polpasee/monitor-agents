#!/usr/bin/env node

// Records the parent of an agent a shell script launches, so the topology does
// not have to infer it.
//
//   node scripts/spawn-link.mjs qwen -y -s -o stream-json -p "$(cat brief.md)"
//
// The parent is `$CLAUDE_CODE_SESSION_ID`, which Claude Code sets for every
// Bash call. The child names itself: run with a streaming JSON output flag, an
// agent CLI prints a `session_id` on its first line, and that id is the one the
// collector shows. The link is appended as soon as that line appears, so a run
// is linked while it is still working, and a retried launch -- a new session id
// each time -- appends a fresh record of its own.
//
// stdout is passed through unchanged, so an existing redirect keeps working.

import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// Providers the dashboard knows how to show. The command name is the prefix of
// the agent id the collector builds, e.g. `qwen:<session id>`.
const PROVIDERS = new Set(["qwen", "codex", "gemini"]);
const SESSION_ID_PATTERN = /"session_id"\s*:\s*"([^"]+)"/u;
// A CLI announces itself immediately; past this much output it never will.
const MAX_SCANNED_BYTES = 256 * 1024;
const SCAN_TAIL_LENGTH = 8 * 1024;

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write(
    "usage: spawn-link.mjs <agent command> [args...]\n",
  );
  process.exit(2);
}

const ledgerPath = join(homedir(), ".monitor-agents", "spawn-links.jsonl");
const parentId = process.env.CLAUDE_CODE_SESSION_ID
  ? `claude:${process.env.CLAUDE_CODE_SESSION_ID}`
  : null;
const provider = PROVIDERS.has(basename(command)) ? basename(command) : null;

async function recordLink(childId) {
  try {
    await mkdir(dirname(ledgerPath), { recursive: true });
    // One short line, opened for append: parallel launches cannot interleave.
    await appendFile(
      ledgerPath,
      `${JSON.stringify({
        childId,
        parentId,
        spawnMethod: "bash",
        at: new Date().toISOString(),
      })}\n`,
    );
  } catch {
    // Recording the parent must never break the run it describes.
  }
}

const child = spawn(command, args, {
  stdio: ["inherit", parentId && provider ? "pipe" : "inherit", "inherit"],
});

let recorded = parentId === null || provider === null ? Promise.resolve() : null;
if (recorded === null) {
  let scan = "";
  let scannedBytes = 0;
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    if (recorded !== null) {
      return;
    }

    scannedBytes += chunk.length;
    scan = (scan + chunk.toString("utf8")).slice(-SCAN_TAIL_LENGTH);
    const sessionId = scan.match(SESSION_ID_PATTERN)?.[1];
    if (sessionId) {
      recorded = recordLink(`${provider}:${sessionId}`);
    } else if (scannedBytes > MAX_SCANNED_BYTES) {
      recorded = Promise.resolve();
    }
  });
}

const exitCode = await new Promise((complete) => {
  child.on("error", () => complete(127));
  child.on("close", (code, signal) => complete(signal ? 1 : (code ?? 0)));
});

await (recorded ?? Promise.resolve());
process.exitCode = exitCode;
