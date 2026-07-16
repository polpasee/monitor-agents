"use client";

import { useEffect, useMemo, useState } from "react";

import {
  calculateKpis,
  retainTopologyAgents,
  type AgentRun,
  type DashboardSnapshot,
  type EventKind,
} from "@/lib/telemetry";

import { AgentInspector } from "./agent-inspector";
import { Topology } from "./topology";

interface DashboardProps {
  snapshot: DashboardSnapshot;
}

type MetricIconName = "agents" | "tokens" | "cost" | "health";

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const timestamp = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function MetricIcon({ name }: { name: MetricIconName }) {
  const paths: Record<MetricIconName, React.ReactNode> = {
    agents: (
      <>
        <circle cx="8" cy="8" r="3" />
        <circle cx="16" cy="16" r="3" />
        <path d="M10.5 10.5 13.5 13.5M5 19c0-3 1.5-5 4-5M15 5c2.5 0 4 2 4 5" />
      </>
    ),
    tokens: (
      <>
        <path d="m12 3 7.5 4.5v9L12 21l-7.5-4.5v-9L12 3Z" />
        <path d="m4.8 7.7 7.2 4.2 7.2-4.2M12 12v8.5" />
      </>
    ),
    cost: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M15.5 8.5c-.8-.7-1.8-1-3-1-1.7 0-3 .8-3 2s1 1.8 3 2.3 3 1 3 2.4-1.3 2.3-3.2 2.3c-1.3 0-2.5-.4-3.3-1.2M12 5.5v13" />
      </>
    ),
    health: (
      <>
        <path d="M12 3 5 6v5c0 4.6 2.8 8.3 7 10 4.2-1.7 7-5.4 7-10V6l-7-3Z" />
        <path d="m8.5 12 2.2 2.2 4.8-5" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className="metric-card__icon"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      {paths[name]}
    </svg>
  );
}

function ActivityIcon({ kind }: { kind: EventKind }) {
  return (
    <svg
      aria-hidden="true"
      className="activity-item__icon"
      fill="none"
      viewBox="0 0 20 20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
    >
      {kind === "agent.started" ? (
        <path d="m8 5 6 5-6 5V5Z" />
      ) : kind === "agent.completed" ? (
        <path d="m5 10 3 3 7-7" />
      ) : kind === "agent.failed" ? (
        <path d="m6 6 8 8m0-8-8 8" />
      ) : kind === "tool.called" ? (
        <path d="M12.6 5.2a4 4 0 0 0-5.1 5.1l-4.2 4.2 2.2 2.2 4.2-4.2a4 4 0 0 0 5.1-5.1l-2.4 2.4-2.2-2.2 2.4-2.4Z" />
      ) : (
        <path d="M4 14.5V11m4 3.5v-8m4 8V9m4 5.5v-11" />
      )}
    </svg>
  );
}

function isDescendantOf(
  agents: AgentRun[],
  candidateId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  let current = byId.get(candidateId);
  const visited = new Set<string>();

  while (current?.parentId && !visited.has(current.id)) {
    if (current.parentId === ancestorId) {
      return true;
    }

    visited.add(current.id);
    current = byId.get(current.parentId);
  }

  return false;
}

function ActivityPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const events = [...snapshot.events].sort(
    (left, right) => Date.parse(right.at) - Date.parse(left.at),
  );

  return (
    <section className="activity-panel" aria-labelledby="activity-title">
      <header className="panel-header">
        <div>
          <p className="panel-header__eyebrow">Event stream</p>
          <h2 id="activity-title" className="panel-header__title">
            Recent activity
          </h2>
        </div>
        <span className="panel-header__count">{events.length} events</span>
      </header>

      {events.length > 0 ? (
        <ol className="activity-list">
          {events.map((event) => {
            const eventTokens =
              (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
            const hasCost = event.costUsd !== undefined && event.costUsd !== null;

            return (
              <li className="activity-item" key={event.id}>
                <span
                  className="activity-item__marker"
                  data-kind={event.kind}
                >
                  <ActivityIcon kind={event.kind} />
                </span>
                <div className="activity-item__content">
                  <div className="activity-item__heading">
                    <span className="activity-item__agent">
                      {agentsById.get(event.agentId)?.name ?? "Unknown agent"}
                    </span>
                    <time className="activity-item__time" dateTime={event.at}>
                      {timestamp.format(new Date(event.at))} UTC
                    </time>
                  </div>
                  <p className="activity-item__label">{event.label}</p>
                  {(eventTokens > 0 || hasCost) && (
                    <p className="activity-item__meta">
                      {eventTokens > 0 &&
                        `${compactNumber.format(eventTokens)} tokens`}
                      {eventTokens > 0 && hasCost && " · "}
                      {event.costUsd !== undefined && event.costUsd !== null &&
                        `${currency.format(event.costUsd)}`}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="panel-empty-state">
          <p>No events have been recorded for this session.</p>
        </div>
      )}
    </section>
  );
}

export function Dashboard({ snapshot: initialSnapshot }: DashboardProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [collapsedAgentIds, setCollapsedAgentIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    let stopped = false;
    let timeoutId: number | undefined;

    async function refresh() {
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Snapshot request failed with ${response.status}`);
        }

        const nextSnapshot = (await response.json()) as DashboardSnapshot;
        if (!stopped) {
          setSnapshot(nextSnapshot);
        }
      } catch {
        // Retain the last successful snapshot until the next refresh.
      } finally {
        if (!stopped) {
          timeoutId = window.setTimeout(refresh, 3_000);
        }
      }
    }

    timeoutId = window.setTimeout(refresh, 3_000);

    return () => {
      stopped = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  const kpis = useMemo(
    () => calculateKpis(snapshot.agents),
    [snapshot.agents],
  );
  const topologyAgents = useMemo(
    () => retainTopologyAgents(snapshot.agents, snapshot.capturedAt),
    [snapshot.agents, snapshot.capturedAt],
  );
  const selectedAgent =
    snapshot.agents.find((agent) => agent.id === selectedAgentId) ??
    snapshot.agents[0] ??
    null;
  const queuedAgents =
    kpis.totalAgents -
    kpis.runningAgents -
    kpis.idleAgents -
    kpis.completedAgents -
    kpis.abortedAgents -
    kpis.failedAgents;
  const unhealthyAgents = kpis.failedAgents + kpis.abortedAgents;
  const toolCallDetail =
    kpis.knownToolCallAgents === 0
      ? "tool calls not reported"
      : kpis.knownToolCallAgents === kpis.totalAgents
        ? `${kpis.totalToolCalls} tool calls`
        : `${kpis.totalToolCalls} tool calls from ${kpis.knownToolCallAgents}/${kpis.totalAgents} agents`;

  const metrics: Array<{
    label: string;
    value: string;
    detail: string;
    icon: MetricIconName;
    tone: string;
  }> = [
    {
      label: "Active agents",
      value: `${kpis.runningAgents} / ${kpis.totalAgents}`,
      detail: `${kpis.idleAgents} idle · ${kpis.completedAgents} completed · ${queuedAgents} queued`,
      icon: "agents",
      tone: "cyan",
    },
    {
      label: "Token volume",
      value: compactNumber.format(kpis.totalTokens),
      detail: "Input and output combined",
      icon: "tokens",
      tone: "violet",
    },
    {
      label: "Session cost",
      value:
        kpis.knownCostAgents > 0 ? currency.format(kpis.totalCostUsd) : "—",
      detail:
        kpis.knownCostAgents > 0
          ? `${kpis.knownCostAgents} cost reports · ${toolCallDetail}`
          : `Cost not reported · ${toolCallDetail}`,
      icon: "cost",
      tone: "amber",
    },
    {
      label: "Health",
      value: unhealthyAgents === 0 ? "Nominal" : `${unhealthyAgents} flagged`,
      detail:
        unhealthyAgents === 0
          ? "No failed or aborted agents"
          : `${kpis.failedAgents} failed · ${kpis.abortedAgents} aborted`,
      icon: "health",
      tone: unhealthyAgents === 0 ? "green" : "red",
    },
  ];

  function toggleCollapsed(agentId: string) {
    const willCollapse = !collapsedAgentIds.has(agentId);

    if (
      willCollapse &&
      selectedAgentId &&
      isDescendantOf(snapshot.agents, selectedAgentId, agentId)
    ) {
      setSelectedAgentId(agentId);
    }

    setCollapsedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }

  function selectAgent(agentId: string) {
    const agentsById = new Map(
      snapshot.agents.map((agent) => [agent.id, agent]),
    );

    setCollapsedAgentIds((current) => {
      const next = new Set(current);
      let candidate = agentsById.get(agentId);
      let changed = false;

      while (candidate?.parentId) {
        if (next.delete(candidate.parentId)) {
          changed = true;
        }
        candidate = agentsById.get(candidate.parentId);
      }

      return changed ? next : current;
    });
    setSelectedAgentId(agentId);
  }

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div className="dashboard-header__brand">
          <span className="dashboard-header__mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <div>
            <p className="dashboard-header__eyebrow">Agent control plane</p>
            <h1 className="dashboard-header__title">Agent Observatory</h1>
          </div>
        </div>
      </header>

      <div className="dashboard-workspace">
        <div className="dashboard-workspace__main">
          <Topology
            agents={topologyAgents}
            capturedAt={snapshot.capturedAt}
            collapsedAgentIds={collapsedAgentIds}
            onSelectAgent={selectAgent}
            onToggleCollapsed={toggleCollapsed}
            quotaLimits={snapshot.quotaLimits}
            selectedAgentId={selectedAgentId}
          />
          <ActivityPanel snapshot={snapshot} />
        </div>

        <AgentInspector
          agent={selectedAgent}
          agents={snapshot.agents}
          capturedAt={snapshot.capturedAt}
          onSelectAgent={selectAgent}
        />
      </div>

      <section className="metric-grid" aria-label="Session summary">
        {metrics.map((metric) => (
          <article
            className="metric-card"
            data-tone={metric.tone}
            key={metric.label}
          >
            <div className="metric-card__heading">
              <span className="metric-card__label">{metric.label}</span>
              <span className="metric-card__icon-wrap">
                <MetricIcon name={metric.icon} />
              </span>
            </div>
            <strong className="metric-card__value">{metric.value}</strong>
            <span className="metric-card__detail">{metric.detail}</span>
          </article>
        ))}
      </section>
    </main>
  );
}

export default Dashboard;
