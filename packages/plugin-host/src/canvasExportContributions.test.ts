import { describe, expect, it } from "vitest";
import type { CanvasExportContribution } from "@octant/contracts/canvas-export";
import {
  offerCanvasExportTargets,
  type CanvasExportActivationFacts,
} from "./canvasExportContributions";

function contribution(
  targetId: string,
  formats: CanvasExportContribution["formats"] = ["markdown", "html"],
): CanvasExportContribution {
  return {
    schemaVersion: 1,
    kind: "canvas-export-contribution",
    targetId: targetId as CanvasExportContribution["targetId"],
    label: "Reading copy",
    formats,
  };
}

const ready: CanvasExportActivationFacts = {
  installed: true,
  trusted: true,
  desiredEnabled: true,
  effectiveState: { kind: "effective" },
  connected: true,
};

describe("offerCanvasExportTargets", () => {
  it("does not offer a target that is not installed", () => {
    const offers = offerCanvasExportTargets([
      { contribution: contribution("reading-copy"), facts: { ...ready, installed: false } },
    ]);

    expect(offers).toEqual([]);
  });

  it("does not offer a disabled target", () => {
    const offers = offerCanvasExportTargets([
      { contribution: contribution("reading-copy"), facts: { ...ready, desiredEnabled: false } },
    ]);

    expect(offers).toEqual([]);
  });

  it("offers a connected destination as ready and a disconnected one as not connected", () => {
    const offers = offerCanvasExportTargets([
      { contribution: contribution("reading-copy"), facts: ready },
      {
        contribution: contribution("archive-copy"),
        facts: { ...ready, connected: false },
      },
    ]);

    expect(offers.map((offer) => ({ id: offer.targetId, status: offer.status }))).toEqual([
      { id: "reading-copy", status: "ready" },
      { id: "archive-copy", status: "not-connected" },
    ]);
  });

  it("offers a standing refusal as refused rather than hiding it", () => {
    const offers = offerCanvasExportTargets([
      {
        contribution: contribution("reading-copy"),
        facts: { ...ready, standingRefusal: "This destination declined exports." },
      },
    ]);

    expect(offers).toMatchObject([{ status: "refused" }]);
  });
});
