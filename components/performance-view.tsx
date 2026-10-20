"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { line, scaleLinear, scaleLog } from "d3";

import { shortDateTimeFormatter } from "@/lib/format-time";
import { formatStepModel, maxReviewScore } from "@/lib/kanban";
import {
  buildPerformanceSeries,
  codingCost,
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
  "var(--color-fuchsia-400)",
  "var(--color-blue-400)",
];

/** The plot's own height; the legend rows above it add to the svg's. */
const plotHeight = 240;
/** The bottom and left margins hold the axis titles. */
const margin = { right: 32, bottom: 52, left: 60 };
const legendRowHeight = 20;
/** USD per task; those inside the plotted range are labelled when there is room. */
const costTicks = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
const costLabelSpacing = 44;
/** A point label's two lines ("9.3" over "high(12)"), as a box centred on the point's x. */
const label = { width: 60, height: 28, gap: 8 };
/**
 * Drawn with attributes rather than stylesheet classes, so a browser holding an
 * old stylesheet still shows the axes and labels.
 */
const ink = { axis: "var(--border-strong)", grid: "var(--border)", text: "var(--muted)" };

interface LabelBox {
  x: number;
  top: number;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return Math.abs(a.x - b.x) < label.width && Math.abs(a.top - b.top) < label.height;
}

/** Whether a label box covers a dot, with the dot's 5px radius as margin. */
function coversDot(box: LabelBox, dotX: number, dotY: number): boolean {
  return (
    Math.abs(box.x - dotX) < label.width / 2 + 5 &&
    dotY > box.top - 5 &&
    dotY < box.top + label.height + 5
  );
}

const pageSizes = [5, 10, 20, 50];
const defaultPageSize = 5;
const completedAt = shortDateTimeFormatter({ timeZone: "UTC" });

const yesNo = (value: boolean | null | undefined) =>
  value == null ? "—" : value ? "Yes" : "No";

