"use client";

import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  DEFAULT_TOPOLOGY_LAYOUT,
  LAYOUT_RANGES,
  LAYOUT_SLIDER_FIELDS,
  TOPOLOGY_LAYOUT_STORAGE_KEY,
  centerPositions,
  computeLayoutPositions,
  sanitizeTopologyLayout,
  topologyLayoutStyleLabels,
  topologyLayoutStyles,
  type LayoutRange,
  type TopologyLayout,
  type TopologyLayoutStyle,
} from "@/lib/topology-layout";
import {
  DEFAULT_NODE_STYLE_PARAMS,
  NODE_STYLE_RANGES,
  NODE_STYLE_STORAGE_KEY,
  isUnknownModel,
  middleEllipsis,
  nodeLevelOf,
  nodeLevels,
  nodeRadius,
  nodeSubtitleFieldLabels,
  nodeSubtitleFields,
  nodeSubtitleText,
  nodeTextLayout,
  sanitizeNodeStyleParams,
  type NodeLevel,
  type NodeLevelStyle,
  type NodeStyleParams,
  type NodeSubtitleField,
} from "@/lib/topology-node-style";

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
  depth: number;
  // Styling bucket for this node: depth, with every deeper layer sharing the
  // last level's size and label settings.
  level: NodeLevel;
  radius: number;
  color: TopologyNodeColor;
  // Id of the top-level ancestor (forest root) this node belongs to. Nodes
  // sharing a groupRootId are painted together in one z-index band.
  groupRootId: string;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  crossProvider: boolean;
  sourceColor: TopologyNodeColor | "zinc";
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
  qwen: "Qwen",
};

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const ALL_AGENT_GROUPS = "";

interface NodeStyleSliderField {
  key: keyof typeof NODE_STYLE_RANGES;
  label: string;
  ariaLabel: string;
}

const NODE_STYLE_SLIDER_FIELDS: NodeStyleSliderField[] = [
  {
    key: "radius",
    label: "Size",
    ariaLabel: "Node size for the selected depth level",
  },
  {
    key: "titleFontSize",
    label: "Title size",
    ariaLabel: "Node title font size for the selected depth level",
  },
  {
    key: "subtitleFontSize",
    label: "Subtitle size",
    ariaLabel: "Node subtitle font size for the selected depth level",
  },
];

function levelLabel(level: NodeLevel): string {
  return level === nodeLevels.length - 1 ? `L${level}+` : `L${level}`;
}

function levelAriaLabel(level: NodeLevel): string {
  return level === nodeLevels.length - 1
    ? `Depth level ${level} and deeper`
    : `Depth level ${level}`;
}

const CROSS_PROVIDER_LINK_EXTRA = 20;
// Fan and tree lay out every group side by side, so a many-group topology needs
// to zoom out further than the force layout ever did to fit on screen.
const MIN_ZOOM_SCALE = 0.2;
const MAX_ZOOM_SCALE = 2.5;

// The slider fields for a style are described as plain strings so one block of
// JSX renders all three styles; these two read the matching range and value.
function layoutRangeFor(style: TopologyLayoutStyle, key: string): LayoutRange {
  return (LAYOUT_RANGES[style] as Record<string, LayoutRange>)[key];
}

function layoutValueFor(layout: TopologyLayout, key: string): number {
  return (layout[layout.style] as unknown as Record<string, number>)[key];
}

function loadStoredTopologyLayout(): TopologyLayout {
  if (typeof window === "undefined") {
    return DEFAULT_TOPOLOGY_LAYOUT;
  }

  try {
    const stored = window.localStorage.getItem(TOPOLOGY_LAYOUT_STORAGE_KEY);
    return stored
      ? sanitizeTopologyLayout(JSON.parse(stored))
      : DEFAULT_TOPOLOGY_LAYOUT;
  } catch {
    return DEFAULT_TOPOLOGY_LAYOUT;
  }
}

