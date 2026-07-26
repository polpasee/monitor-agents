import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TOPOLOGY_LAYOUT,
  LAYOUT_RANGES,
  centerPositions,
  computeFanPositions,
  computeTreePositions,
  sanitizeTopologyLayout,
  topologyLayoutStyles,
  type LayoutNodeInput,
} from "./topology-layout.ts";

function nodesOf(...pairs: [string, string | null][]): LayoutNodeInput[] {
  return pairs.map(([id, parentId]) => ({ id, parentId }));
}

const treeParams = { levelGap: 100, siblingGap: 50 };
const fanParams = { levelDistance: 100, arcSpread: 180, groupSpacing: 40 };

test("computeTreePositions layers by depth and centers parents over children", () => {
  const positions = computeTreePositions(
    nodesOf(["root", null], ["a", "root"], ["b", "root"]),
    treeParams,
  );

  assert.equal(positions.get("root")!.y, 0);
  assert.equal(positions.get("a")!.y, 100);
  assert.equal(positions.get("b")!.y, 100);
  assert.equal(positions.get("b")!.x - positions.get("a")!.x, 50);
  assert.equal(
    positions.get("root")!.x,
    (positions.get("a")!.x + positions.get("b")!.x) / 2,
  );
});

test("computeTreePositions keeps separate groups in separate columns", () => {
  const positions = computeTreePositions(
    nodesOf(["r1", null], ["a", "r1"], ["r2", null], ["b", "r2"]),
    treeParams,
  );
  const xs = ["r1", "a", "r2", "b"].map((id) => positions.get(id)!.x);

  assert.equal(xs[0], xs[1]);
  assert.equal(xs[2], xs[3]);
  assert.ok(xs[2] > xs[1], "second group sits right of the first");
});

test("computeTreePositions scales gaps with the params", () => {
  const wide = computeTreePositions(
    nodesOf(["root", null], ["a", "root"], ["b", "root"]),
    { levelGap: 200, siblingGap: 120 },
  );

  assert.equal(wide.get("a")!.y, 200);
  assert.equal(wide.get("b")!.x - wide.get("a")!.x, 120);
});

test("computeFanPositions puts each level on its own radius from the root", () => {
  const positions = computeFanPositions(
    nodesOf(["root", null], ["a", "root"], ["b", "root"], ["c", "a"]),
    fanParams,
  );
  const root = positions.get("root")!;
  const radiusOf = (id: string) =>
    Math.hypot(positions.get(id)!.x - root.x, positions.get(id)!.y - root.y);

  assert.ok(Math.abs(radiusOf("a") - 100) < 1e-9);
  assert.ok(Math.abs(radiusOf("b") - 100) < 1e-9);
  assert.ok(Math.abs(radiusOf("c") - 200) < 1e-9);
});

test("computeFanPositions spreads siblings symmetrically across the arc", () => {
  const positions = computeFanPositions(
    nodesOf(["root", null], ["a", "root"], ["b", "root"]),
    fanParams,
  );
  const root = positions.get("root")!;
  const a = positions.get("a")!;
  const b = positions.get("b")!;

  // A 180° arc over two leaves puts them at ±45° either side of straight down.
  assert.ok(Math.abs(a.x - root.x + (b.x - root.x)) < 1e-9);
  assert.ok(Math.abs(a.y - root.y - (b.y - root.y)) < 1e-9);
  assert.ok(a.x < root.x && b.x > root.x);
  assert.ok(a.y > root.y, "children fan downward from the root");
});

test("computeFanPositions widens with the arc spread", () => {
  const narrow = computeFanPositions(
    nodesOf(["root", null], ["a", "root"], ["b", "root"]),
    { ...fanParams, arcSpread: 60 },
  );
  const wide = computeFanPositions(
    nodesOf(["root", null], ["a", "root"], ["b", "root"]),
    { ...fanParams, arcSpread: 300 },
  );
  const spanOf = (positions: Map<string, { x: number; y: number }>) =>
    Math.abs(positions.get("b")!.x - positions.get("a")!.x);

  assert.ok(spanOf(wide) > spanOf(narrow));
});

