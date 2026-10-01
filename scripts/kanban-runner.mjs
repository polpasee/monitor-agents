#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  buildTaskPrompt,
  claudeArgs,
  codexArgs,
  formatCompletionResult,
  formatFailure,
  maxResultLength,
  parseClaudeOutput,
  parseClaudeRunMetadata,
  parseCodexOutput,
  parseCodexRunMetadata,
  pullRequestNumberFromUrl,
  repositoryDirectoryName,
  runnerModel,
  stagePathspecs,
  taskBranchName,
  truncate,
} from "../lib/task-runner.ts";

const execFileAsync = promisify(execFile);

const config = {
  apiUrl: (process.env.MONITOR_API_URL ?? "http://127.0.0.1:5001").replace(/\/$/, ""),
  workspaceRoot: process.env.MONITOR_WORKSPACE_ROOT ?? join(process.env.HOME ?? "", "Github"),
  agentId: process.env.KANBAN_RUNNER_ID ?? `kanban-runner@${hostname()}`,
  pollSeconds: Number(process.env.KANBAN_POLL_SECONDS ?? 10),
  leaseSeconds: Number(process.env.KANBAN_LEASE_SECONDS ?? 300),
  taskTimeoutSeconds: Number(process.env.KANBAN_TASK_TIMEOUT_SECONDS ?? 3_600),
  claudeBin: process.env.KANBAN_CLAUDE_BIN ?? "claude",
  codexBin: process.env.KANBAN_CODEX_BIN ?? "codex",
  commitExcludes: (process.env.KANBAN_COMMIT_EXCLUDE ?? ".serena,.claude")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
  logDir: process.env.KANBAN_LOG_DIR ?? join(process.env.HOME ?? "", ".claude", "kanban-runner"),
  usageStatusFile:
    process.env.CLAUDE_RATE_LIMITS_FILE?.trim() ||
    join(
      process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
      "usage-status.json",
    ),
  repositories: (process.env.KANBAN_REPOSITORIES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  once: process.argv.includes("--once"),
  dryRun: process.argv.includes("--dry-run"),
};

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

async function api(path, body) {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${truncate(await response.text(), 300)}`);
  }
  return response.json();
}

async function directoryExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Only repositories with a local checkout are claimable — claiming work the
 * runner cannot open would strand the task in `in-progress` until its lease
 * expires.
 */
async function claimableRepositories() {
  let candidates = config.repositories;
  if (candidates.length === 0) {
    const response = await fetch(`${config.apiUrl}/api/repositories`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Repository list failed with ${response.status}`);
    candidates = (await response.json()).repositories ?? [];
  }

  const available = [];
  for (const repository of candidates) {
    const directory = join(config.workspaceRoot, repositoryDirectoryName(repository));
    if (await directoryExists(join(directory, ".git"))) {
      available.push({ repository, directory });
    }
  }
  return available;
}

async function defaultBaseRef(directory) {
  try {
    await execFileAsync("git", ["fetch", "origin", "--quiet"], { cwd: directory });
    const head = await git(directory, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    return head.replace("refs/remotes/", "");
  } catch {
    return "HEAD";
  }
}

/**
 * The stream never reports the effort level, so it is read from the status
 * file the statusline hook writes, and only when that file still describes the
 * session this task is running.
 */
async function readEffort(sessionId) {
  if (!sessionId) return {};
  try {
    const status = JSON.parse(await readFile(config.usageStatusFile, "utf8"));
    return status?.sessionId === sessionId && typeof status.effort === "string"
      ? { effort: status.effort }
      : {};
  } catch {
    return {};
  }
}

/**
 * The requested model picks the CLI. A task without one runs Claude on its
 * default model, as every task did before models could be requested.
 */
function agentCommand(task, worktree, prompt) {
  const { provider, cli } = runnerModel(task.requestedModel);
  return provider === "codex"
    ? { provider, cli, bin: config.codexBin, args: codexArgs(prompt, cli, task.requestedEffort, worktree) }
    : { provider, cli, bin: config.claudeBin, args: claudeArgs(prompt, cli, task.requestedEffort) };
}

/**
 * Codex never names its model in the stream, so the slug the runner passed is
 * reported, and its effort is the one requested (the collector reads the real
 * value from the thread). Claude's effort comes from the statusline file when
 * that still describes this session.
 */
async function runMetadata(task, provider, cli, stdout) {
  const requestedEffort = task.requestedEffort ? { effort: task.requestedEffort } : {};
  if (provider === "codex") {
    return { ...parseCodexRunMetadata(stdout), model: cli, ...requestedEffort };
  }
  const metadata = parseClaudeRunMetadata(stdout);
  return { ...metadata, ...requestedEffort, ...(await readEffort(metadata.sessionId)) };
}

async function runAgent(bin, args, worktree, logPath, output) {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });

    // Token accounting parses every line, so a multi-byte character split
    // across two chunks must not corrupt the JSON it lands in.
    child.stdout.setEncoding("utf8");

    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += `\nTask exceeded ${config.taskTimeoutSeconds}s and was terminated.`;
    }, config.taskTimeoutSeconds * 1_000);

    child.stdout.on("data", (chunk) => {
      output.stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolvePromise({ code: -1, stdout: output.stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", async (code) => {
      clearTimeout(timeout);
      await writeFile(logPath, output.stdout, "utf8").catch(() => {});
      resolvePromise({ code, stdout: output.stdout, stderr });
    });
  });
}

