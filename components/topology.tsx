"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  drag,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  select,
  zoom,
  zoomIdentity,
  type D3DragEvent,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
  type ZoomTransform,
} from "d3";

import {
  buildAgentForest,
  getAgentDepths,
  getAgentGroup,
  type AgentRun,
  type Provider,
  type QuotaLimit,
} from "@/lib/telemetry";
import {
  assignTopologyNodeColors,
  type TopologyNodeColor,
} from "@/lib/topology-colors";

import { ProviderLimits } from "./provider-limits";

interface TopologyProps {
  agents: AgentRun[];
  capturedAt: string;
  quotaLimits: QuotaLimit[];
  selectedAgentId: string | null;
  collapsedAgentIds: ReadonlySet<string>;
  onSelectAgent: (agentId: string) => void;
  onToggleCollapsed: (agentId: string) => void;
}

interface GraphNode extends SimulationNodeDatum {
  id: string;
  agent: AgentRun;
  childCount: number;
  radius: number;
  color: TopologyNodeColor;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  crossProvider: boolean;
  spawnMethod: AgentRun["spawnMethod"];
  targetStatus: AgentRun["status"];
}

interface Dimensions {
  width: number;
  height: number;
}

interface TopologyZoomControls {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

const providerLabels: Record<Provider, string> = {
  codex: "Codex",
  claude: "Claude",
  agy: "AGY",
  gemini: "Gemini",
};

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const ALL_AGENT_GROUPS = "";

function labelStatus(status: AgentRun["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function middleEllipsis(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }

  const available = maximumLength - 1;
  const startLength = Math.ceil(available / 2);
  const endLength = Math.floor(available / 2);
  return `${value.slice(0, startLength)}…${value.slice(-endLength)}`;
}

function shortModelName(model: string): string {
  const ignoredTokens = new Set([
    "agy",
    "anthropic",
    "claude",
    "codex",
    "gemini",
    "gpt",
    "openai",
  ]);
  const tokens = model
    .replace(/-\d{8}$/u, "")
    .toLowerCase()
    .split(/[-/_.]+/u)
    .filter(Boolean);
  const family = tokens.find(
    (token) =>
      !ignoredTokens.has(token) && !/^\d+(?:[a-z])?$/u.test(token),
  );

  return (family ?? tokens[0] ?? model).toUpperCase();
}

function effortLabel(effort: string | null): string {
  if (effort === null) {
    return "";
  }

  return middleEllipsis(effort.toLowerCase() === "medium" ? "med" : effort, 8);
}

function workspaceLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/u, "");
  const leaf = trimmed.split(/[\\/]/u).at(-1) || cwd;
  return middleEllipsis(leaf, 20);
}

function shortAgentId(id: string): string {
  return (id.split(":").at(-1) ?? id).slice(-6);
}

function hexagonPoints(radius: number): string {
  const halfRadius = radius / 2;
  const verticalRadius = (Math.sqrt(3) / 2) * radius;

  return [
    `${radius},0`,
    `${halfRadius},${verticalRadius}`,
    `${-halfRadius},${verticalRadius}`,
    `${-radius},0`,
    `${-halfRadius},${-verticalRadius}`,
    `${halfRadius},${-verticalRadius}`,
  ].join(" ");
}

function visibleAgents(
  agents: AgentRun[],
  collapsedAgentIds: ReadonlySet<string>,
): AgentRun[] {
  const visible: AgentRun[] = [];
  const visited = new Set<string>();

  function visit(node: ReturnType<typeof buildAgentForest>[number]) {
    if (visited.has(node.agent.id)) {
      return;
    }

    visited.add(node.agent.id);
    visible.push(node.agent);

    if (!collapsedAgentIds.has(node.agent.id)) {
      node.children.forEach(visit);
    }
  }

  buildAgentForest(agents).forEach(visit);
  return visible;
}