test("computeFanPositions does not collapse the first and last branch at 360°", () => {
  const positions = computeFanPositions(
    nodesOf(["root", null], ["a", "root"], ["b", "root"], ["c", "root"]),
    { ...fanParams, arcSpread: 360 },
  );
  const a = positions.get("a")!;
  const c = positions.get("c")!;

  assert.ok(Math.hypot(a.x - c.x, a.y - c.y) > 1);
});

test("computeFanPositions separates group fans without overlap", () => {
  const positions = computeFanPositions(
    nodesOf(["r1", null], ["a", "r1"], ["b", "r1"], ["r2", null], ["c", "r2"]),
    fanParams,
  );
  const group1MaxX = Math.max(
    ...["r1", "a", "b"].map((id) => positions.get(id)!.x),
  );
  const group2MinX = Math.min(...["r2", "c"].map((id) => positions.get(id)!.x));

  assert.ok(group2MinX - group1MaxX >= fanParams.groupSpacing - 1e-9);
});

test("computeFanPositions keeps a lone root at the layout origin", () => {
  const positions = computeFanPositions(nodesOf(["solo", null]), fanParams);

  assert.deepEqual(positions.get("solo"), { x: 0, y: 0 });
});

test("layout builders treat an orphaned node as its own root", () => {
  const positions = computeTreePositions(
    nodesOf(["root", null], ["orphan", "missing-parent"]),
    treeParams,
  );

  assert.equal(positions.size, 2);
  assert.equal(positions.get("orphan")!.y, 0);
});

test("layout builders terminate on a parent cycle and keep every node", () => {
  const positions = computeTreePositions(nodesOf(["a", "b"], ["b", "a"]), treeParams);

  assert.equal(positions.size, 2);
});

test("centerPositions centers the bounding box in the viewport", () => {
  const positions = centerPositions(
    new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 100, y: 50 }],
    ]),
    600,
    400,
  );

  assert.deepEqual(positions.get("a"), { x: 250, y: 175 });
  assert.deepEqual(positions.get("b"), { x: 350, y: 225 });
});

test("centerPositions handles an empty layout", () => {
  assert.equal(centerPositions(new Map(), 600, 400).size, 0);
});

test("sanitizeTopologyLayout falls back to defaults for unusable input", () => {
  assert.deepEqual(sanitizeTopologyLayout(null), DEFAULT_TOPOLOGY_LAYOUT);
  assert.deepEqual(
    sanitizeTopologyLayout({ style: "spiral", fan: "wide" }),
    DEFAULT_TOPOLOGY_LAYOUT,
  );
});

test("sanitizeTopologyLayout migrates a pre-style flat force layout", () => {
  const layout = sanitizeTopologyLayout({
    linkDistance: 112,
    chargeStrength: 150,
    collisionPadding: 20,
  });

  assert.equal(layout.style, "force");
  assert.deepEqual(layout.force, {
    linkDistance: 112,
    chargeStrength: 150,
    collisionPadding: 20,
  });
  assert.deepEqual(layout.fan, DEFAULT_TOPOLOGY_LAYOUT.fan);
});

test("sanitizeTopologyLayout clamps each style group to its own ranges", () => {
  const layout = sanitizeTopologyLayout({
    style: "fan",
    fan: { levelDistance: 9999, arcSpread: 0, groupSpacing: 55 },
    tree: { levelGap: -5, siblingGap: 40 },
  });

  assert.equal(layout.style, "fan");
  assert.equal(layout.fan.levelDistance, LAYOUT_RANGES.fan.levelDistance.max);
  assert.equal(layout.fan.arcSpread, LAYOUT_RANGES.fan.arcSpread.min);
  assert.equal(layout.fan.groupSpacing, 55);
  assert.equal(layout.tree.levelGap, LAYOUT_RANGES.tree.levelGap.min);
  assert.equal(layout.tree.siblingGap, 40);
});

test("every layout style has slider fields and a label", async () => {
  const { LAYOUT_SLIDER_FIELDS, topologyLayoutStyleLabels } = await import(
    "./topology-layout.ts"
  );

  for (const style of topologyLayoutStyles) {
    assert.ok(topologyLayoutStyleLabels[style], `${style} has a label`);
    assert.ok(
      LAYOUT_SLIDER_FIELDS[style].length > 0,
      `${style} has slider fields`,
    );
  }
});
