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

const treemap = {
  blockId: "map-1",
  schemaVersion: 4,
  kind: "treemap",
  measures: [
    { measureId: "loc", label: "Lines of code" },
    { measureId: "edits", label: "Edits" },
  ],
  sizeBy: "loc",
  colorBy: "edits",
  nodes: [
    { nodeId: "root", label: "Root" },
    { nodeId: "a", label: "A", parentId: "root", values: { loc: 10, edits: 2 } },
    { nodeId: "b", label: "B", parentId: "root", values: { loc: 30, edits: 5 } },
  ],
} as unknown as CanvasBlock;

describe("drawing a preview of an artifact", () => {
  it("draws a treemap from the shared squarified layout, with no script", () => {
    const markup = renderArtifactThumbnail(definition([treemap]));

    expect(markup.startsWith("<svg")).toBe(true);
    expect(markup).not.toMatch(/<\s*script/i);
    // A group frame plus one cell per leaf.
    expect((markup.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("starts a treemap export from the node the author chose", () => {
    const fromLeaf = {
      ...(treemap as unknown as Record<string, unknown>),
      startNodeId: "a",
    } as unknown as CanvasBlock;
    const whole = (renderArtifactThumbnail(definition([treemap])).match(/<rect/g) ?? []).length;
    const zoomed = (renderArtifactThumbnail(definition([fromLeaf])).match(/<rect/g) ?? []).length;

    expect(zoomed).toBeLessThan(whole);
  });

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

  it("draws a pie as wedges and a donut as a ring, not as bars", () => {
    const slices = [
      { x: "Signups", y: 40 },
      { x: "Activation", y: 30 },
      { x: "Retention", y: 20 },
      { x: "Referral", y: 10 },
    ];
    const series = [{ seriesId: "series-1", label: "Funnel", points: slices }];
    const pieBlock = {
      blockId: "pie-1",
      schemaVersion: 1,
      kind: "chart",
      chartType: "pie",
      series,
    } as unknown as CanvasBlock;
    const donutBlock = {
      blockId: "donut-1",
      schemaVersion: 1,
      kind: "chart",
      chartType: "donut",
      series,
    } as unknown as CanvasBlock;

    const pieMarkup = renderArtifactThumbnail(definition([pieBlock], "Funnel"));
    const donutMarkup = renderArtifactThumbnail(definition([donutBlock], "Funnel"));
    const barMarkup = renderArtifactThumbnail(definition([chart], "Signups"));

    // A pie draws wedge paths; the stock bar silhouette draws only rects.
    expect(pieMarkup).toContain('<path d="M');
    expect(pieMarkup).toContain("A ");
    expect(barMarkup).not.toContain("<path");
    // A donut is the pie with a punched hole; both stay distinct pictures.
    expect(donutMarkup).toContain("<circle");
    expect(donutMarkup).not.toBe(pieMarkup);
    expect(pieMarkup).not.toBe(barMarkup);
  });

  it("draws a bar and line chart with columns and a polyline", () => {
    const block = {
      blockId: "bl-1",
      schemaVersion: 1,
      kind: "chart",
      chartType: "bar-line",
      series: [
        {
          seriesId: "revenue",
          label: "Revenue",
          mark: "bar",
          points: [
            { x: "Q1", y: 10 },
            { x: "Q2", y: 30 },
          ],
        },
        {
          seriesId: "margin",
          label: "Margin",
          mark: "line",
          points: [
            { x: "Q1", y: 4 },
            { x: "Q2", y: 9 },
          ],
        },
      ],
    } as unknown as CanvasBlock;

    const markup = renderArtifactThumbnail(definition([block], "Quarterly"));

    expect(markup).toContain("<polyline");
    expect(markup).toContain("<rect");
  });

  it("keeps stacked and grouped charts distinct pictures of their values", () => {
    const quarters = (seriesId: string, values: ReadonlyArray<number>) => ({
      seriesId,
      label: seriesId,
      points: values.map((y, index) => ({ x: `Q${String(index + 1)}`, y })),
    });
    const stacked = {
      blockId: "stacked-1",
      schemaVersion: 1,
      kind: "chart",
      chartType: "stacked-bar",
      series: [quarters("east", [10, 20, 30]), quarters("west", [30, 20, 10])],
    } as unknown as CanvasBlock;
    const grouped = {
      blockId: "grouped-1",
      schemaVersion: 1,
      kind: "chart",
      chartType: "grouped-bar",
      series: [quarters("east", [10, 20, 30]), quarters("west", [30, 20, 10])],
    } as unknown as CanvasBlock;

    const stackedMarkup = renderArtifactThumbnail(definition([stacked], "Regions"));
    const groupedMarkup = renderArtifactThumbnail(definition([grouped], "Regions"));

    // Both draw columns; their geometry differs, and reversing one series'
    // values changes the picture rather than leaving a stock shape.
    expect(stackedMarkup).toContain("<rect");
    expect(groupedMarkup).toContain("<rect");
    expect(stackedMarkup).not.toBe(groupedMarkup);

    const reshaped = {
      ...(grouped as unknown as Record<string, unknown>),
      series: [quarters("east", [10, 20, 30]), quarters("west", [10, 20, 30])],
    } as unknown as CanvasBlock;
    expect(renderArtifactThumbnail(definition([reshaped], "Regions"))).not.toBe(groupedMarkup);
  });

  it("draws a login sequence and an order state machine as static pictures", () => {
    const sequence = {
      blockId: "login",
      schemaVersion: 1,
      kind: "sequence",
      participants: [
        { participantId: "person", label: "Person" },
        { participantId: "auth", label: "Auth" },
      ],
      messages: [{ messageId: "submit", from: "person", to: "auth", label: "Submit credentials" }],
    } as unknown as CanvasBlock;
    const state = {
      blockId: "order",
      schemaVersion: 1,
      kind: "state",
      states: [
        { stateId: "start", label: "Start", role: "initial" },
        { stateId: "placed", label: "Placed" },
        { stateId: "closed", label: "Closed", role: "final" },
      ],
      transitions: [{ transitionId: "place", source: "start", target: "placed", label: "place" }],
    } as unknown as CanvasBlock;

    const sequenceMarkup = renderArtifactThumbnail(definition([sequence], "Login"));
    const stateMarkup = renderArtifactThumbnail(definition([state], "Order"));

    expect(sequenceMarkup.startsWith("<svg")).toBe(true);
    expect(stateMarkup.startsWith("<svg")).toBe(true);
    expect(sequenceMarkup).toContain("Submit credentials");
    expect(sequenceMarkup).toContain("Person");
    expect(stateMarkup).toContain("Placed");
    expect(stateMarkup).toContain("Closed");
    expect(sequenceMarkup).not.toMatch(/<\s*script/i);
    expect(stateMarkup).not.toMatch(/<\s*script/i);
    expect(sequenceMarkup).not.toBe(stateMarkup);
  });

  it("draws a phone mockup as a frame rather than leaving the preview blank", () => {
    const mockup = {
      blockId: "settings",
      schemaVersion: 1,
      kind: "mockup",
      device: "phone",
      title: "Settings",
      nodes: [
        { nodeId: "window", component: "window", label: "Settings" },
        { nodeId: "wifi", component: "toggle", label: "Wi-Fi", parentId: "window", on: true },
      ],
    } as unknown as CanvasBlock;
    const phone = renderArtifactThumbnail(definition([mockup], "Settings"));
    const desktop = renderArtifactThumbnail(
      definition(
        [
          {
            ...(mockup as unknown as Record<string, unknown>),
            device: "desktop",
          } as unknown as CanvasBlock,
        ],
        "Settings",
      ),
    );

    expect(phone.startsWith("<svg")).toBe(true);
    expect(phone).toContain("<rect");
    expect(phone).not.toMatch(/<\s*script/i);
    expect(phone).not.toBe(desktop);
  });

  it("draws a heatmap as one cell per coordinate, with a dashed cell for a gap", () => {
    const matrix = {
      blockId: "commits",
      schemaVersion: 5,
      kind: "heatmap",
      layout: "matrix",
      rows: [
        { rowId: "mon", label: "Mon" },
        { rowId: "tue", label: "Tue" },
      ],
      columns: [
        { columnId: "h09", label: "09" },
        { columnId: "h10", label: "10" },
      ],
      cells: [{ rowId: "mon", columnId: "h09", value: 3 }],
    } as unknown as CanvasBlock;

    const markup = renderArtifactThumbnail(definition([matrix]));

    expect(markup.startsWith("<svg")).toBe(true);
    expect(markup).not.toMatch(/<\s*script/i);
    // A background, then one cell per coordinate the block declares.
    expect((markup.match(/<rect/g) ?? []).length).toBe(5);
    // The coordinate the block does not list is drawn apart from a zero.
    expect(markup).toContain('stroke-dasharray="2 2"');
  });

  it("draws a calendar heatmap from the shared week grid", () => {
    const calendar = {
      blockId: "failures",
      schemaVersion: 5,
      kind: "heatmap",
      layout: "calendar",
      days: [
        { date: "2026-09-01", value: 0 },
        { date: "2026-09-08", value: 5 },
      ],
    } as unknown as CanvasBlock;

    const markup = renderArtifactThumbnail(definition([calendar]));

    expect(markup.startsWith("<svg")).toBe(true);
    expect(markup).not.toMatch(/<\s*script/i);
    // Eight days are laid out between the first and last reading.
    expect((markup.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it("draws a bar list as a bar and a value per row, with no script", () => {
    const barList = {
      blockId: "hottest-files",
      schemaVersion: 6,
      kind: "bar-list",
      valueLabel: "Edits",
      rows: [
        { label: "apps/web", value: 41 },
        { label: "packages/domain", value: 10 },
      ],
    } as unknown as CanvasBlock;

    const markup = renderArtifactThumbnail(definition([barList], "Hot files"));

    expect(markup.startsWith("<svg")).toBe(true);
    expect(markup).not.toMatch(/<\s*script/i);
    // The background plus one bar per row, and the labels beside them.
    expect(markup).toContain("apps/web");
    expect((markup.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("draws a metric sparkline as a polyline when the block carries one", () => {
    const withSpark = {
      blockId: "metric-1",
      schemaVersion: 6,
      kind: "metric",
      label: "Lines of code",
      value: 1_360_000,
      format: "compact",
      sparkline: [1.2, 1.24, 1.27, 1.36],
      caption: "since last release",
    } as unknown as CanvasBlock;
    const plain = { ...(withSpark as unknown as Record<string, unknown>) };
    delete plain["sparkline"];

    const withMarkup = renderArtifactThumbnail(definition([withSpark]));
    const plainMarkup = renderArtifactThumbnail(definition([plain as unknown as CanvasBlock]));

    expect(withMarkup).toContain("<polyline");
    expect(plainMarkup).not.toContain("<polyline");
  });
});
