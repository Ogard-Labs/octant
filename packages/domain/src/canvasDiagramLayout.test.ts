import { decodeCanvasBlock, type CanvasDiagramBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import {
  canvasDiagramNodeContent,
  layoutCanvasDiagram,
  type CanvasDiagramNodeBox,
} from "./canvasDiagramLayout";
import { designBriefExample } from "./canvasLayoutExamples";

function diagram(overrides: Partial<CanvasDiagramBlock> = {}): CanvasDiagramBlock {
  return {
    blockId: "diagram" as never,
    schemaVersion: 1 as never,
    kind: "diagram",
    nodes: [
      { nodeId: "client" as never, label: "Client" },
      { nodeId: "server" as never, label: "Server" },
      { nodeId: "store" as never, label: "Store" },
    ],
    edges: [
      { edgeId: "a" as never, source: "client" as never, target: "server" as never },
      { edgeId: "b" as never, source: "server" as never, target: "store" as never },
    ],
    ...overrides,
  } as CanvasDiagramBlock;
}

describe("layoutCanvasDiagram", () => {
  it("draws a node after everything that reaches it", () => {
    const layout = layoutCanvasDiagram(diagram());

    const [client, server, store] = layout.nodes;
    expect(client?.y).toBeLessThan(server?.y ?? 0);
    expect(server?.y).toBeLessThan(store?.y ?? 0);
  });

  it("reads across the page when the author says the diagram flows that way", () => {
    const layout = layoutCanvasDiagram(diagram({ flow: "right" }));

    const [client, server] = layout.nodes;
    expect(client?.x).toBeLessThan(server?.x ?? 0);
    expect(client?.y).toBe(server?.y);
  });

  it("places the nodes of one step beside each other rather than on top", () => {
    const layout = layoutCanvasDiagram(
      diagram({
        nodes: [
          { nodeId: "gateway" as never, label: "Gateway" },
          { nodeId: "left" as never, label: "Left worker" },
          { nodeId: "right" as never, label: "Right worker" },
        ],
        edges: [
          { edgeId: "a" as never, source: "gateway" as never, target: "left" as never },
          { edgeId: "b" as never, source: "gateway" as never, target: "right" as never },
        ],
      }),
    );

    const [, left, right] = layout.nodes;
    expect(left?.y).toBe(right?.y);
    expect(left?.x).not.toBe(right?.x);
  });

  it("keeps a position the author placed by hand", () => {
    const layout = layoutCanvasDiagram(
      diagram({
        nodes: [
          { nodeId: "client" as never, label: "Client", x: 400, y: 500 },
          { nodeId: "server" as never, label: "Server" },
          { nodeId: "store" as never, label: "Store" },
        ],
      }),
    );

    expect(layout.nodes[0]).toMatchObject({ x: 400, y: 500 });
  });

  it("draws a group as a frame around the nodes it holds, with room for its name", () => {
    const layout = layoutCanvasDiagram(
      diagram({
        groups: [
          { groupId: "backend" as never, label: "Backend", nodeIds: ["server", "store"] as never },
        ],
      }),
    );

    const [group] = layout.groups;
    const server = layout.nodes[1];
    const store = layout.nodes[2];
    expect(group?.label).toBe("Backend");
    expect(group?.x).toBeLessThan(server?.x ?? 0);
    expect(group?.y).toBeLessThan(server?.y ?? 0);
    expect((group?.y ?? 0) + (group?.height ?? 0)).toBeGreaterThan(
      (store?.y ?? 0) + (store?.height ?? 0),
    );
  });

  it("settles a diagram whose edges run in a circle instead of ranking forever", () => {
    const layout = layoutCanvasDiagram(
      diagram({
        edges: [
          { edgeId: "a" as never, source: "client" as never, target: "server" as never },
          { edgeId: "b" as never, source: "server" as never, target: "store" as never },
          { edgeId: "c" as never, source: "store" as never, target: "client" as never },
        ],
      }),
    );

    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(3);
  });

  it("stops an edge at the border of each node so the line meets the box", () => {
    const layout = layoutCanvasDiagram(diagram());

    const [edge] = layout.edges;
    const client = layout.nodes[0];
    expect(edge?.y1).toBe((client?.y ?? 0) + (client?.height ?? 0));
    expect(edge?.y2).toBeGreaterThan(edge?.y1 ?? 0);
  });

  it("reports a canvas large enough to hold everything it placed", () => {
    const layout = layoutCanvasDiagram(
      diagram({
        groups: [
          { groupId: "backend" as never, label: "Backend", nodeIds: ["server", "store"] as never },
        ],
      }),
    );

    for (const node of layout.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
    for (const group of layout.groups) {
      expect(group.x + group.width).toBeLessThanOrEqual(layout.width);
      expect(group.y + group.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("lays a diagram out the same way every time it is read", () => {
    const block = diagram();

    expect(layoutCanvasDiagram(block)).toEqual(layoutCanvasDiagram(block));
  });

  it("ignores authored node positions when the diagram declares auto layout", () => {
    const block = diagram({
      layout: "auto" as const,
      nodes: [
        { nodeId: "client" as never, label: "Client", x: 400, y: 500 },
        { nodeId: "server" as never, label: "Server" },
        { nodeId: "store" as never, label: "Store" },
      ],
    });

    const layout = layoutCanvasDiagram(block);
    const client = layout.nodes.find((node) => node.nodeId === "client");
    expect(client).toBeDefined();
    expect(client).toMatchObject({ x: 24, y: 24 });
  });

  it("keeps authored node positions when the diagram declares manual layout", () => {
    const block = diagram({
      layout: "manual" as const,
      nodes: [
        { nodeId: "client" as never, label: "Client", x: 400, y: 500 },
        { nodeId: "server" as never, label: "Server" },
        { nodeId: "store" as never, label: "Store" },
      ],
    });

    const layout = layoutCanvasDiagram(block);
    const client = layout.nodes.find((node) => node.nodeId === "client");
    expect(client?.x).toBe(400);
    expect(client?.y).toBe(500);
  });
});

describe("styled diagram layout", () => {
  const blocks = designBriefExample.map((block) => decodeCanvasBlock(block));
  const loop = blocks.find((block) => block.blockId === "loop");
  const zones = blocks.find((block) => block.blockId === "zones");
  if (loop?.kind !== "diagram" || zones?.kind !== "diagram") throw new Error("fixture");

  it("draws each closed role as its shape and an unknown legacy role as the plain box", () => {
    const layout = layoutCanvasDiagram(loop);
    expect(layout.nodes.map((node) => [node.nodeId, node.shape])).toEqual([
      ["start", "terminator"],
      ["explore", "process"],
      ["fight", "decision"],
      ["loot", "process"],
      ["upgrade", "process"],
      ["end", "terminator"],
    ]);
    const legacy = layoutCanvasDiagram(
      diagram({ nodes: [{ nodeId: "a" as never, label: "A", role: "service" as never }] }),
    );
    expect(legacy.nodes[0]?.shape).toBe("plain");
  });

  it("draws an older block's free-text role as the plain box even when it names a shape", () => {
    const older = layoutCanvasDiagram(
      diagram({
        nodes: [
          { nodeId: "a" as never, label: "A", role: "decision" as never },
          { nodeId: "b" as never, label: "B", role: "terminator" as never },
        ],
      }),
    );
    expect(older.nodes.map((node) => [node.role, node.shape])).toEqual([
      ["decision", "plain"],
      ["terminator", "plain"],
    ]);
  });

  it("carries each edge's style and tone, defaulting an unstyled edge to a plain line", () => {
    const layout = layoutCanvasDiagram(loop);
    expect(layout.edges.map((edge) => [edge.edgeId, edge.style, edge.tone])).toEqual([
      ["e1", "arrow", undefined],
      ["e2", "arrow", undefined],
      ["e3", "arrow", "success"],
      ["e4", "dashed", "warning"],
      ["e5", "arrow", undefined],
      ["e6", "arrow", undefined],
    ]);
    expect(layoutCanvasDiagram(diagram()).edges[0]?.style).toBe("line");
  });

  it("steps an edge out beside the column rather than under the boxes it skips", () => {
    const layout = layoutCanvasDiagram(loop);
    const flee = layout.edges.find((edge) => edge.edgeId === "e4");
    const rightmost = Math.max(...layout.nodes.map((node) => node.x + node.width));
    expect(flee?.points).toHaveLength(4);
    expect(flee?.points[1]?.x).toBeGreaterThan(rightmost);
    expect(layout.width).toBeGreaterThan(flee?.points[1]?.x ?? 0);
    // A neighbouring step stays one straight segment.
    expect(layout.edges.find((edge) => edge.edgeId === "e1")?.points).toHaveLength(2);
  });

  it("meets a decision diamond on its slanted side", () => {
    const layout = layoutCanvasDiagram(loop);
    const fight = layout.nodes.find((node) => node.nodeId === "fight");
    const into = layout.edges.find((edge) => edge.edgeId === "e2");
    if (fight === undefined || into === undefined) throw new Error("fixture");
    // Straight down into the diamond's top vertex.
    expect(into.x2).toBeCloseTo(fight.x + fight.width / 2);
    expect(into.y2).toBeCloseTo(fight.y);
  });

  it("snapshots the zone map's toned regions in one deterministic layout", () => {
    const layout = layoutCanvasDiagram(zones);
    expect(
      layout.groups.map((group) => ({
        groupId: group.groupId,
        tone: group.tone,
        x: group.x,
        y: group.y,
        width: group.width,
        height: group.height,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "groupId": "safe",
          "height": 100,
          "tone": "success",
          "width": 192,
          "x": 44,
          "y": 24,
        },
        {
          "groupId": "wilds",
          "height": 100,
          "tone": "warning",
          "width": 448,
          "x": 300,
          "y": 148,
        },
        {
          "groupId": "deep",
          "height": 100,
          "tone": "danger",
          "width": 448,
          "x": 556,
          "y": 272,
        },
      ]
    `);
    expect(layoutCanvasDiagram(zones)).toEqual(layout);
    // Regions never overlap, and no frame starts above the picture.
    for (const [index, a] of layout.groups.entries()) {
      expect(a.y).toBeGreaterThanOrEqual(0);
      for (const b of layout.groups.slice(index + 1)) {
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart).toBe(true);
      }
    }
  });
});

type Point = { readonly x: number; readonly y: number };

/** Whether two segments properly cross: an independent oracle for the layout's own count. */
function cross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

function edgeCrossings(block: CanvasDiagramBlock): number {
  const layout = layoutCanvasDiagram(block);
  const centre = new Map(
    layout.nodes.map((node) => [
      node.nodeId,
      { x: node.x + node.width / 2, y: node.y + node.height / 2 },
    ]),
  );
  const segments = block.edges.map((edge) => ({
    source: String(edge.source),
    target: String(edge.target),
    from: centre.get(String(edge.source)) ?? { x: 0, y: 0 },
    to: centre.get(String(edge.target)) ?? { x: 0, y: 0 },
  }));
  let crossings = 0;
  for (const [index, a] of segments.entries()) {
    for (const b of segments.slice(index + 1)) {
      if ([a.source, a.target].some((end) => end === b.source || end === b.target)) continue;
      if (cross(a.from, a.to, b.from, b.to)) crossings += 1;
    }
  }
  return crossings;
}

function inside(
  inner: { x: number; y: number; width: number; height: number },
  outer: typeof inner,
) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

describe("layoutCanvasDiagram crossings", () => {
  // Declared top to bottom in the same order, every edge runs against the
  // grain: the first source meets the last target.
  const reversed = diagram({
    nodes: ["t1", "t2", "t3", "b1", "b2", "b3"].map((id) => ({ nodeId: id as never, label: id })),
    edges: [
      { edgeId: "e1" as never, source: "t1" as never, target: "b3" as never },
      { edgeId: "e2" as never, source: "t2" as never, target: "b2" as never },
      { edgeId: "e3" as never, source: "t3" as never, target: "b1" as never },
    ],
  });

  it("reorders a rank so edges that crossed no longer do", () => {
    expect(edgeCrossings(reversed)).toBe(0);
    const layout = layoutCanvasDiagram(reversed);
    const x = (id: string) => layout.nodes.find((node) => node.nodeId === id)?.x ?? Number.NaN;
    expect(x("b3")).toBeLessThan(x("b1"));
  });

  it("keeps the order the author wrote when nothing crosses", () => {
    const layout = layoutCanvasDiagram(
      diagram({
        nodes: ["a", "b", "c", "d"].map((id) => ({ nodeId: id as never, label: id })),
        edges: [
          { edgeId: "e1" as never, source: "a" as never, target: "c" as never },
          { edgeId: "e2" as never, source: "b" as never, target: "d" as never },
        ],
      }),
    );

    const x = (id: string) => layout.nodes.find((node) => node.nodeId === id)?.x ?? Number.NaN;
    expect(x("c")).toBeLessThan(x("d"));
    expect(x("a")).toBeLessThan(x("b"));
  });

  it("lays out the largest diagram the contract allows the same way every time", () => {
    const nodes = Array.from({ length: 512 }, (_, index) => ({
      nodeId: `n${String(index)}` as never,
      label: `n${String(index)}`,
    }));
    const edges = Array.from({ length: 1024 }, (_, index) => ({
      edgeId: `e${String(index)}` as never,
      source: `n${String((index * 7) % 256)}` as never,
      target: `n${String(256 + ((index * 13) % 256))}` as never,
    }));
    const block = diagram({ nodes, edges });

    expect(layoutCanvasDiagram(block)).toEqual(layoutCanvasDiagram(block));
  });
});

describe("layoutCanvasDiagram nested groups", () => {
  const nested = diagram({
    nodes: ["gw", "a1", "a2", "pod", "b1", "out"].map((id) => ({
      nodeId: id as never,
      label: id,
    })),
    edges: [
      { edgeId: "e1" as never, source: "gw" as never, target: "a1" as never },
      { edgeId: "e2" as never, source: "a1" as never, target: "pod" as never },
      { edgeId: "e3" as never, source: "gw" as never, target: "b1" as never },
      { edgeId: "e4" as never, source: "b1" as never, target: "out" as never },
    ],
    groups: [
      // The child is declared before its parent on purpose.
      {
        groupId: "zone-a" as never,
        label: "Zone A",
        nodeIds: ["a1", "a2"] as never,
        parentGroupId: "region" as never,
      },
      {
        groupId: "pods" as never,
        label: "Pods",
        nodeIds: ["pod"] as never,
        parentGroupId: "zone-a" as never,
      },
      { groupId: "region" as never, label: "Region", nodeIds: ["gw"] as never },
      {
        groupId: "zone-b" as never,
        label: "Zone B",
        nodeIds: ["b1"] as never,
        parentGroupId: "region" as never,
      },
    ],
  });

  it("keeps every child group inside its parent, down to three levels", () => {
    const layout = layoutCanvasDiagram(nested);
    const byId = new Map(layout.groups.map((group) => [group.groupId, group]));

    expect(layout.groups.map((group) => [group.groupId, group.depth, group.parentGroupId])).toEqual(
      [
        ["region", 1, undefined],
        ["zone-a", 2, "region"],
        ["pods", 3, "zone-a"],
        ["zone-b", 2, "region"],
      ],
    );
    for (const group of layout.groups) {
      const parent = byId.get(group.parentGroupId ?? "");
      if (parent !== undefined) expect(inside(group, parent)).toBe(true);
    }
    for (const node of layout.nodes) {
      const owner = { gw: "region", a1: "zone-a", a2: "zone-a", pod: "pods", b1: "zone-b" }[
        node.nodeId as "gw"
      ];
      const frame = byId.get(owner ?? "");
      if (frame !== undefined) expect(inside(node, frame)).toBe(true);
    }
  });

  it("keeps sibling groups apart and a parent's own nodes out of its children", () => {
    const layout = layoutCanvasDiagram(nested);
    const [a, b] = ["zone-a", "zone-b"].map((id) =>
      layout.groups.find((group) => group.groupId === id),
    );
    const gateway = layout.nodes.find((node) => node.nodeId === "gw");

    expect(
      a &&
        b &&
        (a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y),
    ).toBe(true);
    for (const child of [a, b]) {
      expect(gateway && child && inside(gateway, child)).toBe(false);
    }
    expect(layout.groups.every((group) => group.x >= 0 && group.y >= 0)).toBe(true);
  });

  it("keeps a child inside its parent when the author placed the nodes by hand", () => {
    const placed = diagram({
      layout: "manual",
      nodes: [
        { nodeId: "p" as never, label: "P", x: 400, y: 300, positioned: true },
        { nodeId: "c" as never, label: "C", x: 40, y: 20, positioned: true },
      ],
      groups: [
        { groupId: "outer" as never, label: "Outer", nodeIds: ["p"] as never },
        {
          groupId: "inner" as never,
          label: "Inner",
          nodeIds: ["c"] as never,
          parentGroupId: "outer" as never,
        },
      ],
    });
    const layout = layoutCanvasDiagram(placed);
    const [outer, inner] = layout.groups;

    expect(outer && inner && inside(inner, outer)).toBe(true);
  });

  it("keeps every frame and its name inside the picture when a hand-placed node sits near the origin", () => {
    const placed = diagram({
      layout: "manual",
      nodes: [
        { nodeId: "leaf" as never, label: "Leaf", x: 20, y: 60, positioned: true },
        { nodeId: "far" as never, label: "Far", x: 220, y: 160, positioned: true },
      ],
      edges: [{ edgeId: "e" as never, source: "leaf" as never, target: "far" as never }],
      groups: [
        { groupId: "one" as never, label: "One", nodeIds: ["leaf"] as never },
        {
          groupId: "two" as never,
          label: "Two",
          nodeIds: [] as never,
          parentGroupId: "one" as never,
        },
        {
          groupId: "three" as never,
          label: "Three",
          nodeIds: ["leaf"] as never,
          parentGroupId: "two" as never,
        },
      ],
    });
    const layout = layoutCanvasDiagram(placed);
    const [leaf, far] = layout.nodes;

    expect(layout.groups).toHaveLength(3);
    for (const group of layout.groups) {
      expect(group.x).toBeGreaterThanOrEqual(0);
      expect(group.y).toBeGreaterThanOrEqual(0);
      expect(group.x + group.width).toBeLessThanOrEqual(layout.width);
      expect(group.y + group.height).toBeLessThanOrEqual(layout.height);
    }
    // Slid as one: the two hand-placed nodes keep their distance apart.
    expect((far?.x ?? 0) - (leaf?.x ?? 0)).toBe(200);
    expect((far?.y ?? 0) - (leaf?.y ?? 0)).toBe(100);
  });

  it("draws a group whose parent is unknown or loops back as a top-level one", () => {
    const layout = layoutCanvasDiagram(
      diagram({
        groups: [
          {
            groupId: "x" as never,
            label: "X",
            nodeIds: ["client"] as never,
            parentGroupId: "y" as never,
          },
          {
            groupId: "y" as never,
            label: "Y",
            nodeIds: ["server"] as never,
            parentGroupId: "x" as never,
          },
          {
            groupId: "z" as never,
            label: "Z",
            nodeIds: ["store"] as never,
            parentGroupId: "missing" as never,
          },
        ],
      }),
    );

    expect(layout.groups.map((group) => group.groupId).sort()).toEqual(["x", "y", "z"]);
    expect(layout.groups.find((group) => group.groupId === "z")?.depth).toBe(1);
  });
});

describe("canvasDiagramNodeContent", () => {
  const box = (overrides: Partial<CanvasDiagramNodeBox>): CanvasDiagramNodeBox => ({
    nodeId: "n",
    label: "Orders",
    shape: "plain",
    x: 100,
    y: 50,
    width: 160,
    height: 48,
    ...overrides,
  });

  it("puts the icon left of the label and the subtitle beneath it", () => {
    const content = canvasDiagramNodeContent(box({ icon: "database", detail: "Postgres 16" }));

    expect(content.icon).toEqual({ name: "database", x: 112, y: 66, size: 16 });
    expect(content.labelX).toBeGreaterThan(100 + 12 + 16);
    expect(content.detail?.text).toBe("Postgres 16");
    expect(content.detail?.y).toBeGreaterThan(content.labelY);
  });

  it("centres a plain node's label as it was drawn before icons", () => {
    const content = canvasDiagramNodeContent(box({}));

    expect(content).toEqual({ labelX: 180, labelY: 74 });
  });

  it("cuts a subtitle that would leave the box, and draws a diamond's label alone", () => {
    const long = "a".repeat(120);

    expect(canvasDiagramNodeContent(box({ detail: long })).detail?.text.endsWith("…")).toBe(true);
    expect(canvasDiagramNodeContent(box({ detail: long })).detail?.text.length).toBeLessThan(30);
    expect(canvasDiagramNodeContent(box({ shape: "decision", icon: "auth", detail: "x" }))).toEqual(
      {
        labelX: 180,
        labelY: 74,
      },
    );
  });
});
