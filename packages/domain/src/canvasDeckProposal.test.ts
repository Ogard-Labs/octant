import { describe, expect, it } from "vitest";
import {
  CANVAS_MAX_DECK_SLIDES,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBlock,
} from "@octant/contracts/canvas";
import { proposeCanvasDeck } from "./canvasDeckProposal";
import { validateCanvasDefinition } from "./canvasPolicy";

const base = { schemaVersion: CANVAS_SCHEMA_VERSION };

const search = decodeCanvasBlock({
  ...base,
  blockId: "search",
  kind: "mockup",
  device: "phone",
  title: "Search",
  variants: [
    { variantId: "empty", label: "Empty" },
    { variantId: "filled", label: "Filled" },
  ],
  nodes: [
    { nodeId: "w-empty", component: "window", label: "Search", variantId: "empty" },
    { nodeId: "w-filled", component: "window", label: "Search", variantId: "filled" },
  ],
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
const prototype = decodeCanvasBlock({
  ...base,
  blockId: "prototype",
  kind: "design",
  title: "Prototype",
  size: "phone",
  runsScript: true,
  frames: [{ frameId: "run", title: "Run", html: "<h1>Run</h1>" }],
});
const signups = decodeCanvasBlock({
  ...base,
  blockId: "signups",
  kind: "metric",
  label: "Weekly signups",
  value: 1284,
});
const placedScreen = decodeCanvasBlock({
  ...base,
  blockId: "placed",
  kind: "mockup",
  device: "phone",
  title: "Placed",
  nodes: [{ nodeId: "window", component: "window", label: "Placed" }],
});
const flow = decodeCanvasBlock({
  ...base,
  blockId: "app-flow",
  kind: "flow",
  title: "Search flow",
  screens: [{ screenId: "s1", blockId: "placed" }],
  edges: [],
});

/** A Work Canvas, so a running design is admitted beside the proposal. */
function definition(blocks: ReadonlyArray<unknown>, title: string) {
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    title,
    provenance: {
      mode: "work",
      hostId: "local",
      projectId: "22222222-2222-4222-8222-222222222222",
      threadId: "33333333-3333-4333-8333-333333333333",
      actor: { kind: "local-user", actorId: "55555555-5555-4555-8555-555555555555" },
      providerInstanceId: "44444444-4444-4444-8444-444444444444",
      modelId: "octant-test-model",
      createdAt: "2026-10-28T21:00:00.000Z",
    },
    sourceManifest: [],
    blocks,
  };
}

function withProposal(blocks: ReadonlyArray<CanvasBlock>, title = "Launch review") {
  const deck = proposeCanvasDeck({ title, blocks });
  if (deck === undefined) throw new Error("expected a proposal");
  const { omitted: _omitted, ...proposed } = deck;
  return { deck, document: definition([...blocks, { ...base, ...proposed }], title) };
}

describe("proposing a deck", () => {
  it("presents static designs' frames, then mockups at each variant, then readings", () => {
    const { deck } = withProposal([signups, search, site, prototype, placedScreen, flow]);
    expect(deck.slides).toEqual([
      { slideId: "s1", blockId: "site", frameId: "home", notes: "Open here." },
      { slideId: "s2", blockId: "site", frameId: "about" },
      { slideId: "s3", blockId: "search", variantId: "empty" },
      { slideId: "s4", blockId: "search", variantId: "filled" },
      // The flow places its screen and a running design keeps its own Run,
      // so neither becomes a slide.
      { slideId: "s5", blockId: "signups" },
    ]);
    expect(deck.omitted).toBe(0);
  });

  it("passes the same policy a hand-written deck does", () => {
    const { document } = withProposal([signups, search, site, prototype, placedScreen, flow]);
    expect(() => validateCanvasDefinition(document)).not.toThrow();
  });

  it("takes a block id the document has not used, and bounds a long title", () => {
    const taken = decodeCanvasBlock({
      ...base,
      blockId: "deck",
      kind: "metric",
      label: "Deck",
      value: 1,
    });
    const { deck, document } = withProposal([taken, site], "T".repeat(256));
    expect(deck.blockId).toBe("deck-2");
    expect(deck.title.length).toBeLessThanOrEqual(512);
    expect(() => validateCanvasDefinition(document)).not.toThrow();
  });

  it("keeps to the slide budget and says how many it left out", () => {
    const many = Array.from({ length: CANVAS_MAX_DECK_SLIDES + 3 }, (_, index) =>
      decodeCanvasBlock({
        ...base,
        blockId: `metric-${String(index)}`,
        kind: "metric",
        label: `Metric ${String(index)}`,
        value: index,
      }),
    );
    const { deck, document } = withProposal(many);
    expect(deck.slides).toHaveLength(CANVAS_MAX_DECK_SLIDES);
    expect(deck.omitted).toBe(3);
    expect(() => validateCanvasDefinition(document)).not.toThrow();
  });

  it("proposes nothing when the document has too little to present", () => {
    expect(proposeCanvasDeck({ title: "Note", blocks: [signups] })).toBeUndefined();
  });
});
