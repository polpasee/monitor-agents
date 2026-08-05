# Monitor Agents

A local multi-LLM observability portal for following real agent runs across
Codex, Claude Code, and AGY, with Gemini quota monitoring from Antigravity CLI.
The dashboard reads provider state on the same machine, turns parent/child
relationships into a recursive topology, and refreshes the browser every three
seconds.

## What is included

- D3 force-directed agent topology with arbitrary nesting
- Tailwind CSS v4.3 OKLCH palette tokens with accessible dark-mode contrast
- Provider-native spawn relationships and provider-specific visual identity
- Mouse and keyboard node selection with draggable force nodes
- Collapsible branches with an expand-all control
- Agent run inspector with timing, token, context, cost, and execution details
- Reported quota-window progress by provider
- Session KPIs and a recent telemetry event stream
- Shared multi-repository Kanban tasks with atomic Agent claims and leases
- Read-only live collectors with explicit source health
- Responsive desktop and mobile layouts

The runtime does not generate demo agents. Missing sources appear as idle,
unconfigured, or errored, and unavailable costs, quotas, context limits, and
tool counts remain blank instead of being estimated.

## Live sources

- **Codex:** opens `$CODEX_HOME/state_5.sqlite` read-only, selects recent
  non-archived thread families within the agent cap, and streams their rollout
  JSONL. It reads only
  lifecycle, topology, model, effort, working-directory, token, context, rate-limit,
  timestamp, and tool-call identifier fields.
- **Claude Code:** reads `${CLAUDE_CONFIG_DIR:-~/.claude}/sessions`, matching job
  state, usage rows from the matching transcript, subagent metadata at any
  nesting depth (resolved via each subagent's recorded parent, not directory
  location), and fresh rate-limit and effort data captured by
  `scripts/claude-statusline-bridge.mjs`. It shows the eight newest roots and up
  to forty-eight subagents; a subagent kept by that cap always keeps its full
  ancestor chain even if an ancestor falls outside the recency window.
  Pre-warmed background spare sessions — registry entries with no job state
  and no transcript — are excluded.
- **AGY:** remains unconfigured unless `AGY_TELEMETRY_FILE` points to a local JSON
  snapshot. No AGY installation or stable telemetry contract was found, so the
  app does not fabricate one.
- **Gemini usage:** reads the five-hour and weekly quota windows exposed by an
  already-running Antigravity CLI on localhost. The collector does not read or
  refresh OAuth credentials; when the quota summary is unavailable, the weekly
  limit remains blank and the five-hour limit falls back to Antigravity's model
  status.

Collectors never return prompt/message content, reasoning content, tool arguments,
commands, tool output, environment variables, titles, descriptions, or results.
Monetary cost is shown only when a source records an explicit numeric USD value.
Codex roots launched inside `.claude/worktrees/agent-<id>` are linked to a
visible Claude subagent only when that `<id>` identifies exactly one candidate.

## Run locally

Requires Node.js 24 or newer.

```bash
npm install
npm run dev -- --hostname 127.0.0.1 --port 5000
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000).

## Run in production

```bash
npm run build
npm run start -- --hostname 127.0.0.1 --port 5000
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000). On macOS, using the
explicit IPv4 address also avoids the AirPlay service that may own IPv6 port
5000 and return HTTP 403. Run the service as the same operating-system user that
owns the provider state directories and runs Antigravity CLI.

Optional environment variables:

```bash
CODEX_HOME="$HOME/.codex"
CLAUDE_CONFIG_DIR="$HOME/.claude"
CLAUDE_RATE_LIMITS_FILE="$HOME/.claude/usage-status.json"
MONITOR_WORKSPACE="/absolute/path/to/workspace" # exact Codex and Claude cwd filter
MONITOR_MAX_AGENTS=24                           # Codex agent cap across recent families
AGY_TELEMETRY_FILE="/absolute/path/to/agy.json"
ANTIGRAVITY_CLI_DIR="$HOME/.gemini/antigravity-cli" # optional non-default location
MONITOR_TASK_DB="/absolute/path/to/monitor-tasks.sqlite"
MONITOR_AGENT_TOKEN="replace-with-a-long-random-token"
GITHUB_TOKEN="ghp_..."                          # repository list; falls back to `gh auth token`
```

`AGY_TELEMETRY_FILE` accepts the `agents`, `events`, and `quotaLimits` arrays from
the provider-neutral contract in `lib/telemetry.ts`. Values must identify AGY
when a `provider` field is supplied. IDs are automatically namespaced with
`agy:`; unavailable numeric values may be `null`.

## Kanban Agent tasks

Kanban tasks are stored in SQLite so the dashboard and local Agents share one
queue. `MONITOR_TASK_DB` defaults to `.data/monitor-tasks.sqlite`. Use this
SQLite mode with one Next.js server instance; use an external transactional
database before scaling the dashboard to multiple server instances.

