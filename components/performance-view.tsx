"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { line, scaleLinear, scaleLog } from "d3";

import { maxReviewScore } from "@/lib/kanban";
import {
  buildPerformanceSeries,
  type PerformancePoint,
  type PerformanceSnapshot,
} from "@/lib/performance";

const seriesColors = [
  "var(--lime)",
  "var(--cyan)",
  "var(--violet)",
  "var(--amber)",
  "var(--green)",
  "var(--red)",
];

const height = 340;
/** The top margin holds the legend; the bottom and left ones the axis titles. */
const margin = { top: 44, right: 32, bottom: 52, left: 60 };
/** USD per task; those inside the plotted range are labelled. */
const costTicks = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
/** Room for a label's two lines between the point and the plot's top. */
const labelHeight = 30;
/**
 * Drawn with attributes rather than stylesheet classes, so a browser holding an
 * old stylesheet still shows the axes and labels.
 */
const ink = { axis: "var(--border-strong)", grid: "var(--border)", text: "var(--muted)" };

/** A point's label goes on the side away from its neighbours, so it does not sit on its own line. */
function labelBelow(points: PerformancePoint[], index: number, pointY: number): boolean {
  const neighbours = [points[index - 1], points[index + 1]].filter(Boolean);
  const below =
    neighbours.length > 0 &&
    points[index].score <
      neighbours.reduce((total, point) => total + point.score, 0) / neighbours.length;
  return below || pointY - labelHeight < margin.top;
}

