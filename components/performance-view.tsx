"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { line, scaleLinear, scalePoint } from "d3";

import { maxReviewScore, type KanbanTask } from "@/lib/kanban";
import { buildPerformanceSeries } from "@/lib/performance";

const seriesColors = [
  "var(--lime)",
  "var(--cyan)",
  "var(--violet)",
  "var(--amber)",
  "var(--green)",
  "var(--red)",
];

const height = 240;
const margin = { top: 12, right: 16, bottom: 28, left: 32 };
const yTicks = [0, 2, 4, 6, 8, 10];
/** Room for one "Oct 15" day label. */
const dayLabelWidth = 56;

const dayLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function formatDay(day: string): string {
  return dayLabel.format(new Date(`${day}T00:00:00Z`));
}

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
  const days = useMemo(
    () => [...new Set(series.flatMap((entry) => entry.points.map((point) => point.day)))].sort(),
    [series],
  );

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

  const x = scalePoint<string>()
    .domain(days)
    .range([margin.left, Math.max(margin.left, width - margin.right)])
    .padding(0.5);
  const y = scaleLinear()
    .domain([0, maxReviewScore])
    .range([height - margin.bottom, margin.top]);
  const path = line<{ day: string; average: number }>()
    .x((point) => x(point.day) ?? 0)
    .y((point) => y(point.average));
  const maxDayLabels = Math.max(
    1,
    Math.floor((width - margin.left - margin.right) / dayLabelWidth),
  );
  const labelStride = Math.ceil(days.length / maxDayLabels);

  return (
    <section className="performance-panel" aria-labelledby="performance-title">
      <header className="panel-header">
        <div>
          <p className="panel-header__eyebrow">Performance</p>
          <h2 id="performance-title" className="panel-header__title">
            Coding score by Model:Effort
          </h2>
        </div>
      </header>

      {error && <p className="kanban-error" role="alert">{error}</p>}

      {!hasSeries ? (
        <div className="panel-empty-state">
          <p>{loading ? "Loading tasks…" : "No scored tasks yet."}</p>
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
                aria-label="Average review score per day for each Model:Effort"
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
                {days.map((day, index) =>
                  index % labelStride === 0 ? (
                    <text
                      className="performance-chart__tick"
                      key={day}
                      textAnchor="middle"
                      x={x(day)}
                      y={height - 8}
                    >
                      {formatDay(day)}
                    </text>
                  ) : null,
                )}
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
                        <circle
                          className="performance-chart__dot"
                          cx={x(point.day)}
                          cy={y(point.average)}
                          fill={color}
                          key={point.day}
                          r={4}
                        >
                          <title>
                            {`${entry.label} · ${point.day} · avg ${point.average.toFixed(1)} · ${point.count} ${point.count === 1 ? "task" : "tasks"}`}
                          </title>
                        </circle>
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
