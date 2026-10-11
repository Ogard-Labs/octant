import { decodeCanvasBlock, type CanvasDiagramBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import { layoutCanvasDiagram } from "./canvasDiagramLayout";
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
