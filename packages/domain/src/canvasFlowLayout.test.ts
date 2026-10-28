import { describe, expect, it } from "vitest";
import {
  canvasFlowScreenIntrinsicSize,
  isCanvasFlowHotspotComponent,
  layoutCanvasFlow,
  type CanvasFlowScreenSourceBlock,
  type CanvasFlowShape,
} from "./canvasFlowLayout";

// The layout reads loose shapes (a live definition or a sanitized share), so
// plain literals stand in for the blocks the same way a share document would.
const phoneMockup = {
  blockId: "search",
  kind: "mockup",
  title: "Search",
  device: "phone",
  nodes: [
    { nodeId: "window", component: "window", label: "Search" },
    { nodeId: "go", component: "button", label: "Go", parentId: "window" },
  ],
} as const;

const desktopMockup = {
  blockId: "results",
  kind: "mockup",
  title: "Results",
  device: "desktop",
  nodes: [{ nodeId: "window", component: "window", label: "Results" }],
} as const;

const design = {
  blockId: "site",
  kind: "design",
  title: "Site",
  size: "desktop",
  frames: [
    { frameId: "home", title: "Home", html: "<h1>Home</h1>" },
    { frameId: "about", title: "About", html: "<h1>About</h1>" },
  ],
} as const;

const sources: ReadonlyArray<CanvasFlowScreenSourceBlock> = [phoneMockup, desktopMockup, design];

function flow(
  screens: ReadonlyArray<unknown>,
  edges: ReadonlyArray<unknown> = [],
): CanvasFlowShape {
  return { title: "Search flow", screens, edges } as CanvasFlowShape;
}

