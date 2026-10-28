import { describe, expect, it } from "vitest";
import { canvasFlowSite } from "./canvasFlowSite";
import { canvasMockupHtml } from "./canvasMockupHtml";
import { decodeCanvasBlock, type CanvasMockupBlock } from "@octant/contracts/canvas";

const decodedSearch = decodeCanvasBlock({
  blockId: "search",
  schemaVersion: 23,
  kind: "mockup",
  device: "phone",
  title: "Search",
  nodes: [
    { nodeId: "window", component: "window", label: "Search" },
    { nodeId: "go", parentId: "window", component: "button", label: "Go" },
    { nodeId: "hint", parentId: "window", component: "text", label: "Type a name" },
  ],
});
if (decodedSearch.kind !== "mockup") throw new Error("expected a mockup");
const search: CanvasMockupBlock = decodedSearch;

const decodedResults = decodeCanvasBlock({
  blockId: "results",
  schemaVersion: 23,
  kind: "mockup",
  device: "phone",
  title: "Results",
  nodes: [{ nodeId: "window", component: "window", label: "Results" }],
});
if (decodedResults.kind !== "mockup") throw new Error("expected a mockup");
const results: CanvasMockupBlock = decodedResults;

const flow = {
  title: "Search flow",
  screens: [
    { screenId: "s1", blockId: "search" },
    { screenId: "s2", blockId: "results" },
  ],
  edges: [{ edgeId: "go", fromScreenId: "s1", toScreenId: "s2", fromNodeId: "go", label: "Go" }],
};

describe("flow site", () => {
  it("links a hotspot to its target screen with a real anchor, and navigates by :target alone", () => {
    const site = canvasFlowSite({ flow, blocks: [search, results] });
    expect(site).toContain('id="oct-flow-s1" data-start=""');
    expect(site).toContain('id="oct-flow-s2"');
    // The hotspot inside the source screen's page is the anchor to the target.
    expect(site).toContain('<a class="oct-mockup-hotspot" href="#oct-flow-s2">Go</a>');
    // Navigation is CSS alone: no script anywhere in the site.
    expect(site.toLowerCase()).not.toContain("<script");
    expect(site).toContain(".oct-flow-screen:target");
    // The first screen opens the site before any anchor is followed.
    expect(site).toContain(".oct-flow-screen[data-start] { display: block; }");
  });

  it("lists a screen-level transition under its source screen, and leaves a dead end unlinked", () => {
    const site = canvasFlowSite({
      flow: {
        ...flow,
        edges: [{ edgeId: "back", fromScreenId: "s2", toScreenId: "s1", label: "Start over" }],
      },
      blocks: [search, results],
    });
    expect(site).toContain('href="#oct-flow-s1">Start over');
    // The first screen holds no links: nothing leaves it in this flow.
    expect(site).not.toContain('href="#oct-flow-s2">Go');
  });

  it("is deterministic: the same flow exports the same bytes", () => {
    const first = canvasFlowSite({ flow, blocks: [search, results] });
    const second = canvasFlowSite({ flow, blocks: [search, results] });
    expect(first).toBe(second);
  });

  it("carries the design screen markup the caller passes", () => {
    const site = canvasFlowSite({
      flow: {
        ...flow,
        screens: [
          { screenId: "s1", blockId: "search" },
          { screenId: "s2", blockId: "site", frameId: "home" },
        ],
      },
      blocks: [
        search,
        {
          blockId: "site",
          schemaVersion: 23,
          kind: "design",
          title: "Site",
          size: "desktop",
          frames: [{ frameId: "home", title: "Home", html: "<h1>Home</h1>" }],
        } as never,
      ],
      designScreenHtml: new Map([["s2", '<iframe sandbox srcdoc="<h1>Home</h1>"></iframe>']]),
    });
    expect(site).toContain("<iframe sandbox");
  });
});

describe("mockup page generator", () => {
  it("renders the catalog semantically and inert, with values and states", () => {
    const page = canvasMockupHtml(search);
    expect(page).toContain("<h2>Search</h2>");
    expect(page).toContain('aria-label="Search"');
    // The button is inert; the text reads as prose.
    expect(page).toContain("<button");
    expect(page).toContain("disabled>Type a name".replace("Type a name", "Go"));
    expect(page).not.toContain("<script");
  });

  it("turns the nodes a caller names into anchors, and leaves the rest inert", () => {
    const page = canvasMockupHtml(search, {
      hotspots: new Map([["go", "#oct-flow-s2"]]),
    });
    expect(page).toContain('<a class="oct-mockup-hotspot" href="#oct-flow-s2">Go</a>');
    expect(page).not.toContain('href="#oct-flow-s2">Type a name');
  });
});
