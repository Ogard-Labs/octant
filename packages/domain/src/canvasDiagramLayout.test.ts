import type { CanvasDiagramBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import { layoutCanvasDiagram } from "./canvasDiagramLayout";

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
