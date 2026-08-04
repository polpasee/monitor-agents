export const topologyLayoutStyles = ["force", "fan", "tree"] as const;

export type TopologyLayoutStyle = (typeof topologyLayoutStyles)[number];

export const topologyLayoutStyleLabels: Record<TopologyLayoutStyle, string> = {
  force: "Force",
  fan: "Fan",
  tree: "Tree",
};

export interface ForceLayoutParams {
  linkDistance: number;
  chargeStrength: number;
  collisionPadding: number;
}

export interface FanLayoutParams {
  levelDistance: number;
  arcSpread: number;
  groupSpacing: number;
}

export interface TreeLayoutParams {
  levelGap: number;
  siblingGap: number;
}

export interface TopologyLayout {
  style: TopologyLayoutStyle;
  force: ForceLayoutParams;
  fan: FanLayoutParams;
  tree: TreeLayoutParams;
}

export interface LayoutRange {
  min: number;
  max: number;
  step: number;
}

export const TOPOLOGY_LAYOUT_STORAGE_KEY = "monitor-agents:topology-layout";

export const DEFAULT_TOPOLOGY_LAYOUT: TopologyLayout = {
  style: "force",
  force: { linkDistance: 92, chargeStrength: 260, collisionPadding: 22 },
  fan: { levelDistance: 110, arcSpread: 200, groupSpacing: 60 },
  tree: { levelGap: 110, siblingGap: 64 },
};

export const LAYOUT_RANGES: {
  force: Record<keyof ForceLayoutParams, LayoutRange>;
  fan: Record<keyof FanLayoutParams, LayoutRange>;
  tree: Record<keyof TreeLayoutParams, LayoutRange>;
} = {
  force: {
    linkDistance: { min: 40, max: 200, step: 4 },
    chargeStrength: { min: 80, max: 500, step: 10 },
    collisionPadding: { min: 8, max: 40, step: 2 },
  },
  fan: {
    levelDistance: { min: 40, max: 220, step: 4 },
    arcSpread: { min: 60, max: 360, step: 10 },
    groupSpacing: { min: 20, max: 200, step: 5 },
  },
  tree: {
    levelGap: { min: 50, max: 220, step: 5 },
    siblingGap: { min: 20, max: 140, step: 4 },
  },
};

export interface LayoutSliderField {
  key: string;
  label: string;
  ariaLabel: string;
  suffix?: string;
}

export const LAYOUT_SLIDER_FIELDS: Record<
  TopologyLayoutStyle,
  readonly LayoutSliderField[]
> = {
  force: [
    {
      key: "linkDistance",
      label: "Distance",
      ariaLabel: "Distance between a main agent and its sub-agents",
    },
    {
      key: "chargeStrength",
      label: "Repulsion",
      ariaLabel: "Repulsion strength between agent nodes",
    },
    {
      key: "collisionPadding",
      label: "Spacing",
      ariaLabel: "Minimum spacing between agent nodes",
    },
  ],
  fan: [
    {
      key: "levelDistance",
      label: "Distance",
      ariaLabel: "Radial distance between each spawn level of the fan",
    },
    {
      key: "arcSpread",
      label: "Arc spread",
      ariaLabel: "Angle in degrees the fan spreads its sub-agents across",
      suffix: "°",
    },
    {
      key: "groupSpacing",
      label: "Spacing",
      ariaLabel: "Spacing between separate agent group fans",
    },
  ],
  tree: [
    {
      key: "levelGap",
      label: "Level gap",
      ariaLabel: "Vertical gap between each spawn level of the tree",
    },
    {
      key: "siblingGap",
      label: "Sibling gap",
      ariaLabel: "Horizontal gap between sibling agent nodes",
    },
  ],
};

export interface LayoutNodeInput {
  id: string;
  parentId: string | null;
}

export interface Point {
  x: number;
  y: number;
}

interface LayoutTreeNode {
  id: string;
  children: LayoutTreeNode[];
}

interface PlacedNode {
  id: string;
  depth: number;
  // Fractional leaf index: leaves take whole slots, parents sit midway
  // between their first and last child.
  slot: number;
  rootIndex: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

// Rebuilds the visible parent/child structure. A node whose parent is not in
// the input becomes a root, matching how the graph drops links to hidden
// parents. Nodes left unreachable by a cyclic parent chain are appended as
// their own roots so nothing silently disappears.
function buildLayoutForest(
  nodes: readonly LayoutNodeInput[],
): LayoutTreeNode[] {
  const byId = new Map<string, LayoutTreeNode>(
    nodes.map((node) => [node.id, { id: node.id, children: [] }]),
  );
  const roots: LayoutTreeNode[] = [];
  const attached = new Set<string>();

  for (const node of nodes) {
    const treeNode = byId.get(node.id)!;
    const parent =
      node.parentId !== null && node.parentId !== node.id
        ? byId.get(node.parentId)
        : undefined;

    if (parent) {
      parent.children.push(treeNode);
      attached.add(node.id);
    } else {
      roots.push(treeNode);
    }
  }

  const reachable = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current.id)) {
      continue;
    }
    reachable.add(current.id);
    stack.push(...current.children);
  }

  for (const node of nodes) {
    if (!reachable.has(node.id) && attached.has(node.id)) {
      roots.push(byId.get(node.id)!);
      reachable.add(node.id);
    }
  }

  return roots;
}

