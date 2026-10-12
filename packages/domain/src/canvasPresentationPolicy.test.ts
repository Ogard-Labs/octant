import { decodeCanvasBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";

import { onboardingFlowExampleBlock, searchSpecExampleBlock } from "./canvasDesignExamples";
import { canvasInlineRefusal } from "./canvasPresentationPolicy";

describe("canvasInlineRefusal", () => {
  it("admits the agent's inline request for a design drawn as a document", () => {
    expect(canvasInlineRefusal([searchSpecExampleBlock])).toBeUndefined();
  });

  it("keeps a device-size design in the sidebar and tells the agent which design could go inline", () => {
    const refusal = canvasInlineRefusal([onboardingFlowExampleBlock]);
    expect(refusal).toContain("phone design");
    expect(refusal).toContain("document-size design");
  });

  it("keeps a document that runs script in the sidebar, where the person starts it", () => {
    const prototype = decodeCanvasBlock({
      ...searchSpecExampleBlock,
      theme: "none",
      runsScript: true,
    });
    expect(canvasInlineRefusal([prototype])).toContain("runs script");
  });
});