The dashboard can create tasks and move them between `todo`, `in-progress`,
`review`, `done`, and `failed`. An Agent must claim a task before working on it.
The claim is atomic, so two Agents cannot receive the same task. Agents only
receive tasks matching the repository names they send in the claim request.

The repository filter and the new-task repository field list every repository the
GitHub account can access (owner, collaborator, and organization member), merged
with the repositories already used by existing tasks. `GET /api/repositories`
reads `GITHUB_TOKEN` or `GH_TOKEN`, falling back to `gh auth token`, and caches
the result for five minutes. Without credentials the dashboard still works and
falls back to the repositories seen on existing tasks.

Agent endpoints fail closed unless `MONITOR_AGENT_TOKEN` is configured. The
token belongs only in the Agent process environment and must not be exposed to
browser code.

Claim the highest-priority available task:

```bash
curl -sS http://127.0.0.1:5000/api/agent/tasks/claim \
  -H "Authorization: Bearer $MONITOR_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"codex-worker-1","repositories":["monitor-agents"],"leaseSeconds":60}'
```

An empty queue returns HTTP `204`. While working, renew the lease before it
expires:

```bash
curl -sS http://127.0.0.1:5000/api/agent/tasks/TASK_ID/heartbeat \
  -H "Authorization: Bearer $MONITOR_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"codex-worker-1","leaseSeconds":60}'
```

Successful work moves to `review` for a human decision:

```bash
curl -sS http://127.0.0.1:5000/api/agent/tasks/TASK_ID/complete \
  -H "Authorization: Bearer $MONITOR_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"codex-worker-1","result":"Commit abc123; tests passed."}'
```

Failed work moves to `failed` and records the error:

```bash
curl -sS http://127.0.0.1:5000/api/agent/tasks/TASK_ID/fail \
  -H "Authorization: Bearer $MONITOR_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"codex-worker-1","error":"Required repository was unavailable."}'
```

If an Agent stops heartbeating, its expired `in-progress` task returns to
`todo` automatically on the next claim. The task text is data, not permission
to execute arbitrary shell commands; each Agent must independently enforce its
repository and command policy.

## Claude task runner

`scripts/kanban-runner.mjs` is a local worker that replaces the manual loop of
opening a repository directory, starting `claude`, and typing the task. It polls
the queue, and for each claimed task it creates a dedicated git worktree, runs
Claude Code headless inside it, commits the result, pushes the branch, and opens
a pull request.

```bash
export MONITOR_AGENT_TOKEN="the-same-token-the-dashboard-uses"
npm run runner                      # poll forever
npm run runner -- --once            # handle at most one task, then exit
npm run runner -- --once --dry-run  # claim and report without running Claude
```

Runner environment variables:

```bash
MONITOR_API_URL="http://127.0.0.1:5000"     # dashboard base URL
MONITOR_WORKSPACE_ROOT="$HOME/Github"       # where repository checkouts live
KANBAN_RUNNER_ID="kanban-runner@$(hostname)" # agent id recorded on each claim
KANBAN_REPOSITORIES=""                      # comma list; empty means every accessible repo
KANBAN_POLL_SECONDS=10
KANBAN_LEASE_SECONDS=300                    # heartbeat renews at half this interval
KANBAN_TASK_TIMEOUT_SECONDS=3600            # Claude is terminated past this
KANBAN_COMMIT_EXCLUDE=".serena,.claude"     # paths never committed
KANBAN_LOG_DIR="$HOME/.claude/kanban-runner"
```

A repository is only claimable when `MONITOR_WORKSPACE_ROOT/<name>` is a git
checkout, so the runner never accepts work it cannot open. `owner/name` maps to
the trailing `name` directory.

Claude runs with `--dangerously-skip-permissions` so tasks finish unattended.
Only queue tasks you would run yourself: task text reaching this runner executes
with your full local privileges.

The runner owns git, and the prompt tells Claude not to commit or push. Each
attempt gets its own branch and worktree (`task/<slug>`, then `task/<slug>-a2`
on retry). Successful tasks move to `review` with the pull request URL in the
result and their worktree removed; failed tasks move to `failed` and keep the
worktree for inspection. Move a failed task back to `todo` to retry it.

## Quality checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Project structure

```text
app/                    Next.js App Router entry and global styles
components/             Interactive dashboard, topology, and inspector
lib/telemetry.ts        Provider-neutral telemetry contract and derivations
lib/live-snapshot.ts    Live collector orchestration
lib/task-store.ts       SQLite Kanban queue and atomic Agent leases
lib/collectors/         Codex, Claude Code, Gemini usage, and AGY adapters
lib/demo-data.ts        Synthetic fixture used only by unit tests
lib/telemetry.test.ts   Domain derivation tests
```
