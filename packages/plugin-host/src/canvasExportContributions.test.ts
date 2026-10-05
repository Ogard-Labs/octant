import { describe, expect, it } from "vitest";
import {
  decodeCanvasExportOfferList,
  type CanvasExportContribution,
  type CanvasExportTargetOffer,
} from "@octant/contracts/canvas-export";
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

function listOf(targets: ReadonlyArray<CanvasExportTargetOffer>) {
  return {
    schemaVersion: 1,
    kind: "canvas-export-offers",
    canvasId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    targets,
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
  it("replaces a standing refusal that is too long or names a path so the other destinations still list", () => {
    const refusals = ["x".repeat(2_000), "Declined: see /Users/someone/exports/log.txt"];
    for (const standingRefusal of refusals) {
      const offers = offerCanvasExportTargets([
        { contribution: contribution("archive-copy"), facts: { ...ready, standingRefusal } },
        { contribution: contribution("reading-copy"), facts: ready },
      ]);

      expect(offers).toMatchObject([
        { targetId: "archive-copy", status: "refused", message: expect.any(String) },
        { targetId: "reading-copy", status: "ready" },
      ]);
      expect(() => decodeCanvasExportOfferList(listOf(offers))).not.toThrow();
      expect(offers[0]?.message).not.toContain("/Users");
      expect(offers[0]?.message?.length).toBeLessThan(200);
    }
  });
});
