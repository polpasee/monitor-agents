"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { line, scaleLinear, scaleLog } from "d3";

import { maxReviewScore, type KanbanTask } from "@/lib/kanban";
import { buildPerformanceSeries, type PerformancePoint } from "@/lib/performance";

const seriesColors = [
  "var(--lime)",
  "var(--cyan)",
  "var(--violet)",
  "var(--amber)",
  "var(--green)",
  "var(--red)",
];

const height = 240;
const margin = { top: 24, right: 16, bottom: 28, left: 32 };
const yTicks = [0, 2, 4, 6, 8, 10];
/** USD per task; those inside the plotted range are drawn. */
const costTicks = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];

export function PerformanceView() {
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timeoutId: number | undefined;

    async function refresh() {
      try {
        const response = await fetch("/api/tasks", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Task request failed with ${response.status}`);
        }
        const nextTasks = (await response.json()) as KanbanTask[];
        if (!stopped) {
          setTasks(nextTasks);
          setError(null);
        }
      } catch {
        if (!stopped) {
          setError("Unable to load shared tasks.");
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

  const series = useMemo(() => buildPerformanceSeries(tasks), [tasks]);
  const hasSeries = series.length > 0;
  const costs = series.flatMap((entry) => entry.points.map((point) => point.cost));

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

  // Log, so a cheap model's efforts do not bunch up against an expensive one's.
  // Padded 2x each way so the range always spans one of the costTicks.
  const x = scaleLog()
    .domain([Math.min(...costs) / 2, Math.max(...costs) * 2])
    .range([margin.left, Math.max(margin.left, width - margin.right)]);
  const [minCost, maxCost] = x.domain();
  const y = scaleLinear()
    .domain([0, maxReviewScore])
    .range([height - margin.bottom, margin.top]);
  const path = line<PerformancePoint>()
    .x((point) => x(point.cost))
    .y((point) => y(point.score));

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
          <ul className="performance-chart__legend">
            {series.map((entry, index) => (
              <li key={entry.label}>
                <span
                  className="performance-chart__swatch"
                  style={{ background: seriesColors[index % seriesColors.length] }}
                />
                {entry.label}
              </li>
            ))}
          </ul>
          <div className="performance-chart__frame" ref={chartRef}>
            {width > 0 && (
              <svg
                className="performance-chart__svg"
                role="img"
                aria-label="Average review score against average API cost per task for each Model:Effort"
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                width={width}
              >
                {yTicks.map((tick) => (
                  <g key={tick}>
                    <line
                      className="performance-chart__grid"
                      x1={margin.left}
                      x2={width - margin.right}
                      y1={y(tick)}
                      y2={y(tick)}
                    />
                    <text
                      className="performance-chart__tick"
                      dominantBaseline="middle"
                      textAnchor="end"
                      x={margin.left - 8}
                      y={y(tick)}
                    >
                      {tick}
                    </text>
                  </g>
                ))}
                {costTicks
                  .filter((tick) => tick >= minCost && tick <= maxCost)
                  .map((tick) => (
                    <text
                      className="performance-chart__tick"
                      key={tick}
                      textAnchor="middle"
                      x={x(tick)}
                      y={height - 8}
                    >
                      ${tick}
                    </text>
                  ))}
                {series.map((entry, index) => {
                  const color = seriesColors[index % seriesColors.length];
                  return (
                    <g key={entry.label}>
                      <path
                        className="performance-chart__line"
                        d={path(entry.points) ?? undefined}
                        stroke={color}
                      />
                      {entry.points.map((point) => (
                        <g key={point.label}>
                          <circle
                            className="performance-chart__dot"
                            cx={x(point.cost)}
                            cy={y(point.score)}
                            fill={color}
                            r={4}
                          >
                            <title>
                              {`${point.label} · avg $${point.cost.toFixed(2)} per task · avg score ${point.score.toFixed(1)} · ${point.count} ${point.count === 1 ? "task" : "tasks"}`}
                            </title>
                          </circle>
                          <text
                            className="performance-chart__tick"
                            textAnchor="middle"
                            x={x(point.cost)}
                            y={y(point.score) - 8}
                          >
                            {point.label.split(":")[1] ?? ""}
                          </text>
                        </g>
                      ))}
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
