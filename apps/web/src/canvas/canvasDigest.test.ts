import type { CanvasDefinition } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import { canvasDigest } from "./canvasDigest";

function withBlocks(blocks: ReadonlyArray<Record<string, unknown>>): CanvasDefinition {
  return { blocks } as unknown as CanvasDefinition;
}

describe("a one-line read of a Canvas", () => {
  it("says how far a plan has got and which task comes next", () => {
    const digest = canvasDigest(
      withBlocks([
        { kind: "heading", text: "Launch" },
        {
          kind: "plan",
          tasks: [
            { title: "Ship the signup fix", status: "done" },
            { title: "Write the release note", status: "todo" },
            { title: "Announce it", status: "todo" },
          ],
        },
      ]),
    );
    expect(digest).toEqual({
      kind: "plan",
      label: "Plan",
      facts: ["3 tasks", "next: Write the release note"],
      progress: { done: 1, total: 3 },
    });
  });

  it("names a single-series chart by its series and counts several", () => {
    expect(
      canvasDigest(withBlocks([{ kind: "chart", series: [{ label: "Signups" }] }])).facts,
    ).toEqual(["Signups"]);
    expect(
      canvasDigest(withBlocks([{ kind: "chart", series: [{ label: "East" }, { label: "West" }] }]))
        .facts,
    ).toEqual(["2 series"]);
  });

  it("counts a sankey's flows, since it plots no series", () => {
    expect(
      canvasDigest(
        withBlocks([
          {
            kind: "chart",
            chartType: "sankey",
            series: [],
            links: [
              { source: "A", target: "B", value: 1 },
              { source: "B", target: "C", value: 1 },
            ],
          },
        ]),
      ).facts,
    ).toEqual(["2 flows"]);
  });

  it("calls a Canvas of mostly numbers figures, and falls back to its sections", () => {
    expect(canvasDigest(withBlocks([{ kind: "metric" }, { kind: "metric" }])).label).toBe(
      "Numbers",
    );
    expect(
      canvasDigest(
        withBlocks([
          { kind: "heading" },
          { kind: "rich-text" },
          { kind: "heading" },
          { kind: "rich-text" },
        ]),
      ),
    ).toEqual({ kind: "document", label: "Document", facts: ["2 sections"] });
  });
});