describe("flow board layout", () => {
  it("is the same result for the same flow, and ranks screens by their transitions", () => {
    const theFlow = flow(
      [
        { screenId: "search", blockId: "search" },
        { screenId: "results", blockId: "results" },
        { screenId: "about", blockId: "site", frameId: "about" },
      ],
      [
        { edgeId: "go", fromScreenId: "search", toScreenId: "results" },
        { edgeId: "open-about", fromScreenId: "results", toScreenId: "about" },
      ],
    );
    const first = layoutCanvasFlow(theFlow, sources);
    const second = layoutCanvasFlow(theFlow, sources);
    expect(first).toEqual(second);
    // The search screen starts the flow, results sits past it, about past that.
    const search = first.screens.find((screen) => screen.screenId === "search");
    const results = first.screens.find((screen) => screen.screenId === "results");
    const about = first.screens.find((screen) => screen.screenId === "about");
    expect(search?.x).toBe(0);
    expect(results?.x).toBeGreaterThan(search?.x ?? 0);
    expect(about?.x).toBeGreaterThan(results?.x ?? 0);
    // A phone draws at its capped board width and its own aspect.
    expect(search?.width).toBe(200);
    expect(search?.label).toBe("Search");
    // A design screen names the frame it places.
    expect(about?.source).toBe("design");
    expect(about?.label).toBe("About");
  });

  it("walks a reached cycle forward and routes its closing edge backward, below the screens", () => {
    const laid = layoutCanvasFlow(
      flow(
        [
          { screenId: "start", blockId: "search" },
          { screenId: "home", blockId: "results" },
          { screenId: "back", blockId: "site", frameId: "home" },
        ],
        [
          { edgeId: "in", fromScreenId: "start", toScreenId: "home" },
          { edgeId: "cycle", fromScreenId: "home", toScreenId: "back" },
          { edgeId: "loop", fromScreenId: "back", toScreenId: "home" },
        ],
      ),
      sources,
    );
    const start = laid.screens.find((screen) => screen.screenId === "start");
    const home = laid.screens.find((screen) => screen.screenId === "home");
    const back = laid.screens.find((screen) => screen.screenId === "back");
    // Each screen of the loop sits one step past the one before it.
    expect(home?.x).toBeGreaterThan(start?.x ?? 0);
    expect(back?.x).toBeGreaterThan(home?.x ?? 0);
    // The closing edge runs backward, so it steps out below both screens.
    const loop = laid.edges.find((edge) => edge.edgeId === "loop");
    expect(loop?.points[0]?.y).toBe((back?.y ?? 0) + (back?.height ?? 0));
    expect(loop?.points[1]?.y).toBeGreaterThan((back?.y ?? 0) + (back?.height ?? 0));
    expect(laid.height).toBeGreaterThan((back?.y ?? 0) + (back?.height ?? 0));
  });

  it("gives a flow that is only a cycle one column to start from", () => {
    const laid = layoutCanvasFlow(
      flow(
        [
          { screenId: "home", blockId: "results" },
          { screenId: "back", blockId: "site", frameId: "home" },
        ],
        [
          { edgeId: "cycle", fromScreenId: "home", toScreenId: "back" },
          { edgeId: "loop", fromScreenId: "back", toScreenId: "home" },
        ],
      ),
      sources,
    );
    const home = laid.screens.find((screen) => screen.screenId === "home");
    const back = laid.screens.find((screen) => screen.screenId === "back");
    expect(home?.x).toBe(back?.x);
    expect(back?.y).toBeGreaterThan(home?.y ?? 0);
  });

  it("keeps a dragged screen where the journal put it", () => {
    const laid = layoutCanvasFlow(
      flow([
        { screenId: "search", blockId: "search", x: 300, y: 120, positioned: true },
        { screenId: "results", blockId: "results" },
      ]),
      sources,
    );
    const dragged = laid.screens.find((screen) => screen.screenId === "search");
    expect(dragged?.x).toBe(300);
    expect(dragged?.y).toBe(120);
  });

  it("routes a forward transition out of the source's side and a backward one below", () => {
    const forward = layoutCanvasFlow(
      flow(
        [
          { screenId: "search", blockId: "search" },
          { screenId: "results", blockId: "results" },
        ],
        [{ edgeId: "go", fromScreenId: "search", toScreenId: "results" }],
      ),
      sources,
    );
    const forwardEdge = forward.edges[0];
    const search = forward.screens.find((screen) => screen.screenId === "search");
    const results = forward.screens.find((screen) => screen.screenId === "results");
    expect(forwardEdge?.points[0]?.x).toBe((search?.x ?? 0) + (search?.width ?? 0));
    expect(forwardEdge?.points.at(-1)?.x).toBe(results?.x ?? 0);
    expect(forwardEdge?.from.label).toBe("Search");
    expect(forwardEdge?.to.label).toBe("Results");

    // A transition whose source sits to the right of its target runs backward:
    // it leaves the bottom of its source and steps out below both screens.
    const backward = layoutCanvasFlow(
      flow(
        [
          { screenId: "search", blockId: "search", x: 600, y: 0, positioned: true },
          { screenId: "results", blockId: "results", x: 0, y: 0, positioned: true },
        ],
        [{ edgeId: "back", fromScreenId: "search", toScreenId: "results" }],
      ),
      sources,
    );
    const backEdge = backward.edges[0];
    const searchBox = backward.screens.find((screen) => screen.screenId === "search");
    expect(backEdge?.points[0]?.y).toBe((searchBox?.y ?? 0) + (searchBox?.height ?? 0));
    expect(backEdge?.points[1]?.y).toBeGreaterThan((searchBox?.y ?? 0) + (searchBox?.height ?? 0));
    expect(backward.height).toBeGreaterThan(forward.height);
  });

  it("carries the hotspot the author named so the board draws the link from the control", () => {
    const laid = layoutCanvasFlow(
      flow(
        [
          { screenId: "search", blockId: "search" },
          { screenId: "about", blockId: "site", frameId: "about" },
        ],
        [
          {
            edgeId: "go",
            fromScreenId: "search",
            toScreenId: "about",
            fromNodeId: "go",
            label: "Go",
          },
        ],
      ),
      sources,
    );
    const edge = laid.edges[0];
    expect(edge?.hotspot?.nodeId).toBe("go");
    expect(edge?.hotspot?.component).toBe("button");
    expect(edge?.hotspot?.label).toBe("Go");
    expect(edge?.label).toBe("Go");
  });

  it("reads each screen's intrinsic size from its device or its own frame", () => {
    expect(canvasFlowScreenIntrinsicSize(phoneMockup)).toEqual({ width: 390, height: 844 });
    expect(canvasFlowScreenIntrinsicSize(desktopMockup)).toEqual({ width: 1280, height: 800 });
    const custom = { ...phoneMockup, device: "custom", size: { width: 480, height: 640 } };
    expect(canvasFlowScreenIntrinsicSize(custom)).toEqual({ width: 480, height: 640 });
    // A dock panel has no height of its own; the board draws it at a nominal one.
    const panel = { ...phoneMockup, device: "dock-panel" };
    expect(canvasFlowScreenIntrinsicSize(panel)).toEqual({ width: 360, height: 720 });
  });

  it("admits the interactive components as hotspots and refuses the rest", () => {
    for (const component of ["button", "list-row", "nav", "tabs", "select", "checkbox", "toggle"]) {
      expect(isCanvasFlowHotspotComponent(component)).toBe(true);
    }
    for (const component of ["text", "heading", "card", "window", "image-placeholder"]) {
      expect(isCanvasFlowHotspotComponent(component)).toBe(false);
    }
  });
});