function loadStoredNodeStyleParams(): NodeStyleParams {
  if (typeof window === "undefined") {
    return DEFAULT_NODE_STYLE_PARAMS;
  }

  try {
    const stored = window.localStorage.getItem(NODE_STYLE_STORAGE_KEY);
    return stored
      ? sanitizeNodeStyleParams(JSON.parse(stored))
      : DEFAULT_NODE_STYLE_PARAMS;
  } catch {
    return DEFAULT_NODE_STYLE_PARAMS;
  }
}

function labelStatus(status: AgentRun["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function shortModelName(model: string, provider: Provider): string {
  const normalizedModel = model.trim();
  if (isUnknownModel(normalizedModel)) {
    return providerLabels[provider].toUpperCase();
  }

  const ignoredTokens = new Set([
    "agy",
    "anthropic",
    "claude",
    "codex",
    "gemini",
    "gpt",
    "openai",
  ]);
  const tokens = normalizedModel
    .replace(/-\d{8}$/u, "")
    .toLowerCase()
    .split(/[-/_.]+/u)
    .filter(Boolean);
  const family = tokens.find(
    (token) =>
      !ignoredTokens.has(token) && !/^\d+(?:[a-z])?$/u.test(token),
  );

  return (family ?? tokens[0] ?? normalizedModel).toUpperCase();
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
  // Nodes the user dragged in a deterministic layout. Kept separate from
  // positionCacheRef so a snapshot refresh recomputes every other node while
  // these stay where they were dropped.
  const pinnedPositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const lastLayoutStyleRef = useRef<TopologyLayoutStyle | null>(null);
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
  const [layout, setLayout] = useState<TopologyLayout>(
    loadStoredTopologyLayout,
  );
  const deferredLayout = useDeferredValue(layout);
  const [nodeStyleParams, setNodeStyleParams] = useState<NodeStyleParams>(
    loadStoredNodeStyleParams,
  );
  const deferredNodeStyleParams = useDeferredValue(nodeStyleParams);
  const [editedLevel, setEditedLevel] = useState<NodeLevel>(0);
  const [showLayoutPanel, setShowLayoutPanel] = useState(false);

  actionsRef.current = { onSelectAgent, onToggleCollapsed };
  selectedAgentIdRef.current = selectedAgentId;

  function updateLayoutParam(key: string, value: number) {
    setLayout((current) => ({
      ...current,
      [current.style]: { ...current[current.style], [key]: value },
    }));
  }

  function selectLayoutStyle(style: TopologyLayoutStyle) {
    // Pins belong to the layout they were dropped on, so a style switch starts
    // from a clean deterministic arrangement.
    pinnedPositionsRef.current.clear();
    setLayout((current) => ({ ...current, style }));
  }

  function updateEditedLevel(patch: Partial<NodeLevelStyle>) {
    setNodeStyleParams((current) =>
      current.map((style, level) =>
        level === editedLevel ? { ...style, ...patch } : style,
      ),
    );
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(
        TOPOLOGY_LAYOUT_STORAGE_KEY,
        JSON.stringify(layout),
      );
    } catch {
      // Ignore unavailable storage (private browsing, quota, etc).
    }
  }, [layout]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        NODE_STYLE_STORAGE_KEY,
        JSON.stringify(nodeStyleParams),
      );
    } catch {
      // Ignore unavailable storage (private browsing, quota, etc).
    }
  }, [nodeStyleParams]);

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
      const height =
        width < 560 ? 528 : Math.min(672, Math.max(576, width * 0.672));

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
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

    for (const agent of agents) {
      if (agent.parentId) {
        childCounts.set(agent.parentId, (childCounts.get(agent.parentId) ?? 0) + 1);
      }
    }

    // Walk parentId up to the forest root so every node knows which group's
    // z-index band it belongs to. The `seen` guard keeps a cyclic parent chain
    // (defensive — telemetry should be acyclic) from looping forever.
    function groupRootIdOf(agentId: string): string {
      let current = agentsById.get(agentId);
      const seen = new Set<string>();
      while (
        current?.parentId &&
        agentsById.has(current.parentId) &&
        !seen.has(current.id)
      ) {
        seen.add(current.id);
        current = agentsById.get(current.parentId);
      }
      return current?.id ?? agentId;
    }

    // Fan and tree derive every position from the forest shape up front; force
    // instead seeds nodes and lets the simulation settle them.
    const layoutStyle = deferredLayout.style;
    const pinnedPositions = pinnedPositionsRef.current;
    const plottedPositions =
      layoutStyle === "force"
        ? null
        : centerPositions(
            computeLayoutPositions(
              displayedAgents.map((agent) => ({
                id: agent.id,
                parentId: agent.parentId,
              })),
              layoutStyle,
              deferredLayout,
            ),
            width,
            height,
          );

    const orbitalRadius = Math.min(width, height) * (mobile ? 0.24 : 0.28);
    const nodes: GraphNode[] = displayedAgents.map((agent, index) => {
      const depth = agentDepths.get(agent.id) ?? 0;
      const radius = nodeRadius(deferredNodeStyleParams, depth, mobile);
      const cachedPosition = positionCache.get(agent.id);
      const angle = (index / displayedAgents.length) * Math.PI * 2 - Math.PI / 2;
      const isRoot = depth === 0;
      const plotted = pinnedPositions.get(agent.id) ?? plottedPositions?.get(agent.id);

      return {
        id: agent.id,
        agent,
        childCount: childCounts.get(agent.id) ?? 0,
        color: colorAssignments.get(agent.id)!,
        depth,
        groupRootId: groupRootIdOf(agent.id),
        level: nodeLevelOf(depth),
        radius,
        x:
          plotted?.x ??
          (cachedPosition
            ? cachedPosition.normalizedX * width
            : width / 2 + (isRoot ? 0 : Math.cos(angle) * orbitalRadius)),
        y:
          plotted?.y ??
          (cachedPosition
            ? cachedPosition.normalizedY * height
            : height / 2 + (isRoot ? 0 : Math.sin(angle) * orbitalRadius)),
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
          sourceColor:
            parent.status === "running"
              ? colorAssignments.get(parent.id)!
              : "zinc",
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
      .scaleExtent([MIN_ZOOM_SCALE, MAX_ZOOM_SCALE])
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
      .attr("data-target-status", (item) => item.targetStatus)
      .style(
        "--link-color",
        (item) => `var(--color-${item.sourceColor}-400)`,
      );

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

    // Bucket nodes by their forest root so each group paints in its own
    // z-index band. SVG has no z-index — stacking follows DOM order, so a
    // group that appears later in `orderedGroups` renders on top. The base
    // order follows each group's first appearance in the node array (stable
    // across ticks); the selected agent's group is moved last so its whole
    // subtree stacks above the others.
    const nodesByGroup = new Map<string, GraphNode[]>();
    const groupOrder: string[] = [];
    for (const item of nodes) {
      const bucket = nodesByGroup.get(item.groupRootId);
      if (bucket) {
        bucket.push(item);
      } else {
        nodesByGroup.set(item.groupRootId, [item]);
        groupOrder.push(item.groupRootId);
      }
    }

    const selectedGroupRootId = selectedAgentIdRef.current
      ? nodeById.get(selectedAgentIdRef.current)?.groupRootId
      : undefined;
    const orderedGroupIds =
      selectedGroupRootId && nodesByGroup.has(selectedGroupRootId)
        ? [
            ...groupOrder.filter((rootId) => rootId !== selectedGroupRootId),
            selectedGroupRootId,
          ]
        : groupOrder;
    const orderedGroups = orderedGroupIds.map((rootId, zIndex) => ({
      rootId,
      zIndex,
      nodes: nodesByGroup.get(rootId)!,
    }));

    const nodeLayer = scene.append("g").attr("class", "force-nodes");
    const node = nodeLayer
      .selectAll<SVGGElement, (typeof orderedGroups)[number]>(
        "g.force-node-group",
      )
      .data(orderedGroups, (group) => group.rootId)
      .join("g")
      .attr("class", "force-node-group")
      .attr("data-group-id", (group) => group.rootId)
      .attr("data-group-index", (group) => group.zIndex)
      .selectAll<SVGGElement, GraphNode>("g.force-node")
      .data(
        (group) => group.nodes,
        (item) => item.id,
      )
      .join("g")
      .attr("class", "force-node")
      .attr("data-depth", (item) => Math.min(item.depth, 3))
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
      .attr("points", (item) => hexagonPoints(item.radius + 16));

    node
      .append("polygon")
      .attr("class", "force-node__outer-pulse-ring")
      .attr("points", (item) => hexagonPoints(item.radius + 12));

    node
      .append("polygon")
      .attr("class", "force-node__pulse-ring")
      .attr("points", (item) => hexagonPoints(item.radius + 8));

    node
      .append("polygon")
      .attr("class", "force-node__status-ring")
      .attr("points", (item) => hexagonPoints(item.radius + 4));

    node
      .append("polygon")
      .attr("class", "force-node__hexagon")
      .attr("points", (item) => hexagonPoints(item.radius));

    node
      .append("polygon")
      .attr("class", "force-node__inner-ring")
      .attr("points", (item) => hexagonPoints(item.radius - 4));

    function subtitleOf(item: GraphNode): string {
      return nodeSubtitleText(
        item.agent,
        deferredNodeStyleParams[item.level].subtitle,
      );
    }

    function textLayoutOf(item: GraphNode) {
      const { titleFontSize, subtitleFontSize } =
        deferredNodeStyleParams[item.level];
      return nodeTextLayout(
        titleFontSize,
        subtitleFontSize,
        subtitleOf(item) !== "",
      );
    }

    node
      .append("text")
      .attr("class", "force-node__model")
      .attr("dominant-baseline", "middle")
      .attr("y", (item) => textLayoutOf(item).titleY)
      .style(
        "font-size",
        (item) => `${deferredNodeStyleParams[item.level].titleFontSize}px`,
      )
      .text((item) =>
        shortModelName(item.agent.model, item.agent.provider),
      );

    node
      .append("text")
      .attr("class", "force-node__effort")
      .attr("dominant-baseline", "middle")
      .attr("y", (item) => textLayoutOf(item).subtitleY)
      .style(
        "font-size",
        (item) => `${deferredNodeStyleParams[item.level].subtitleFontSize}px`,
      )
      .text(subtitleOf);

    node
      .append("text")
      .attr("class", "force-node__repo")
      .attr("y", (item) => item.radius + 12)
      .text((item) =>
        // Every subagent under a root shares the root's cwd, so the repo
        // name is redundant there; its own name is what distinguishes it.
        item.depth === 0
          ? workspaceLabel(item.agent.cwd)
          : middleEllipsis(item.agent.name, 20),
      );

    node
      .append("title")
      .text(
        (item) =>
          `${item.agent.name}\n${item.agent.task}\n${labelStatus(item.agent.status)} · ${item.agent.model}\nEffort: ${item.agent.effort ?? "not reported"}\nWorktree/repo: ${item.agent.cwd}`,
      );

    const forceParams = deferredLayout.force;
    const simulation =
      layoutStyle === "force"
        ? forceSimulation<GraphNode>(nodes)
            .force(
              "link",
              forceLink<GraphNode, GraphLink>(links)
                .id((item) => item.id)
                .distance((item) =>
                  item.crossProvider
                    ? forceParams.linkDistance + CROSS_PROVIDER_LINK_EXTRA
                    : forceParams.linkDistance,
                )
                .strength(0.7),
            )
            .force(
              "charge",
              forceManyBody().strength(-forceParams.chargeStrength),
            )
            .force(
              "collide",
              forceCollide<GraphNode>()
                .radius((item) => item.radius + forceParams.collisionPadding)
                .strength(0.95)
                .iterations(2),
            )
            .force("center", forceCenter(width / 2, height / 2))
            .force("x", forceX<GraphNode>(width / 2).strength(0.035))
            .force("y", forceY<GraphNode>(height / 2).strength(0.045))
            .stop()
        : null;

    function resolvedNode(value: string | GraphNode): GraphNode {
      return typeof value === "string" ? nodeById.get(value)! : value;
    }

    function renderPositions() {
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

    // Only the simulation needs corralling; a computed layout is allowed to
    // exceed the viewport and relies on Fit/zoom instead.
    function ticked() {
      const horizontalPadding = mobile ? 60 : 64;
      const verticalPadding = mobile ? 48 : 62;

      for (const item of nodes) {
        item.x = clamp(item.x ?? width / 2, horizontalPadding, width - horizontalPadding);
        item.y = clamp(item.y ?? height / 2, verticalPadding, height - verticalPadding);
      }

      renderPositions();
    }

    if (simulation) {
      for (let index = 0; index < 140; index += 1) {
        simulation.tick();
      }
      ticked();
    } else {
      renderPositions();
    }

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
        MIN_ZOOM_SCALE,
        MAX_ZOOM_SCALE,
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
      if (!simulation) {
        return;
      }

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
      if (!simulation) {
        // A computed layout can extend past the viewport, so dropped nodes are
        // placed freely rather than clamped into it.
        item.x = event.x;
        item.y = event.y;
        renderPositions();
        return;
      }

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
      if (!simulation) {
        pinnedPositions.set(item.id, { x: item.x ?? 0, y: item.y ?? 0 });
        return;
      }

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

    simulation?.alpha(0.22).on("tick", ticked).restart();

    // Switching style rearranges everything, so refit the view to the new shape
    // rather than leaving the user panned over empty space.
    if (
      lastLayoutStyleRef.current !== null &&
      lastLayoutStyleRef.current !== layoutStyle
    ) {
      fitTopology();
    }
    lastLayoutStyleRef.current = layoutStyle;

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
      simulation?.stop();
      node.on(".drag", null);
      svg.on(".zoom", null);
      svg.selectAll("*").remove();
    };
  }, [
  agents,
  collapsedAgentIds,
  dimensions,
  displayedAgents,
  deferredLayout,
  deferredNodeStyleParams,
]);

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
    const selected = nodes.filter((item) => item.id === selectedAgentId);
    // Lift the selected node's whole group band above the others, then lift
    // the node within that band, so both the group and the node end up on top.
    selected.each(function () {
      const groupBand = (this as SVGGElement).parentNode as SVGGElement | null;
      if (groupBand) {
        select(groupBand).raise();
      }
    });
    selected.raise();
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
            All groups ({agentGroups.length})
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
              aria-expanded={showLayoutPanel}
              aria-label={
                showLayoutPanel
                  ? "Hide layout settings"
                  : "Show layout settings"
              }
              className="force-graph__control"
              onClick={() => setShowLayoutPanel((current) => !current)}
              title="Layout settings"
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
                <path d="M2 5h7m3 0h2M2 11h2m3 0h7" />
                <circle cx="11" cy="5" r="1.75" />
                <circle cx="5" cy="11" r="1.75" />
              </svg>
            </button>
            {showLayoutPanel ? (
              <div
                aria-label="Layout parameters"
                className="topology-layout-panel"
                role="group"
              >
                <div className="topology-layout-panel__header">
                  <span className="topology-layout-panel__title">Layout</span>
                  <button
                    aria-label="Reset layout to defaults"
                    className="topology-layout-panel__reset"
                    onClick={() => {
                      pinnedPositionsRef.current.clear();
                      setLayout(DEFAULT_TOPOLOGY_LAYOUT);
                      setNodeStyleParams(DEFAULT_NODE_STYLE_PARAMS);
                    }}
                    type="button"
                  >
                    Reset
                  </button>
                </div>
                <label className="topology-layout-panel__row">
                  <span className="topology-layout-panel__label">
                    <span>Style</span>
                  </span>
                  <select
                    aria-label="Topology layout style"
                    className="topology-layout-panel__select"
                    onChange={(event) =>
                      selectLayoutStyle(
                        event.target.value as TopologyLayoutStyle,
                      )
                    }
                    value={layout.style}
                  >
                    {topologyLayoutStyles.map((style) => (
                      <option key={style} value={style}>
                        {topologyLayoutStyleLabels[style]}
                      </option>
                    ))}
                  </select>
                </label>
                {LAYOUT_SLIDER_FIELDS[layout.style].map(
                  ({ key, label, ariaLabel, suffix }) => {
                    const range = layoutRangeFor(layout.style, key);
                    const value = layoutValueFor(layout, key);

                    return (
                      <label className="topology-layout-panel__row" key={key}>
                        <span className="topology-layout-panel__label">
                          <span>{label}</span>
                          <span className="topology-layout-panel__value">
                            {value}
                            {suffix ?? ""}
                          </span>
                        </span>
                        <input
                          aria-label={ariaLabel}
                          max={range.max}
                          min={range.min}
                          onChange={(event) =>
                            updateLayoutParam(key, Number(event.target.value))
                          }
                          step={range.step}
                          type="range"
                          value={value}
                        />
                      </label>
                    );
                  },
                )}
                <div className="topology-layout-panel__section">
                  <span className="topology-layout-panel__section-title">
                    Nodes
                  </span>
                  <div
                    aria-label="Node depth level to style"
                    className="topology-layout-panel__levels"
                    role="group"
                  >
                    {nodeLevels.map((level) => (
                      <button
                        aria-label={levelAriaLabel(level)}
                        aria-pressed={editedLevel === level}
                        className="topology-layout-panel__level"
                        key={level}
                        onClick={() => setEditedLevel(level)}
                        type="button"
                      >
                        {levelLabel(level)}
                      </button>
                    ))}
                  </div>
                </div>
                {NODE_STYLE_SLIDER_FIELDS.map(({ key, label, ariaLabel }) => (
                  <label className="topology-layout-panel__row" key={key}>
                    <span className="topology-layout-panel__label">
                      <span>{label}</span>
                      <span className="topology-layout-panel__value">
                        {nodeStyleParams[editedLevel][key]}
                      </span>
                    </span>
                    <input
                      aria-label={ariaLabel}
                      max={NODE_STYLE_RANGES[key].max}
                      min={NODE_STYLE_RANGES[key].min}
                      onChange={(event) =>
                        updateEditedLevel({ [key]: Number(event.target.value) })
                      }
                      step={NODE_STYLE_RANGES[key].step}
                      type="range"
                      value={nodeStyleParams[editedLevel][key]}
                    />
                  </label>
                ))}
                <label className="topology-layout-panel__row">
                  <span className="topology-layout-panel__label">
                    <span>Subtitle</span>
                  </span>
                  <select
                    aria-label="Value shown on the node subtitle line for the selected depth level"
                    className="topology-layout-panel__select"
                    onChange={(event) =>
                      updateEditedLevel({
                        subtitle: event.target.value as NodeSubtitleField,
                      })
                    }
                    value={nodeStyleParams[editedLevel].subtitle}
                  >
                    {nodeSubtitleFields.map((field) => (
                      <option key={field} value={field}>
                        {nodeSubtitleFieldLabels[field]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
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