export function Topology({
  agents,
  capturedAt,
  quotaLimits,
  selectedAgentId,
  collapsedAgentIds,
  onSelectAgent,
  onToggleCollapsed,
}: TopologyProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const positionCacheRef = useRef(
    new Map<string, { normalizedX: number; normalizedY: number }>(),
  );
  const colorAssignmentsRef = useRef(new Map<string, TopologyNodeColor>());
  const zoomTransformRef = useRef<ZoomTransform>(zoomIdentity);
  const zoomControlsRef = useRef<TopologyZoomControls | null>(null);
  const selectedAgentIdRef = useRef(selectedAgentId);
  const actionsRef = useRef({ onSelectAgent, onToggleCollapsed });
  const [dimensions, setDimensions] = useState<Dimensions>({
    width: 928,
    height: 778,
  });
  const [selectedGroupId, setSelectedGroupId] = useState(ALL_AGENT_GROUPS);

  actionsRef.current = { onSelectAgent, onToggleCollapsed };
  selectedAgentIdRef.current = selectedAgentId;

  const agentGroups = useMemo(
    () =>
      buildAgentForest(agents).map((group) => ({
        root: group.agent,
        size: getAgentGroup(agents, group.agent.id).length,
      })),
    [agents],
  );
  const agentGroupIds = useMemo(
    () => new Set(agentGroups.map((group) => group.root.id)),
    [agentGroups],
  );
  const effectiveGroupId = agentGroupIds.has(selectedGroupId)
    ? selectedGroupId
    : ALL_AGENT_GROUPS;
  const groupedAgents = useMemo(
    () =>
      effectiveGroupId === ALL_AGENT_GROUPS
        ? agents
        : getAgentGroup(agents, effectiveGroupId),
    [agents, effectiveGroupId],
  );
  const displayedAgents = useMemo(
    () => visibleAgents(groupedAgents, collapsedAgentIds),
    [groupedAgents, collapsedAgentIds],
  );
  useEffect(() => {
    if (
      selectedGroupId !== ALL_AGENT_GROUPS &&
      !agentGroupIds.has(selectedGroupId)
    ) {
      setSelectedGroupId(ALL_AGENT_GROUPS);
    }
  }, [agentGroupIds, selectedGroupId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    function updateDimensions() {
      const width = Math.max(300, Math.round(container!.clientWidth));
      const baseHeight =
        width < 560 ? 528 : Math.min(672, Math.max(576, width * 0.672));
      const height = Math.round(baseHeight * 1.2);

      setDimensions((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    }

    updateDimensions();
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement || displayedAgents.length === 0) {
      return;
    }

    const { width, height } = dimensions;
    const positionCache = positionCacheRef.current;
    const mobile = width < 560;
    const visibleIds = new Set(displayedAgents.map((agent) => agent.id));
    const colorAssignments = assignTopologyNodeColors(
      colorAssignmentsRef.current,
      displayedAgents.map((agent) => agent.id),
    );
    const childCounts = new Map<string, number>();
    const agentDepths = getAgentDepths(agents);

    for (const agent of agents) {
      if (agent.parentId) {
        childCounts.set(agent.parentId, (childCounts.get(agent.parentId) ?? 0) + 1);
      }
    }

    const orbitalRadius = Math.min(width, height) * (mobile ? 0.24 : 0.28);
    const radiusByDepth = mobile ? [24, 20, 16, 12] : [36, 24, 18, 12];
    const nodes: GraphNode[] = displayedAgents.map((agent, index) => {
      const depth = agentDepths.get(agent.id) ?? 0;
      const radius = radiusByDepth[Math.min(depth, radiusByDepth.length - 1)];
      const cachedPosition = positionCache.get(agent.id);
      const angle = (index / displayedAgents.length) * Math.PI * 2 - Math.PI / 2;
      const isRoot = depth === 0;

      return {
        id: agent.id,
        agent,
        childCount: childCounts.get(agent.id) ?? 0,
        color: colorAssignments.get(agent.id)!,
        radius,
        x: cachedPosition
          ? cachedPosition.normalizedX * width
          : width / 2 + (isRoot ? 0 : Math.cos(angle) * orbitalRadius),
        y: cachedPosition
          ? cachedPosition.normalizedY * height
          : height / 2 + (isRoot ? 0 : Math.sin(angle) * orbitalRadius),
      };
    });
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const links: GraphLink[] = displayedAgents.flatMap((agent) => {
      if (!agent.parentId || !visibleIds.has(agent.parentId)) {
        return [];
      }

      const parent = agents.find((candidate) => candidate.id === agent.parentId);
      if (!parent) {
        return [];
      }

      return [
        {
          source: parent.id,
          target: agent.id,
          crossProvider: parent.provider !== agent.provider,
          spawnMethod: agent.spawnMethod,
          targetStatus: agent.status,
        },
      ];
    });

    const svg = select(svgElement);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    const scene = svg.append("g").attr("class", "force-graph__scene");
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 2.5])
      .extent([
        [0, 0],
        [width, height],
      ])
      .translateExtent([
        [-width / 2, -height / 2],
        [width * 1.5, height * 1.5],
      ])
      .filter(
        (event) =>
          event.type === "wheel" ||
          (event.type === "mousedown" &&
            event.button === 0 &&
            event.target === svgElement),
      )
      .on("zoom", (event) => {
        zoomTransformRef.current = event.transform;
        scene.attr("transform", event.transform.toString());
      });

    svg.call(zoomBehavior);
    svg.call(zoomBehavior.transform, zoomTransformRef.current);

    const link = scene
      .append("g")
      .attr("class", "force-links")
      .selectAll<SVGLineElement, GraphLink>("line")
      .data(links)
      .join("line")
      .attr("class", "force-link")
      .attr("data-cross-provider", (item) => item.crossProvider || null)
      .attr("data-target-status", (item) => item.targetStatus);

    link
      .append("title")
      .text((item) => {
        const source = nodeById.get(
          typeof item.source === "string" ? item.source : item.source.id,
        );
        const target = nodeById.get(
          typeof item.target === "string" ? item.target : item.target.id,
        );
        return source && target
          ? `${source.agent.name} → ${target.agent.name} · ${item.spawnMethod}`
          : item.spawnMethod;
      });

    const crossProviderLabel = scene
      .append("g")
      .attr("class", "force-link-labels")
      .selectAll<SVGTextElement, GraphLink>("text")
      .data(links.filter((item) => item.crossProvider))
      .join("text")
      .attr("class", "force-link__label")
      .text((item) => item.spawnMethod);

    const nodeLayer = scene.append("g").attr("class", "force-nodes");
    const node = nodeLayer
      .selectAll<SVGGElement, GraphNode>("g")
      .data(nodes, (item) => item.id)
      .join("g")
      .attr("class", "force-node")
      .attr("data-node-color", (item) => item.color)
      .attr("data-provider", (item) => item.agent.provider)
      .attr("data-status", (item) => item.agent.status)
      .attr("data-agent-id", (item) => item.id)
      .attr("data-selected", (item) =>
        item.id === selectedAgentIdRef.current ? "true" : null,
      )
      .attr("role", "button")
      .attr("tabindex", 0)
      .attr("aria-pressed", (item) => item.id === selectedAgentIdRef.current)
      .attr(
        "aria-label",
        (item) =>
          `${item.agent.name}, ${providerLabels[item.agent.provider]}, model ${item.agent.model}, effort ${item.agent.effort ?? "not reported"}, ${labelStatus(item.agent.status)}, workspace ${workspaceLabel(item.agent.cwd)}, ${compactNumber.format(item.agent.tokenUsage.input + item.agent.tokenUsage.output)} tokens${item.childCount ? `, ${item.childCount} child agents` : ""}`,
      )
      .on("click", (event, item) => {
        if (!event.defaultPrevented) {
          actionsRef.current.onSelectAgent(item.id);
        }
      })
      .on("mouseenter", function () {
        select(this).raise();
      })
      .on("keydown", (event, item) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          actionsRef.current.onSelectAgent(item.id);
        }

        if (
          item.childCount > 0 &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")
        ) {
          event.preventDefault();
          actionsRef.current.onToggleCollapsed(item.id);
        }
      });

    node
      .append("polygon")
      .attr("class", "force-node__selection-ring")
      .attr("points", (item) => hexagonPoints(item.radius + 12));

    node
      .append("polygon")
      .attr("class", "force-node__outer-pulse-ring")
      .attr("points", (item) => hexagonPoints(item.radius + 9));

    node
      .append("polygon")
      .attr("class", "force-node__pulse-ring")
      .attr("points", (item) => hexagonPoints(item.radius + 6));

    node
      .append("polygon")
      .attr("class", "force-node__status-ring")
      .attr("points", (item) => hexagonPoints(item.radius + 3));

    node
      .append("polygon")
      .attr("class", "force-node__hexagon")
      .attr("points", (item) => hexagonPoints(item.radius));

    node
      .append("polygon")
      .attr("class", "force-node__inner-ring")
      .attr("points", (item) => hexagonPoints(item.radius - 3));

    node
      .append("text")
      .attr("class", "force-node__model")
      .attr("dy", (item) => (item.agent.effort === null ? null : "0.2em"))
      .attr("dominant-baseline", (item) =>
        item.agent.effort === null ? "middle" : null,
      )
      .attr("y", (item) => (item.agent.effort === null ? 0 : -2))
      .text((item) => shortModelName(item.agent.model));

    node
      .append("text")
      .attr("class", "force-node__effort")
      .attr("dy", "0.3em")
      .attr("y", 7)
      .text((item) => effortLabel(item.agent.effort));

    node
      .append("text")
      .attr("class", "force-node__name")
      .attr("y", (item) => item.radius + 18)
      .text((item) => item.agent.name);

    node
      .append("title")
      .text(
        (item) =>
          `${item.agent.name}\n${item.agent.task}\n${labelStatus(item.agent.status)} · ${item.agent.model}\nEffort: ${item.agent.effort ?? "not reported"}\nWorktree/repo: ${item.agent.cwd}`,
      );

    const simulation = forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(links)
          .id((item) => item.id)
          .distance((item) =>
            mobile ? (item.crossProvider ? 92 : 76) : item.crossProvider ? 112 : 92,
          )
          .strength(0.7),
      )
      .force("charge", forceManyBody().strength(mobile ? -190 : -260))
      .force(
        "collide",
        forceCollide<GraphNode>()
          .radius((item) => item.radius + (mobile ? 18 : 22))
          .strength(0.95)
          .iterations(2),
      )
      .force("center", forceCenter(width / 2, height / 2))
      .force("x", forceX<GraphNode>(width / 2).strength(0.035))
      .force("y", forceY<GraphNode>(height / 2).strength(0.045))
      .stop();

    function resolvedNode(value: string | GraphNode): GraphNode {
      return typeof value === "string" ? nodeById.get(value)! : value;
    }

    function ticked() {
      const horizontalPadding = mobile ? 60 : 64;
      const verticalPadding = mobile ? 48 : 62;

      for (const item of nodes) {
        item.x = clamp(item.x ?? width / 2, horizontalPadding, width - horizontalPadding);
        item.y = clamp(item.y ?? height / 2, verticalPadding, height - verticalPadding);
      }

      link
        .attr("x1", (item) => resolvedNode(item.source).x ?? 0)
        .attr("y1", (item) => resolvedNode(item.source).y ?? 0)
        .attr("x2", (item) => resolvedNode(item.target).x ?? 0)
        .attr("y2", (item) => resolvedNode(item.target).y ?? 0);

      crossProviderLabel
        .attr(
          "x",
          (item) =>
            ((resolvedNode(item.source).x ?? 0) +
              (resolvedNode(item.target).x ?? 0)) /
            2,
        )
        .attr(
          "y",
          (item) =>
            ((resolvedNode(item.source).y ?? 0) +
              (resolvedNode(item.target).y ?? 0)) /
              2 -
            7,
        );

      node.attr(
        "transform",
        (item) => `translate(${item.x ?? 0} ${item.y ?? 0})`,
      );
    }

    for (let index = 0; index < 140; index += 1) {
      simulation.tick();
    }
    ticked();

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    function fitTopology() {
      const bounds = nodeLayer.node()?.getBBox();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        return;
      }

      const padding = mobile ? 28 : 40;
      const scale = clamp(
        Math.min(
          (width - padding * 2) / bounds.width,
          (height - padding * 2) / bounds.height,
        ),
        0.5,
        2.5,
      );
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      const transform = zoomIdentity
        .translate(width / 2, height / 2)
        .scale(scale)
        .translate(-centerX, -centerY);

      svg.interrupt();
      if (reducedMotion) {
        svg.call(zoomBehavior.transform, transform);
      } else {
        svg
          .transition()
          .duration(180)
          .call(zoomBehavior.transform, transform);
      }
    }

    function zoomBy(factor: number) {
      svg.interrupt();
      if (reducedMotion) {
        svg.call(zoomBehavior.scaleBy, factor);
      } else {
        svg.transition().duration(160).call(zoomBehavior.scaleBy, factor);
      }
    }

    const controls: TopologyZoomControls = {
      fit: fitTopology,
      zoomIn: () => zoomBy(1.25),
      zoomOut: () => zoomBy(0.8),
    };
    zoomControlsRef.current = controls;

    function dragStarted(
      this: SVGGElement,
      event: D3DragEvent<SVGGElement, GraphNode, GraphNode>,
      item: GraphNode,
    ) {
      event.sourceEvent.stopPropagation();
      select(this).classed("is-dragging", true);
      if (!event.active) {
        simulation.alphaTarget(0.28).restart();
      }
      item.fx = item.x;
      item.fy = item.y;
    }

    function dragged(
      event: D3DragEvent<SVGGElement, GraphNode, GraphNode>,
      item: GraphNode,
    ) {
      const horizontalPadding = mobile ? 60 : 64;
      const verticalPadding = mobile ? 48 : 62;
      item.fx = clamp(event.x, horizontalPadding, width - horizontalPadding);
      item.fy = clamp(event.y, verticalPadding, height - verticalPadding);
    }

    function dragEnded(
      this: SVGGElement,
      event: D3DragEvent<SVGGElement, GraphNode, GraphNode>,
      item: GraphNode,
    ) {
      select(this).classed("is-dragging", false);
      if (!event.active) {
        simulation.alphaTarget(0);
      }
      item.fx = null;
      item.fy = null;
    }

    node.call(
      drag<SVGGElement, GraphNode>()
        .clickDistance(5)
        .on("start", dragStarted)
        .on("drag", dragged)
        .on("end", dragEnded),
    );

    simulation.alpha(0.22).on("tick", ticked).restart();

    return () => {
      if (zoomControlsRef.current === controls) {
        zoomControlsRef.current = null;
      }
      svg.interrupt();
      for (const item of nodes) {
        positionCache.set(item.id, {
          normalizedX: clamp((item.x ?? width / 2) / width, 0, 1),
          normalizedY: clamp((item.y ?? height / 2) / height, 0, 1),
        });
      }
      simulation.stop();
      node.on(".drag", null);
      svg.on(".zoom", null);
      svg.selectAll("*").remove();
    };
  }, [agents, collapsedAgentIds, dimensions, displayedAgents]);

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement) {
      return;
    }

    const nodes = select(svgElement).selectAll<SVGGElement, GraphNode>(
      ".force-node",
    );
    nodes
      .attr("data-selected", (item) =>
        item.id === selectedAgentId ? "true" : null,
      )
      .attr("aria-pressed", (item) => item.id === selectedAgentId);
    nodes.filter((item) => item.id === selectedAgentId).raise();
  }, [selectedAgentId]);

  return (
    <section className="topology-panel" aria-labelledby="topology-title">
      <header className="panel-header topology-panel__header">
        <h2
          id="topology-title"
          className="panel-header__eyebrow topology-panel__title"
        >
          Live session
        </h2>
        <label className="sr-only" htmlFor="topology-agent-group">
          Agent group
        </label>
        <select
          className="topology-panel__group-select"
          disabled={agentGroups.length === 0}
          id="topology-agent-group"
          onChange={(event) => {
            const groupId = event.target.value;
            setSelectedGroupId(groupId);
            if (groupId !== ALL_AGENT_GROUPS) {
              onSelectAgent(groupId);
              if (collapsedAgentIds.has(groupId)) {
                onToggleCollapsed(groupId);
              }
            }
          }}
          value={effectiveGroupId}
        >
          <option value={ALL_AGENT_GROUPS}>
            All groups ({agents.length})
          </option>
          {agentGroups.map((group) => (
            <option key={group.root.id} value={group.root.id}>
              {workspaceLabel(group.root.cwd)} · {providerLabels[group.root.provider]} · {shortAgentId(group.root.id)} ({group.size})
            </option>
          ))}
        </select>
      </header>

      {displayedAgents.length > 0 ? (
        <div className="force-graph-viewport" ref={containerRef}>
          <ProviderLimits capturedAt={capturedAt} quotaLimits={quotaLimits} />
          <svg
            aria-label={`Agent force topology with ${displayedAgents.length} visible agents. Drag the background to pan, drag nodes to rearrange, and scroll to zoom.`}
            className="force-graph"
            height={dimensions.height}
            ref={svgRef}
            role="group"
            viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            width={dimensions.width}
          />
          <div
            aria-label="Topology zoom controls"
            className="force-graph__controls"
            role="group"
          >
            <button
              aria-label="Fit topology to view"
              className="force-graph__control"
              onClick={() => zoomControlsRef.current?.fit()}
              title="Fit topology to view"
              type="button"
            >
              <svg
                aria-hidden="true"
                className="force-graph__control-icon"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
                viewBox="0 0 16 16"
              >
                <path d="M6 3H3v3m7-3h3v3m0 4v3h-3m-4 0H3v-3" />
              </svg>
            </button>
            <button
              aria-label="Zoom in"
              className="force-graph__control"
              onClick={() => zoomControlsRef.current?.zoomIn()}
              title="Zoom in"
              type="button"
            >
              +
            </button>
            <button
              aria-label="Zoom out"
              className="force-graph__control"
              onClick={() => zoomControlsRef.current?.zoomOut()}
              title="Zoom out"
              type="button"
            >
              −
            </button>
          </div>
        </div>
      ) : (
        <div className="panel-empty-state topology-empty-state">
          <p>No agents are available for this session.</p>
        </div>
      )}
    </section>
  );
}
