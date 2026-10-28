import { decodeCanvasBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";

import { chartExampleBlocks } from "./canvasChartExamples";
import { opsDashboardExampleBlocks } from "./canvasDashboardExamples";
import {
  appWindowPrototypeExampleBlock,
  launchDeckExampleBlock,
  onboardingFlowExampleBlock,
  searchSpecExampleBlock,
} from "./canvasDesignExamples";
import { launchGanttExample } from "./canvasLayoutExamples";
import { mathExampleBlocks } from "./canvasMathExamples";
import { settingsScreenExampleBlock } from "./canvasMockupExamples";
import { canvasInlineRefusal } from "./canvasPresentationPolicy";

const board = decodeCanvasBlock({
  blockId: "architecture",
  schemaVersion: 1,
  kind: "diagram",
  nodes: [
    { nodeId: "web", label: "Web" },
    { nodeId: "api", label: "API" },
  ],
  edges: [{ edgeId: "calls", source: "web", target: "api" }],
});

const table = decodeCanvasBlock({
  blockId: "owners",
  schemaVersion: 1,
  kind: "table",
  columns: [
    { id: "area", label: "Area", type: "text" },
    { id: "owner", label: "Owner", type: "text" },
  ],
  rows: [["Search", "Ana"]],
});

describe("canvasInlineRefusal", () => {
  it("admits every chart type, a dashboard, a table, and math in the thread", () => {
    expect(chartExampleBlocks.length).toBeGreaterThan(0);
    for (const chart of chartExampleBlocks) expect(canvasInlineRefusal([chart])).toBeUndefined();
    expect(canvasInlineRefusal(opsDashboardExampleBlocks)).toBeUndefined();
    expect(canvasInlineRefusal([table])).toBeUndefined();
    expect(canvasInlineRefusal(mathExampleBlocks)).toBeUndefined();
  });

  it("admits a diagram board, which the thread draws without its editing runtime", () => {
    expect(canvasInlineRefusal([board])).toBeUndefined();
  });

  it("admits the agent's inline request for a design drawn as a document", () => {
    expect(canvasInlineRefusal([searchSpecExampleBlock])).toBeUndefined();
  });

  it("admits a document-size design that runs script, which waits in the thread for Run", () => {
    const page = decodeCanvasBlock({
      ...searchSpecExampleBlock,
      theme: "none",
      runsScript: true,
    });
    expect(canvasInlineRefusal([page])).toBeUndefined();
  });

  it("keeps a device-size design in the sidebar and tells the agent the thread shows a preview card", () => {
    for (const [design, size] of [
      [onboardingFlowExampleBlock, "phone"],
      [launchDeckExampleBlock, "slide"],
      [appWindowPrototypeExampleBlock, "desktop"],
    ] as const) {
      const refusal = canvasInlineRefusal([design]);
      expect(refusal).toContain(`${size} design`);
      expect(refusal).toContain("preview card");
      expect(refusal).toContain("document-size design");
    }
  });

  it("keeps a plan and a mockup in the sidebar, even beside blocks the thread could draw", () => {
    const plan = decodeCanvasBlock(launchGanttExample);
    expect(canvasInlineRefusal([table, plan])).toContain("plan block");
    expect(canvasInlineRefusal([board, settingsScreenExampleBlock])).toContain("mockup block");
  });
});
