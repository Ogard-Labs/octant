import { describe, expect, it } from "vitest";
import { decodeCanvasBlock, type CanvasDefinition } from "@octant/contracts/canvas";
import { proposeCanvasDeck } from "./canvasDeckProposal";

const base = { schemaVersion: 26 };

const search = decodeCanvasBlock({
  ...base,
  blockId: "search",
  kind: "mockup",
  device: "phone",
  title: "Search",
  nodes: [{ nodeId: "window", component: "window", label: "Search" }],
});
const site = decodeCanvasBlock({
  ...base,
  blockId: "site",
  kind: "design",
  title: "Site",
  size: "phone",
  frames: [
    { frameId: "home", title: "Home", html: "<h1>Home</h1>", notes: "Open here." },
    { frameId: "about", title: "About", html: "<h1>About</h1>" },
  ],
});
const signups = decodeCanvasBlock({
  blockId: "signups",
  schemaVersion: 1,
  kind: "metric",
  label: "Weekly signups",
  value: 1284,
});
const flow = decodeCanvasBlock({
  ...base,
  blockId: "app-flow",
  kind: "flow",
  title: "Search flow",
  screens: [{ screenId: "s1", blockId: "search" }],
  edges: [],
});

const definition = {
  title: "Launch review",
  provenance: { mode: "chat" },
  schemaVersion: 26,
  blocks: [site, search, signups, flow],
} as unknown as Pick<CanvasDefinition, "title" | "blocks">;

describe("proposing a deck", () => {
  it("presents the document's own screens and numbers in order, with notes", () => {
    const deck = proposeCanvasDeck(definition);
    expect(deck?.kind).toBe("deck");
    expect(deck?.slides).toEqual([
      { slideId: "slide-site-home", blockId: "site", frameId: "home", notes: "Open here." },
      { slideId: "slide-site-about", blockId: "site", frameId: "about" },
      // The flow places the search screen, so the deck does not place it again.
      { slideId: "slide-signups", blockId: "signups" },
    ]);
  });

  it("proposes nothing when the document has too little to present", () => {
    const thin = {
      title: "Note",
      provenance: { mode: "chat" },
      schemaVersion: 26,
      blocks: [signups],
    } as unknown as Pick<CanvasDefinition, "title" | "blocks">;
    expect(proposeCanvasDeck(thin)).toBeUndefined();
  });
});