/** Codex runs carry no Claude attribution in the commit or pull request. */
async function publishChanges(worktree, branch, task, provider) {
  await git(worktree, ["add", "-A", "--", ...stagePathspecs(config.commitExcludes)]);
  const staged = await git(worktree, ["diff", "--cached", "--name-only"]);
  const changedFiles = staged.split("\n").filter(Boolean).length;
  if (changedFiles === 0) return { changedFiles: 0 };

  await git(worktree, [
    "commit",
    "-m",
    provider === "codex"
      ? `${task.title}\n\nQueued Kanban task ${task.id}.`
      : `${task.title}\n\nQueued Kanban task ${task.id}.\n\nCo-Authored-By: Claude <noreply@anthropic.com>`,
  ]);
  await git(worktree, ["push", "-u", "origin", branch]);

  let pullRequestUrl;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "create",
        "--head",
        branch,
        "--title",
        task.title,
        "--body",
        provider === "codex"
          ? `Queued Kanban task \`${task.id}\`.\n\n${task.description || "No description provided."}`
          : `Queued Kanban task \`${task.id}\`.\n\n${task.description || "No description provided."}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
      ],
      { cwd: worktree },
    );
    pullRequestUrl = stdout.trim().split("\n").at(-1);
  } catch (error) {
    log(`Pull request creation failed: ${error.message}`);
  }

  return { changedFiles, pullRequestUrl };
}

async function runTask(task, directory) {
  const attempt = Math.max(1, task.attemptCount ?? 1);
  const branch = taskBranchName(task, attempt);
  const name = branch.replace("task/", "");
  const worktree = resolve(directory, ".claude/worktrees", name);
  const logPath = join(config.logDir, `${name}.jsonl`);
  const output = { stdout: "" };
  let heartbeat;

  try {
    // An unknown model must reach the fail report below, so this runs inside
    // the try and the heartbeat starts once the provider is known.
    const { provider, cli, bin, args } = agentCommand(task, worktree, buildTaskPrompt(task));
    heartbeat = setInterval(() => {
      runMetadata(task, provider, cli, output.stdout)
        .then((metadata) =>
          api(`/api/agent/tasks/${encodeURIComponent(task.id)}/heartbeat`, {
            agentId: config.agentId,
            leaseSeconds: config.leaseSeconds,
            ...metadata,
          }),
        )
        .catch((error) => log(`Heartbeat failed: ${error.message}`));
    }, Math.max(15, Math.floor(config.leaseSeconds / 2)) * 1_000);

    const base = await defaultBaseRef(directory);
    await git(directory, ["worktree", "add", "-b", branch, worktree, base]);
    log(`Worktree ${worktree} on ${branch} from ${base}`);

    const run = await runAgent(bin, args, worktree, logPath, output);
    const { result, isError } = (provider === "codex" ? parseCodexOutput : parseClaudeOutput)(run.stdout);
    const metadata = await runMetadata(task, provider, cli, run.stdout);

    if (run.code !== 0 || isError) {
      await api(`/api/agent/tasks/${encodeURIComponent(task.id)}/fail`, {
        agentId: config.agentId,
        error: formatFailure(
          `${provider} exited with code ${run.code}. Worktree kept at ${worktree}.`,
          `${result}\n${truncate(run.stderr, 1_000)}`,
        ),
        ...metadata,
      });
      log(`Task ${task.id} failed; worktree kept for inspection.`);
      return;
    }

    const published = await publishChanges(worktree, branch, task, provider);
    await api(`/api/agent/tasks/${encodeURIComponent(task.id)}/complete`, {
      agentId: config.agentId,
      result: formatCompletionResult({
        summary: result,
        branch,
        pullRequestUrl: published.pullRequestUrl,
        changedFiles: published.changedFiles,
      }),
      pullRequestNumber: pullRequestNumberFromUrl(published.pullRequestUrl),
      // An empty summary is left out rather than rejected by the API.
      summary: truncate(result, maxResultLength) || undefined,
      ...metadata,
    });
    log(`Task ${task.id} moved to review queue${published.pullRequestUrl ? ` (${published.pullRequestUrl})` : ""}`);

    await execFileAsync("git", ["worktree", "remove", worktree, "--force"], { cwd: directory })
      .catch((error) => log(`Worktree cleanup skipped: ${error.message}`));
  } catch (error) {
    await api(`/api/agent/tasks/${encodeURIComponent(task.id)}/fail`, {
      agentId: config.agentId,
      error: formatFailure("The task runner could not finish this task.", error.message),
    }).catch((failure) => log(`Failure report failed: ${failure.message}`));
    log(`Task ${task.id} errored: ${error.message}`);
  } finally {
    clearInterval(heartbeat);
  }
}

async function main() {
  await mkdir(config.logDir, { recursive: true });
  log(`Runner ${config.agentId} polling ${config.apiUrl} every ${config.pollSeconds}s`);

  for (;;) {
    try {
      const targets = await claimableRepositories();
      if (targets.length === 0) {
        log(`No checkouts found under ${config.workspaceRoot}.`);
      } else {
        const task = await api("/api/agent/tasks/claim", {
          agentId: config.agentId,
          repositories: targets.map((target) => target.repository),
          leaseSeconds: config.leaseSeconds,
        });

        if (task) {
          const target = targets.find((entry) => entry.repository === task.repository);
          log(`Claimed ${task.id} — ${task.title} (${task.repository})`);
          if (config.dryRun) {
            const prompt = buildTaskPrompt(task);
            const { provider, bin, args } = agentCommand(task, "<worktree>", prompt);
            log(
              `Dry run: would run ${provider} in ${target.directory}: ${bin} ${args.map((arg) => (arg === prompt ? "<prompt>" : arg)).join(" ")}`,
            );
          } else {
            await runTask(task, target.directory);
          }
        }
      }
    } catch (error) {
      log(`Poll failed: ${error.message}`);
    }

    if (config.once) return;
    await new Promise((wake) => setTimeout(wake, config.pollSeconds * 1_000));
  }
}

await main();