// Assigns every node a depth and a leaf slot. Roots are separated by one empty
// slot so neighbouring groups never share a column.
function placeForest(roots: readonly LayoutTreeNode[]): {
  placed: PlacedNode[];
  rootSlots: { start: number; count: number }[];
} {
  const placed: PlacedNode[] = [];
  const rootSlots: { start: number; count: number }[] = [];
  const visited = new Set<string>();
  let cursor = 0;

  function visit(node: LayoutTreeNode, depth: number, rootIndex: number): number {
    if (visited.has(node.id)) {
      return cursor;
    }
    visited.add(node.id);

    const childSlots = node.children.map((child) =>
      visit(child, depth + 1, rootIndex),
    );
    let slot: number;
    if (childSlots.length === 0) {
      slot = cursor;
      cursor += 1;
    } else {
      slot = (childSlots[0] + childSlots[childSlots.length - 1]) / 2;
    }

    placed.push({ id: node.id, depth, slot, rootIndex });
    return slot;
  }

  roots.forEach((root, rootIndex) => {
    const start = cursor;
    visit(root, 0, rootIndex);
    rootSlots.push({ start, count: Math.max(1, cursor - start) });
    cursor += 1;
  });

  return { placed, rootSlots };
}

export function computeTreePositions(
  nodes: readonly LayoutNodeInput[],
  params: TreeLayoutParams,
): Map<string, Point> {
  const { placed } = placeForest(buildLayoutForest(nodes));
  return new Map(
    placed.map((item) => [
      item.id,
      { x: item.slot * params.siblingGap, y: item.depth * params.levelGap },
    ]),
  );
}

export function computeFanPositions(
  nodes: readonly LayoutNodeInput[],
  params: FanLayoutParams,
): Map<string, Point> {
  const { placed, rootSlots } = placeForest(buildLayoutForest(nodes));
  const arcRadians = (params.arcSpread * Math.PI) / 180;

  // Each group is laid out around its own origin first, then groups are packed
  // left to right using their real horizontal extents.
  const local = new Map<string, Point>();
  const extents = new Map<number, { min: number; max: number }>();

  for (const item of placed) {
    const slots = rootSlots[item.rootIndex];
    // Offsetting by half a slot keeps the first and last branch from landing
    // on the same angle when the arc is a full circle.
    const fraction = (item.slot - slots.start + 0.5) / slots.count - 0.5;
    const angle = fraction * arcRadians;
    const radius = item.depth * params.levelDistance;
    const point = {
      x: radius * Math.sin(angle),
      y: radius * Math.cos(angle),
    };

    local.set(item.id, point);
    const extent = extents.get(item.rootIndex);
    if (extent) {
      extent.min = Math.min(extent.min, point.x);
      extent.max = Math.max(extent.max, point.x);
    } else {
      extents.set(item.rootIndex, { min: point.x, max: point.x });
    }
  }

  const offsets = new Map<number, number>();
  let cursor = 0;
  rootSlots.forEach((_, rootIndex) => {
    const extent = extents.get(rootIndex) ?? { min: 0, max: 0 };
    offsets.set(rootIndex, cursor - extent.min);
    cursor += extent.max - extent.min + params.groupSpacing;
  });

  return new Map(
    placed.map((item) => {
      const point = local.get(item.id)!;
      return [
        item.id,
        { x: point.x + offsets.get(item.rootIndex)!, y: point.y },
      ];
    }),
  );
}

export function computeLayoutPositions(
  nodes: readonly LayoutNodeInput[],
  style: TopologyLayoutStyle,
  layout: TopologyLayout,
): Map<string, Point> {
  return style === "tree"
    ? computeTreePositions(nodes, layout.tree)
    : computeFanPositions(nodes, layout.fan);
}

// Shifts a computed layout so its bounding box is centered in the viewport.
// Deterministic layouts are built around an arbitrary origin, and callers rely
// on Fit/zoom for anything larger than the viewport.
export function centerPositions(
  positions: Map<string, Point>,
  width: number,
  height: number,
): Map<string, Point> {
  if (positions.size === 0) {
    return positions;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { x, y } of positions.values()) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const offsetX = width / 2 - (minX + maxX) / 2;
  const offsetY = height / 2 - (minY + maxY) / 2;
  for (const [id, point] of positions) {
    positions.set(id, { x: point.x + offsetX, y: point.y + offsetY });
  }

  return positions;
}

function sanitizeNumber(
  value: unknown,
  range: LayoutRange,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, range.min, range.max)
    : fallback;
}

function sanitizeGroup<T extends object>(
  value: unknown,
  ranges: { [K in keyof T]: LayoutRange },
  fallback: T,
): T {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};

  const result = {} as T;
  for (const key of Object.keys(fallback) as (keyof T)[]) {
    result[key] = sanitizeNumber(
      record[key as string],
      ranges[key],
      fallback[key] as number,
    ) as T[keyof T];
  }

  return result;
}

export function sanitizeTopologyLayout(value: unknown): TopologyLayout {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};

  // Layouts stored before styles existed were a flat bag of force params.
  const force = sanitizeGroup(
    record.force ?? record,
    LAYOUT_RANGES.force,
    DEFAULT_TOPOLOGY_LAYOUT.force,
  );

  return {
    style: topologyLayoutStyles.includes(record.style as TopologyLayoutStyle)
      ? (record.style as TopologyLayoutStyle)
      : DEFAULT_TOPOLOGY_LAYOUT.style,
    force,
    fan: sanitizeGroup(record.fan, LAYOUT_RANGES.fan, DEFAULT_TOPOLOGY_LAYOUT.fan),
    tree: sanitizeGroup(
      record.tree,
      LAYOUT_RANGES.tree,
      DEFAULT_TOPOLOGY_LAYOUT.tree,
    ),
  };
}