/** One row per scored PR, newest first, with every parameter its snapshot kept. */
function ScoreTable({ snapshots }: { snapshots: PerformanceSnapshot[] }) {
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [page, setPage] = useState(0);
  const sorted = [...snapshots].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  // Snapshots can disappear on refresh, so a page past the end falls back to the last.
  const current = Math.min(page, pageCount - 1);
  const rows = sorted.slice(current * pageSize, (current + 1) * pageSize);
  return (
    <section className="performance-panel" aria-labelledby="performance-table-title">
      <header className="panel-header">
        <div>
          <p className="panel-header__eyebrow">Performance</p>
          <h2 id="performance-table-title" className="panel-header__title">
            PR score by parameter
          </h2>
        </div>
      </header>
      <div className="api-table-wrap">
      <table className="api-table" aria-label="PR score by parameter">
        <thead>
          <tr>
            <th>PR</th>
            <th>Completed (UTC)</th>
            <th>Task</th>
            <th>Model:Effort</th>
            <th>Score</th>
            <th>Cost</th>
            <th>Attempts</th>
            <th>Type</th>
            <th>Files</th>
            <th>+ / −</th>
            <th>Tests</th>
            <th>Migration</th>
            <th>New dep</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cost = codingCost(row);
            return (
              <tr key={row.taskId}>
                <td>{row.pullRequestNumber != null ? `#${row.pullRequestNumber}` : "—"}</td>
                <td>{completedAt.format(new Date(row.recordedAt))}</td>
                <td>{row.title ?? row.taskId}</td>
                <td>{formatStepModel(row.model, row.effort) ?? "—"}</td>
                <td>{row.reviewScore.toFixed(1)}</td>
                <td>{cost === null ? "—" : `$${cost.toFixed(2)}`}</td>
                <td>{row.attemptCount ?? "—"}</td>
                <td>{row.workType ?? "—"}</td>
                <td>{row.filesChanged ?? "—"}</td>
                <td>
                  {row.additions == null && row.deletions == null
                    ? "—"
                    : `+${row.additions ?? 0} / −${row.deletions ?? 0}`}
                </td>
                <td>{row.testFilesChanged ?? "—"}</td>
                <td>{yesNo(row.hasMigration)}</td>
                <td>{yesNo(row.hasNewDependency)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      <footer className="performance-pagination">
        <label>
          Rows per page{" "}
          <select
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(0);
            }}
            value={pageSize}
          >
            {pageSizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <span>
          {current * pageSize + 1}–{current * pageSize + rows.length} of {sorted.length}
        </span>
        <button disabled={current === 0} onClick={() => setPage(current - 1)} type="button">
          Previous
        </button>
        <button disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)} type="button">
          Next
        </button>
      </footer>
    </section>
  );
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

  // Legend items flow left to right, wrap at the plot's width, and each row is centred.
  const legendRows: { label: string; color: string; x: number }[][] = [];
  series.forEach((entry, index) => {
    const itemWidth = 34 + entry.label.length * 7;
    const row = legendRows.at(-1);
    const rowEnd = row?.length ? row.at(-1)!.x + 34 + row.at(-1)!.label.length * 7 + 16 : 0;
    const item = { label: entry.label, color: seriesColors[index % seriesColors.length], x: rowEnd };
    if (!row || (rowEnd > 0 && rowEnd + itemWidth > plotRight - plotLeft)) {
      legendRows.push([{ ...item, x: 0 }]);
    } else {
      row.push(item);
    }
  });
  const legendItems = legendRows.flatMap((row, rowIndex) => {
    const last = row.at(-1)!;
    const offset = (plotLeft + plotRight - (last.x + 34 + last.label.length * 7)) / 2;
    return row.map((item) => ({ ...item, x: item.x + offset, y: 16 + rowIndex * legendRowHeight }));
  });

  const plotTop = 16 + legendRows.length * legendRowHeight;
  const plotBottom = plotTop + plotHeight;
  const height = plotBottom + margin.bottom;
  // Log, so a cheap model's efforts do not bunch up against an expensive one's.
  // Padded 2x each way so the range always spans one of the costTicks.
  const x = scaleLog()
    .domain([Math.min(...costs) / 2, Math.max(...costs) * 2])
    .range([plotLeft, plotRight]);
  const [minCost, maxCost] = x.domain();
  // Labels at least costLabelSpacing apart, so a narrow chart does not run them together.
  const costLabels = costTicks
    .filter((tick) => tick >= minCost && tick <= maxCost)
    .reduce<number[]>((kept, tick) => {
      const previous = kept.at(-1);
      return previous === undefined || x(tick) - x(previous) >= costLabelSpacing ? [...kept, tick] : kept;
    }, []);
  // Starts a point below the lowest score, so close scores do not all sit on one line.
  const minScore = Math.max(0, Math.floor(Math.min(...points.map((point) => point.score))) - 1);
  const y = scaleLinear()
    .domain([minScore, maxReviewScore])
    .range([plotBottom, plotTop]);
  // Counted down from the top so the plot's top is always a labelled tick.
  const scoreStep = maxReviewScore - minScore <= 5 ? 1 : 2;
  const scoreTicks = Array.from(
    { length: Math.floor((maxReviewScore - minScore) / scoreStep) + 1 },
    (_, index) => maxReviewScore - index * scoreStep,
  );
  const path = line<PerformancePoint>()
    .x((point) => x(point.cost))
    .y((point) => y(point.score));

  // Each label goes on the side away from its own neighbours unless that side
  // leaves the plot or covers a label already placed, from any series. A label
  // with no free place is left out; its dot's tooltip still has the numbers.
  const placed: LabelBox[] = [];
  const labelTops = new Map<string, number>();
  const dots = points.map((point) => ({ x: x(point.cost), y: y(point.score) }));
  for (const entry of series) {
    entry.points.forEach((point, index) => {
      const pointX = x(point.cost);
      const pointY = y(point.score);
      const above = { x: pointX, top: pointY - label.gap - label.height };
      const below = { x: pointX, top: pointY + label.gap };
      const neighbours = [entry.points[index - 1], entry.points[index + 1]].filter(Boolean);
      const prefersBelow =
        neighbours.length > 0 &&
        point.score < neighbours.reduce((total, other) => total + other.score, 0) / neighbours.length;
      // Then one label height further out on each side, before giving up.
      const near = prefersBelow ? [below, above] : [above, below];
      const sides = [
        ...near,
        ...near.map((box) => ({ x: box.x, top: box.top + (box === above ? -1 : 1) * label.height })),
      ].filter((box) => box.top >= plotTop && box.top + label.height <= plotBottom);
      const box = sides.find(
        (side) =>
          !placed.some((other) => overlaps(side, other)) &&
          !dots.some((dot) => coversDot(side, dot.x, dot.y)),
      );
      if (!box) return;
      placed.push(box);
      labelTops.set(point.label, box.top);
    });
  }

  return (
    <>
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
          {/* Sized here, not in the stylesheet, so a cached older sheet cannot clip the axis. */}
          <div
            className="performance-chart__frame"
            ref={chartRef}
            style={width > 0 ? { height } : undefined}
          >
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
                {legendItems.map((item) => (
                  <g key={item.label} transform={`translate(${item.x}, ${item.y})`}>
                    <line stroke={item.color} strokeWidth={2} x1={0} x2={22} y1={0} y2={0} />
                    <circle cx={11} cy={0} fill={item.color} r={4} />
                    <text dominantBaseline="middle" fill="var(--text-soft)" fontSize={12} x={30} y={0}>
                      {item.label}
                    </text>
                  </g>
                ))}

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
                {costLabels.map((tick) => (
                  <text fill={ink.text} key={tick} textAnchor="middle" x={x(tick)} y={plotBottom + 20}>
                    ${tick}
                  </text>
                ))}
                <line stroke={ink.axis} x1={plotLeft} x2={plotLeft} y1={plotTop} y2={plotBottom} />
                <line stroke={ink.axis} x1={plotLeft} x2={plotRight} y1={plotBottom} y2={plotBottom} />
                <text fill={ink.text} fontSize={12} textAnchor="middle" x={(plotLeft + plotRight) / 2} y={height - 10}>
                  Average cost per task (USD, log scale)
                </text>
                <text
                  fill={ink.text}
                  fontSize={12}
                  textAnchor="middle"
                  transform={`translate(16, ${(plotTop + plotBottom) / 2}) rotate(-90)`}
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
                      {entry.points.map((point) => {
                        const pointX = x(point.cost);
                        const pointY = y(point.score);
                        const labelTop = labelTops.get(point.label);
                        return (
                          <g key={point.label}>
                            <circle cx={pointX} cy={pointY} fill={color} r={5} stroke="var(--surface-1)" strokeWidth={2}>
                              <title>
                                {`${point.label} · avg $${point.cost.toFixed(2)} per task · avg score ${point.score.toFixed(1)} · ${point.count} ${point.count === 1 ? "task" : "tasks"}`}
                              </title>
                            </circle>
                            {/* A halo of the panel colour keeps another series' line from cutting through the text. */}
                            {labelTop !== undefined && (
                              <text
                                fill={color}
                                fontSize={12}
                                paintOrder="stroke"
                                stroke="var(--surface-1)"
                                strokeLinejoin="round"
                                strokeWidth={4}
                                textAnchor="middle"
                                x={pointX}
                                y={labelTop + 11}
                              >
                                <tspan x={pointX}>{point.score.toFixed(1)}</tspan>
                                <tspan dy={13} x={pointX}>
                                  {`${point.label.split(":")[1] ?? ""}(${point.count})`}
                                </tspan>
                              </text>
                            )}
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
    {snapshots.length > 0 && <ScoreTable snapshots={snapshots} />}
    </>
  );
}
