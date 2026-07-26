import type { AgentRun } from "./telemetry";

// Levels mirror node depth in the forest, with the last one absorbing every
// deeper spawn layer (3 means "3 or deeper").
export const nodeLevels = [0, 1, 2, 3] as const;

export type NodeLevel = (typeof nodeLevels)[number];

export const nodeSubtitleFields = [
  "effort",
  "status",
  "tokens",
  "cost",
  "name",
  "none",
] as const;

export type NodeSubtitleField = (typeof nodeSubtitleFields)[number];

export const nodeSubtitleFieldLabels: Record<NodeSubtitleField, string> = {
  effort: "Effort",
  status: "Status",
  tokens: "Tokens",
  cost: "Cost",
  name: "Agent name",
  none: "Hidden",
};

export interface NodeLevelStyle {
  radius: number;
  titleFontSize: number;
  subtitleFontSize: number;
  subtitle: NodeSubtitleField;
}

export type NodeStyleParams = NodeLevelStyle[];

export interface NodeStyleRange {
  min: number;
  max: number;
  step: number;
}

export const NODE_STYLE_STORAGE_KEY = "monitor-agents:topology-node-style";

export const DEFAULT_NODE_STYLE_PARAMS: NodeStyleParams = [
  { radius: 36, titleFontSize: 8, subtitleFontSize: 5, subtitle: "effort" },
  { radius: 24, titleFontSize: 7, subtitleFontSize: 5.5, subtitle: "effort" },
  { radius: 18, titleFontSize: 6, subtitleFontSize: 5, subtitle: "effort" },
  { radius: 12, titleFontSize: 5, subtitleFontSize: 4.5, subtitle: "effort" },
];

export const NODE_STYLE_RANGES: Record<
  "radius" | "titleFontSize" | "subtitleFontSize",
  NodeStyleRange
> = {
  radius: { min: 8, max: 64, step: 1 },
  titleFontSize: { min: 3, max: 20, step: 0.5 },
  subtitleFontSize: { min: 3, max: 16, step: 0.5 },
};

// Narrow viewports shrink nodes by the ratio the hardcoded mobile radii used
// before sizing became configurable, so defaults still render as they did.
const MOBILE_RADIUS_SCALE = [24 / 36, 20 / 24, 16 / 18, 1];

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function middleEllipsis(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }

  const available = maximumLength - 1;
  const startLength = Math.ceil(available / 2);
  const endLength = Math.floor(available / 2);
  return `${value.slice(0, startLength)}…${value.slice(-endLength)}`;
}

export function isUnknownModel(model: string): boolean {
  const normalizedModel = model.trim();
  return normalizedModel === "" || normalizedModel.toLowerCase() === "unknown";
}

function effortLabel(effort: string): string {
  return middleEllipsis(effort.toLowerCase() === "medium" ? "med" : effort, 8);
}

export function nodeLevelOf(depth: number): NodeLevel {
  return clamp(Math.trunc(depth), 0, nodeLevels.length - 1) as NodeLevel;
}

export function nodeRadius(
  styles: NodeStyleParams,
  depth: number,
  mobile: boolean,
): number {
  const level = nodeLevelOf(depth);
  const { radius } = styles[level];
  return mobile ? Math.round(radius * MOBILE_RADIUS_SCALE[level]) : radius;
}

export function nodeSubtitleText(
  agent: AgentRun,
  field: NodeSubtitleField,
): string {
  switch (field) {
    case "effort":
      // An unknown model means the provider never reported a real config, so
      // whatever effort we carry alongside it is not worth showing.
      return agent.effort !== null && !isUnknownModel(agent.model)
        ? effortLabel(agent.effort)
        : "";
    case "status":
      return agent.status;
    case "tokens":
      return compactNumber.format(
        agent.tokenUsage.input + agent.tokenUsage.output,
      );
    case "cost":
      return agent.costUsd === null ? "" : `$${agent.costUsd.toFixed(2)}`;
    case "name":
      return middleEllipsis(agent.name, 14);
    case "none":
      return "";
  }
}

export interface NodeTextLayout {
  titleY: number;
  subtitleY: number;
}

// Centers the title/subtitle pair on the hexagon origin. Both lines render
// with dominant-baseline "middle", so each y is the line's own center.
export function nodeTextLayout(
  titleFontSize: number,
  subtitleFontSize: number,
  hasSubtitle: boolean,
): NodeTextLayout {
  if (!hasSubtitle) {
    return { titleY: 0, subtitleY: 0 };
  }

  const gap = titleFontSize * 0.25;
  const blockHeight = titleFontSize + gap + subtitleFontSize;
  return {
    titleY: (titleFontSize - blockHeight) / 2,
    subtitleY: (blockHeight - subtitleFontSize) / 2,
  };
}

function sanitizeNumber(
  value: unknown,
  range: NodeStyleRange,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, range.min, range.max)
    : fallback;
}

function sanitizeSubtitleField(
  value: unknown,
  fallback: NodeSubtitleField,
): NodeSubtitleField {
  return nodeSubtitleFields.includes(value as NodeSubtitleField)
    ? (value as NodeSubtitleField)
    : fallback;
}

export function sanitizeNodeStyleParams(value: unknown): NodeStyleParams {
  const levels = Array.isArray(value) ? value : [];

  return DEFAULT_NODE_STYLE_PARAMS.map((fallback, level) => {
    const record =
      typeof levels[level] === "object" && levels[level] !== null
        ? (levels[level] as Record<string, unknown>)
        : {};

    return {
      radius: sanitizeNumber(
        record.radius,
        NODE_STYLE_RANGES.radius,
        fallback.radius,
      ),
      titleFontSize: sanitizeNumber(
        record.titleFontSize,
        NODE_STYLE_RANGES.titleFontSize,
        fallback.titleFontSize,
      ),
      subtitleFontSize: sanitizeNumber(
        record.subtitleFontSize,
        NODE_STYLE_RANGES.subtitleFontSize,
        fallback.subtitleFontSize,
      ),
      subtitle: sanitizeSubtitleField(record.subtitle, fallback.subtitle),
    };
  });
}
