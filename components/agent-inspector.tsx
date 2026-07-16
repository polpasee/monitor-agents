"use client";

import {
  durationMs,
  getAgentChildren,
  percent,
  type AgentRun,
  type Provider,
} from "@/lib/telemetry";

interface AgentInspectorProps {
  agent: AgentRun | null;
  agents: AgentRun[];
  capturedAt: string;
  onSelectAgent: (agentId: string) => void;
}

const wholeNumber = new Intl.NumberFormat("en-US");

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const timestamp = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

const providerLabels: Record<Provider, string> = {
  codex: "Codex",
  claude: "Claude",
  agy: "AGY",
  gemini: "Gemini",
};

function labelStatus(status: AgentRun["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }

  return `${seconds}s`;
}

function InspectorStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="inspector-stat">
      <span className="inspector-stat__label">{label}</span>
      <strong className="inspector-stat__value">{value}</strong>
    </div>
  );
}

export function AgentInspector({
  agent,
  agents,
  capturedAt,
  onSelectAgent,
}: AgentInspectorProps) {
  if (!agent) {
    return (
      <aside className="agent-inspector agent-inspector--empty">
        <div className="panel-empty-state">
          <span className="panel-empty-state__glyph" aria-hidden="true">
            ◇
          </span>
          <h2>No agent selected</h2>
          <p>Select a topology node to inspect its run.</p>
        </div>
      </aside>
    );
  }

  const parent = agent.parentId
    ? agents.find((candidate) => candidate.id === agent.parentId) ?? null
    : null;
  const children = getAgentChildren(agents, agent.id);
  const totalTokens = agent.tokenUsage.input + agent.tokenUsage.output;
  const inputShare = percent(agent.tokenUsage.input, totalTokens);
  const outputShare = percent(agent.tokenUsage.output, totalTokens);
  const hasContextLimit = agent.tokenUsage.contextLimit > 0;
  const contextShare = hasContextLimit
    ? percent(agent.tokenUsage.contextUsed, agent.tokenUsage.contextLimit)
    : 0;

  return (
    <aside className="agent-inspector" aria-labelledby="agent-inspector-title">
      <header className="agent-inspector__header">
        <div className="agent-inspector__badges">
          <span className="provider-badge" data-provider={agent.provider}>
            {providerLabels[agent.provider]}
          </span>
          <span className="status-label" data-status={agent.status}>
            <span className="status-label__dot" aria-hidden="true" />
            {labelStatus(agent.status)}
          </span>
        </div>
        <div aria-live="polite">
          <h2 id="agent-inspector-title" className="agent-inspector__title">
            {agent.name}
          </h2>
          <p className="agent-inspector__model">{agent.model}</p>
        </div>
        <p className="agent-inspector__task">{agent.task}</p>
      </header>

      <div className="agent-inspector__body">
        <section
          className="inspector-section"
          aria-labelledby="run-summary-title"
        >
          <h3 id="run-summary-title" className="inspector-section__title">
            Run summary
          </h3>
          <div className="inspector-stat-grid">
            <InspectorStat label="Tokens" value={compactNumber.format(totalTokens)} />
            <InspectorStat
              label="Cost"
              value={
                agent.costUsd === null
                  ? "Not reported"
                  : currency.format(agent.costUsd)
              }
            />
            <InspectorStat
              label="Tool calls"
              value={
                agent.toolCalls === null
                  ? "Not recorded"
                  : wholeNumber.format(agent.toolCalls)
              }
            />
          </div>
        </section>

        <section
          className="inspector-section"
          aria-labelledby="execution-context-title"
        >
          <h3 id="execution-context-title" className="inspector-section__title">
            Execution context
          </h3>
          <dl className="context-list">
            <div className="context-list__row">
              <dt>Agent ID</dt>
              <dd className="context-list__mono">{agent.id}</dd>
            </div>
            <div className="context-list__row">
              <dt>Parent</dt>
              <dd>
                {parent ? (
                  <button
                    className="relation-link"
                    onClick={() => onSelectAgent(parent.id)}
                    type="button"
                  >
                    {parent.name}
                    <span aria-hidden="true">↗</span>
                  </button>
                ) : (
                  <span className="context-list__muted">Root agent</span>
                )}
              </dd>
            </div>
            <div className="context-list__row context-list__row--children">
              <dt>Children</dt>
              <dd>
                {children.length > 0 ? (
                  <span className="relation-list">
                    {children.map((child) => (
                      <button
                        className="relation-link"
                        key={child.id}
                        onClick={() => onSelectAgent(child.id)}
                        type="button"
                      >
                        {child.name}
                        <span aria-hidden="true">↗</span>
                      </button>
                    ))}
                  </span>
                ) : (
                  <span className="context-list__muted">No children</span>
                )}
              </dd>
            </div>
            <div className="context-list__row">
              <dt>Spawned via</dt>
              <dd>
                <span className="spawn-method-badge">
                  {agent.spawnMethod === "root" ? "Root session" : agent.spawnMethod}
                </span>
              </dd>
            </div>
            <div className="context-list__row">
              <dt>Working directory</dt>
              <dd className="context-list__mono">{agent.cwd}</dd>
            </div>
            {agent.spawnCommand && (
              <div className="context-list__row context-list__row--command">
                <dt>Command</dt>
                <dd className="context-list__command">{agent.spawnCommand}</dd>
              </div>
            )}
            <div className="context-list__row">
              <dt>Started</dt>
              <dd>
                <time dateTime={agent.startedAt}>
                  {timestamp.format(new Date(agent.startedAt))} UTC
                </time>
              </dd>
            </div>
            <div className="context-list__row">
              <dt>Last activity</dt>
              <dd>
                <time dateTime={agent.lastActivityAt}>
                  {timestamp.format(new Date(agent.lastActivityAt))} UTC
                </time>
              </dd>
            </div>
            <div className="context-list__row">
              <dt>Duration</dt>
              <dd>{formatDuration(durationMs(agent, capturedAt))}</dd>
            </div>
          </dl>
        </section>

        <section
          className="inspector-section"
          aria-labelledby="token-context-title"
        >
          <div className="inspector-section__heading">
            <h3 id="token-context-title" className="inspector-section__title">
              Token context
            </h3>
            <span className="inspector-section__total">
              {wholeNumber.format(totalTokens)} total
            </span>
          </div>

          <div className="context-meter">
            <div className="context-meter__heading">
              <span>Context window</span>
              <span>
                {compactNumber.format(agent.tokenUsage.contextUsed)} /{" "}
                {hasContextLimit
                  ? compactNumber.format(agent.tokenUsage.contextLimit)
                  : "—"}
              </span>
            </div>
            <progress
              aria-label={`${agent.name} context window usage`}
              className="context-meter__progress"
              max={100}
              value={contextShare}
            />
            <span className="context-meter__caption">
              {hasContextLimit
                ? `${Math.round(contextShare)}% used`
                : "Context limit not reported"}
            </span>
          </div>

          <div className="token-split" aria-label="Input and output token split">
            <span
              className="token-split__input"
              style={{ width: `${inputShare}%` }}
            />
            <span
              className="token-split__output"
              style={{ width: `${outputShare}%` }}
            />
          </div>
          <dl className="token-legend">
            <div className="token-legend__item" data-token-kind="input">
              <dt>Input</dt>
              <dd>
                {wholeNumber.format(agent.tokenUsage.input)}{" "}
                <span>{Math.round(inputShare)}%</span>
              </dd>
            </div>
            <div className="token-legend__item" data-token-kind="output">
              <dt>Output</dt>
              <dd>
                {wholeNumber.format(agent.tokenUsage.output)}{" "}
                <span>{Math.round(outputShare)}%</span>
              </dd>
            </div>
            <div className="token-legend__item" data-token-kind="cached">
              <dt>Cached input</dt>
              <dd>
                {wholeNumber.format(agent.tokenUsage.cached)}{" "}
                <span>
                  {Math.round(
                    percent(agent.tokenUsage.cached, agent.tokenUsage.input),
                  )}
                  % of input
                </span>
              </dd>
            </div>
          </dl>
        </section>

      </div>
    </aside>
  );
}
