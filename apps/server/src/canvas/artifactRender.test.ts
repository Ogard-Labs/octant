import { decodeArtifactLibraryEntry } from "@octant/contracts/artifact-library";
import type { CanvasBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import { renderArtifactThumbnail } from "./artifactRender";

function definition(blocks: ReadonlyArray<CanvasBlock>, title = "Launch plan") {
  return { title, blocks };
}

const chart = {
  blockId: "chart-1",
  schemaVersion: 1,
  kind: "chart",
  chartType: "bar",
  series: [
    {
      seriesId: "series-1",
      label: "Signups",
      points: [
        { x: "Mon", y: 10 },
        { x: "Tue", y: 40 },
      ],
    },
  ],
} as unknown as CanvasBlock;

describe("drawing a preview of an artifact", () => {
  it("draws a self-contained picture with no script and no external references", () => {
    const markup = renderArtifactThumbnail(definition([chart]));

    expect(markup.startsWith("<svg")).toBe(true);
    expect(markup).not.toMatch(/<\s*script/i);
    // The SVG namespace declaration is the only URL a preview may carry; it
    // declares a dialect rather than fetching anything.
    expect(markup.match(/https?:\/\//g)).toEqual(["http://"]);
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(markup).not.toMatch(/\b(?:href|src|xlink|url\()/i);
  });

  it("draws the chart's own values rather than a stock shape", () => {
    const tall = renderArtifactThumbnail(definition([chart]));
    const flat = renderArtifactThumbnail(
      definition([
        {
          ...(chart as unknown as Record<string, unknown>),
          series: [
            {
              seriesId: "series-1",
              label: "Signups",
              points: [
                { x: "Mon", y: 40 },
                { x: "Tue", y: 40 },
              ],
            },
          ],
        } as unknown as CanvasBlock,
      ]),
    );

    expect(tall).not.toBe(flat);
  });

  it("never lets artifact text become markup", () => {
    const markup = renderArtifactThumbnail(
      definition([], '</svg><script>alert(1)</script><svg foo="'),
    );

    expect(markup).not.toMatch(/<\s*script/i);
    expect(markup).toContain("&lt;script&gt;");
    expect(markup.match(/<svg/g)).toHaveLength(1);
  });

  it("produces a preview the contract will accept", () => {
    const entry = decodeArtifactLibraryEntry({
      canvasId: "10000000-0000-4000-8000-000000000001",
      projectId: "20000000-0000-4000-8000-000000000001",
      projectName: "Storefront",
      mode: "work",
      kind: "chart",
      title: "Launch plan",
      versionCount: 1,
      currentVersionId: "30000000-0000-4000-8000-000000000001",
      currentSequence: 1,
      updatedAt: "2026-08-18T09:00:00.000Z",
      shared: false,
      preview: { format: "svg", markup: renderArtifactThumbnail(definition([chart])) },
    });

    expect(entry.preview?.format).toBe("svg");
  });

  it("gives up rather than emitting a picture too large to carry", () => {
    const many = Array.from({ length: 400 }, (_unused, index) => ({
      blockId: `heading-${String(index)}`,
      schemaVersion: 1,
      kind: "heading",
      level: 2,
      text: `Section ${String(index)} with a reasonably long title to spend characters`,
    })) as unknown as ReadonlyArray<CanvasBlock>;

    // The layout stops at the bottom edge, so a long artifact still fits; the
    // guard is what protects the contract if that ever stops being true.
    expect(renderArtifactThumbnail(definition(many)).length).toBeLessThanOrEqual(4_096);
  });
});