export function PerformanceView() {
  const [snapshots, setSnapshots] = useState<PerformanceSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timeoutId: number | undefined;

    async function refresh() {
      try {
        const response = await fetch("/api/performance", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Performance request failed with ${response.status}`);
        }
        const nextSnapshots = (await response.json()) as PerformanceSnapshot[];
        if (!stopped) {
          setSnapshots(nextSnapshots);
          setError(null);
        }
      } catch {
        if (!stopped) {
          setError("Unable to load performance.");
        }
      } finally {
        if (!stopped) {
          setLoading(false);
          timeoutId = window.setTimeout(refresh, 5_000);
        }
      }
    }

    void refresh();
    return () => {
      stopped = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, []);

  const series = useMemo(() => buildPerformanceSeries(snapshots), [snapshots]);
  const hasSeries = series.length > 0;
  const points = series.flatMap((entry) => entry.points);
  const costs = points.map((point) => point.cost);

  // The svg is drawn at the chart's real width, so its text and dots stay true px.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(chart);
    return () => observer.disconnect();
  }, [hasSeries]);

  const plotLeft = margin.left;
  const plotRight = Math.max(plotLeft, width - margin.right);
  const plotBottom = height - margin.bottom;
  // Log, so a cheap model's efforts do not bunch up against an expensive one's.
  // Padded 2x each way so the range always spans one of the costTicks.
  const x = scaleLog()
    .domain([Math.min(...costs) / 2, Math.max(...costs) * 2])
    .range([plotLeft, plotRight]);
  const [minCost, maxCost] = x.domain();
  // Starts a point below the lowest score, so close scores do not all sit on one line.
  const minScore = Math.max(0, Math.floor(Math.min(...points.map((point) => point.score))) - 1);
  const y = scaleLinear()
    .domain([minScore, maxReviewScore])
    .range([plotBottom, margin.top]);
  const scoreStep = maxReviewScore - minScore <= 5 ? 1 : 2;
  const scoreTicks = Array.from(
    { length: Math.floor((maxReviewScore - minScore) / scoreStep) + 1 },
    (_, index) => minScore + index * scoreStep,
  );
  const path = line<PerformancePoint>()
    .x((point) => x(point.cost))
    .y((point) => y(point.score));

  // Legend items laid out left to right, centred over the plot.
  const legendWidths = series.map((entry) => 34 + entry.label.length * 7);
  const legendStart =
    (plotLeft + plotRight - legendWidths.reduce((total, itemWidth) => total + itemWidth + 16, -16)) / 2;
  const legendItems = series.map((entry, index) => ({
    label: entry.label,
    x: legendStart + legendWidths.slice(0, index).reduce((total, itemWidth) => total + itemWidth + 16, 0),
  }));

  return (
    <section className="performance-panel" aria-labelledby="performance-title">
      <header className="panel-header">
        <div>
          <p className="panel-header__eyebrow">Performance</p>
          <h2 id="performance-title" className="panel-header__title">
            Coding score by cost per task
          </h2>
        </div>
      </header>

      {error && <p className="kanban-error" role="alert">{error}</p>}

      {!hasSeries ? (
        <div className="panel-empty-state">
          <p>{loading ? "Loading tasks…" : "No scored tasks with a known API price yet."}</p>
        </div>
      ) : (
        <div className="performance-chart">
          <div className="performance-chart__frame" ref={chartRef}>
            {width > 0 && (
              <svg
                className="performance-chart__svg"
                role="img"
                aria-label="Average review score against average API cost per task for each Model:Effort"
                fontSize={11}
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                width={width}
              >
                {legendItems.map((item, index) => {
                  const color = seriesColors[index % seriesColors.length];
                  return (
                    <g key={item.label} transform={`translate(${item.x}, 16)`}>
                      <line stroke={color} strokeWidth={2} x1={0} x2={22} y1={0} y2={0} />
                      <circle cx={11} cy={0} fill={color} r={4} />
                      <text dominantBaseline="middle" fill="var(--text-soft)" fontSize={12} x={30} y={0}>
                        {item.label}
                      </text>
                    </g>
                  );
                })}

                {scoreTicks.map((tick) => (
                  <g key={tick}>
                    <line stroke={ink.grid} strokeOpacity={0.6} x1={plotLeft} x2={plotRight} y1={y(tick)} y2={y(tick)} />
                    <text dominantBaseline="middle" fill={ink.text} textAnchor="end" x={plotLeft - 8} y={y(tick)}>
                      {tick}
                    </text>
                  </g>
                ))}
                {x.ticks().map((tick) => {
                  const major = costTicks.includes(tick);
                  return (
                    <line
                      key={tick}
                      stroke={ink.axis}
                      x1={x(tick)}
                      x2={x(tick)}
                      y1={plotBottom}
                      y2={plotBottom + (major ? 6 : 3)}
                    />
                  );
                })}
                {costTicks
                  .filter((tick) => tick >= minCost && tick <= maxCost)
                  .map((tick) => (
                    <text fill={ink.text} key={tick} textAnchor="middle" x={x(tick)} y={plotBottom + 20}>
                      ${tick}
                    </text>
                  ))}
                <line stroke={ink.axis} x1={plotLeft} x2={plotLeft} y1={margin.top} y2={plotBottom} />
                <line stroke={ink.axis} x1={plotLeft} x2={plotRight} y1={plotBottom} y2={plotBottom} />
                <text fill={ink.text} fontSize={12} textAnchor="middle" x={(plotLeft + plotRight) / 2} y={height - 10}>
                  Average cost per task (USD, log scale)
                </text>
                <text
                  fill={ink.text}
                  fontSize={12}
                  textAnchor="middle"
                  transform={`translate(16, ${(margin.top + plotBottom) / 2}) rotate(-90)`}
                >
                  Review score (0–10)
                </text>

                {series.map((entry, index) => {
                  const color = seriesColors[index % seriesColors.length];
                  return (
                    <g key={entry.label}>
                      <path
                        d={path(entry.points) ?? undefined}
                        fill="none"
                        stroke={color}
                        strokeLinejoin="round"
                        strokeWidth={2}
                      />
                      {entry.points.map((point, pointIndex) => {
                        const pointX = x(point.cost);
                        const pointY = y(point.score);
                        const below = labelBelow(entry.points, pointIndex, pointY);
                        const scoreY = below ? pointY + 18 : pointY - 22;
                        return (
                          <g key={point.label}>
                            <circle cx={pointX} cy={pointY} fill={color} r={5} stroke="var(--surface-1)" strokeWidth={2}>
                              <title>
                                {`${point.label} · avg $${point.cost.toFixed(2)} per task · avg score ${point.score.toFixed(1)} · ${point.count} ${point.count === 1 ? "task" : "tasks"}`}
                              </title>
                            </circle>
                            {/* A halo of the panel colour keeps another series' line from cutting through the text. */}
                            <text
                              fill={color}
                              fontSize={12}
                              paintOrder="stroke"
                              stroke="var(--surface-1)"
                              strokeLinejoin="round"
                              strokeWidth={4}
                              textAnchor="middle"
                              x={pointX}
                              y={scoreY}
                            >
                              <tspan x={pointX}>{point.score.toFixed(1)}</tspan>
                              <tspan dy={13} x={pointX}>
                                {point.label.split(":")[1] ?? ""}
                              </tspan>
                            </text>
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
