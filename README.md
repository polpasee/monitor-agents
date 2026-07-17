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
  state, usage rows from the matching transcript, direct depth-one subagent
  metadata, and fresh rate-limit and effort data captured by
  `scripts/claude-statusline-bridge.mjs`. It shows the eight newest roots and up
  to twenty-four direct subagents. Pre-warmed background spare sessions —
  registry entries with no job state and no transcript — are excluded.
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
```

`AGY_TELEMETRY_FILE` accepts the `agents`, `events`, and `quotaLimits` arrays from
the provider-neutral contract in `lib/telemetry.ts`. Values must identify AGY
when a `provider` field is supplied. IDs are automatically namespaced with
`agy:`; unavailable numeric values may be `null`.

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
lib/collectors/         Codex, Claude Code, Gemini usage, and AGY adapters
lib/demo-data.ts        Synthetic fixture used only by unit tests
lib/telemetry.test.ts   Domain derivation tests
```
