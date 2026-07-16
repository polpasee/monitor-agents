import assert from "node:assert/strict";
import test from "node:test";

import {
  assignTopologyNodeColors,
  topologyNodeColors,
} from "./topology-colors.ts";

test("assignTopologyNodeColors uses every palette color before repeating", () => {
  const ids = topologyNodeColors.map((_, index) => `agent-${index}`);
  const assignments = assignTopologyNodeColors(new Map(), ids);

  assert.deepEqual([...assignments.values()], topologyNodeColors);
  assert.equal(new Set(assignments.values()).size, topologyNodeColors.length);
});

test("assignTopologyNodeColors keeps visible assignments and reuses freed colors", () => {
  const assignments = assignTopologyNodeColors(
    new Map(),
    ["first", "second", "third"],
  );
  const secondColor = assignments.get("second");

  assignTopologyNodeColors(assignments, ["second", "third", "new"]);

  assert.equal(assignments.get("second"), secondColor);
  assert.equal(assignments.get("new"), topologyNodeColors[0]);
  assert.equal(new Set(assignments.values()).size, 3);
});
