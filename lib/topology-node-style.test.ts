import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRun } from "./telemetry.ts";
import {
  DEFAULT_NODE_STYLE_PARAMS,
  NODE_STYLE_RANGES,
  nodeLevelOf,
  nodeRadius,
  nodeSubtitleText,
  nodeTextLayout,
  sanitizeNodeStyleParams,
} from "./topology-node-style.ts";

function agentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "claude:root",
    parentId: null,
    name: "orchestrator",
    provider: "claude",
    model: "claude-opus-5",
    effort: "medium",
    status: "running",
    task: "build the thing",
    spawnMethod: "root",
    cwd: "/repo",
    startedAt: "2026-07-26T07:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-07-26T07:05:00.000Z",
    tokenUsage: {
      input: 12_000,
      output: 3_400,
      cached: 0,
      contextUsed: 15_400,
      contextLimit: 200_000,
    },
    costUsd: 1.234,
    toolCalls: 9,
    ...overrides,
  };
}

test("nodeLevelOf collapses every deeper spawn layer into the last level", () => {
  assert.equal(nodeLevelOf(0), 0);
  assert.equal(nodeLevelOf(2), 2);
  assert.equal(nodeLevelOf(3), 3);
  assert.equal(nodeLevelOf(9), 3);
  assert.equal(nodeLevelOf(-1), 0);
});

test("nodeRadius keeps the pre-existing desktop and mobile defaults", () => {
  const desktop = [0, 1, 2, 3].map((depth) =>
    nodeRadius(DEFAULT_NODE_STYLE_PARAMS, depth, false),
  );
  const mobile = [0, 1, 2, 3].map((depth) =>
    nodeRadius(DEFAULT_NODE_STYLE_PARAMS, depth, true),
  );

  assert.deepEqual(desktop, [36, 24, 18, 12]);
  assert.deepEqual(mobile, [24, 20, 16, 12]);
});

test("nodeRadius scales a customized radius down on mobile", () => {
  const styles = sanitizeNodeStyleParams([{ radius: 48 }]);

  assert.equal(nodeRadius(styles, 0, false), 48);
  assert.equal(nodeRadius(styles, 0, true), 32);
});

test("nodeSubtitleText renders each selectable field", () => {
  const agent = agentRun();

  assert.equal(nodeSubtitleText(agent, "effort"), "med");
  assert.equal(nodeSubtitleText(agent, "status"), "running");
  assert.equal(nodeSubtitleText(agent, "tokens"), "15.4K");
  assert.equal(nodeSubtitleText(agent, "cost"), "$1.23");
  assert.equal(nodeSubtitleText(agent, "name"), "orchestrator");
  assert.equal(nodeSubtitleText(agent, "none"), "");
});

test("nodeSubtitleText blanks values the telemetry never reported", () => {
  assert.equal(nodeSubtitleText(agentRun({ effort: null }), "effort"), "");
  assert.equal(
    nodeSubtitleText(agentRun({ model: "unknown" }), "effort"),
    "",
  );
  assert.equal(nodeSubtitleText(agentRun({ costUsd: null }), "cost"), "");
});

test("nodeSubtitleText truncates long agent names to fit the hexagon", () => {
  const subtitle = nodeSubtitleText(
    agentRun({ name: "silent-failure-hunter-agent" }),
    "name",
  );

  assert.equal(subtitle.length, 14);
  assert.ok(subtitle.includes("…"));
});

test("nodeTextLayout centers a title/subtitle pair on the node origin", () => {
  const { titleY, subtitleY } = nodeTextLayout(8, 5, true);
  const top = titleY - 8 / 2;
  const bottom = subtitleY + 5 / 2;

  assert.ok(titleY < 0 && subtitleY > 0);
  assert.ok(Math.abs(top + bottom) < 1e-9);
});

test("nodeTextLayout centers the title alone when there is no subtitle", () => {
  assert.deepEqual(nodeTextLayout(8, 5, false), { titleY: 0, subtitleY: 0 });
});

test("sanitizeNodeStyleParams falls back to defaults for unusable input", () => {
  assert.deepEqual(sanitizeNodeStyleParams(null), DEFAULT_NODE_STYLE_PARAMS);
  assert.deepEqual(
    sanitizeNodeStyleParams([{ radius: "big", subtitle: "shoe-size" }]),
    DEFAULT_NODE_STYLE_PARAMS,
  );
});

test("sanitizeNodeStyleParams clamps out-of-range values and keeps valid ones", () => {
  const styles = sanitizeNodeStyleParams([
    { radius: 9999, titleFontSize: 0, subtitleFontSize: 6, subtitle: "tokens" },
  ]);

  assert.equal(styles.length, DEFAULT_NODE_STYLE_PARAMS.length);
  assert.equal(styles[0].radius, NODE_STYLE_RANGES.radius.max);
  assert.equal(styles[0].titleFontSize, NODE_STYLE_RANGES.titleFontSize.min);
  assert.equal(styles[0].subtitleFontSize, 6);
  assert.equal(styles[0].subtitle, "tokens");
  assert.deepEqual(styles[1], DEFAULT_NODE_STYLE_PARAMS[1]);
});
