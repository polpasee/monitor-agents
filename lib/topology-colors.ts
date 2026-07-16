export const topologyNodeColors = [
  "red",
  "amber",
  "lime",
  "emerald",
  "cyan",
  "blue",
  "violet",
  "fuchsia",
  "rose",
] as const;

export type TopologyNodeColor = (typeof topologyNodeColors)[number];

export function assignTopologyNodeColors(
  assignments: Map<string, TopologyNodeColor>,
  nodeIds: readonly string[],
): Map<string, TopologyNodeColor> {
  const visibleIds = new Set(nodeIds);
  for (const id of assignments.keys()) {
    if (!visibleIds.has(id)) {
      assignments.delete(id);
    }
  }

  const usage = new Map<TopologyNodeColor, number>(
    topologyNodeColors.map((color) => [color, 0]),
  );
  for (const color of assignments.values()) {
    usage.set(color, (usage.get(color) ?? 0) + 1);
  }

  for (const id of nodeIds) {
    if (assignments.has(id)) {
      continue;
    }

    const color = topologyNodeColors.reduce((best, candidate) =>
      usage.get(candidate)! < usage.get(best)! ? candidate : best,
    );
    assignments.set(id, color);
    usage.set(color, usage.get(color)! + 1);
  }

  return assignments;
}
