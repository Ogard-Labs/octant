import { decodeArtifactLibraryEntry } from "@octant/contracts/artifact-library";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBlock,
} from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import {
  notificationStatesExampleBlock,
  releaseMindmapBlock,
  settingsScreenExampleBlock,
  supportFlowBlock,
} from "@octant/domain";
import { renderArtifactSidecarSvg, renderArtifactThumbnail } from "./artifactRender";

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

const treemap = decodeCanvasBlock({
  blockId: "map-1",
  schemaVersion: CANVAS_SCHEMA_VERSION,
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
});

describe("drawing a preview of an artifact", () => {
  it("names a mind map's root and its topics in the exported picture", () => {
    const markup = renderArtifactSidecarSvg(definition([releaseMindmapBlock]));

    // The root and each drawn child carry their topic, clamped to the box.
    expect(markup).toContain(">Release readi");
    expect(markup).toContain(">Test coverage<");
    expect(markup).toContain(">Documentation<");
    expect(markup).toContain(">Packaging<");
  });

  it("names each swimlane lane and its first step in the exported picture", () => {
    const markup = renderArtifactSidecarSvg(definition([supportFlowBlock]));

    expect(markup).toContain(">Customer<");
    expect(markup).toContain(">Report a problem<");
  });

  it("draws a treemap from the shared squarified layout, with no script", () => {
    const markup = renderArtifactThumbnail(definition([treemap]));

    expect(markup.startsWith("<svg")).toBe(true);
    expect(markup).not.toMatch(/<\s*script/i);
    // A group frame plus one cell per leaf.
    expect((markup.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("starts a treemap export from the node the author chose", () => {
    const fromLeaf = decodeCanvasBlock({ ...treemap, startNodeId: "a" });
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

  it("draws one frame per mockup variant, and a styled screen apart from a wireframe", () => {
    const states = renderArtifactThumbnail(definition([notificationStatesExampleBlock]));
    const single = renderArtifactThumbnail(definition([settingsScreenExampleBlock]));
    const frames = (markup: string) => (markup.match(/data-mockup-frame/g) ?? []).length;

    expect(frames(states)).toBe(3);
    expect(frames(single)).toBe(1);
    const wireframe = renderArtifactThumbnail(
      definition([decodeCanvasBlock({ ...notificationStatesExampleBlock, fidelity: "wireframe" })]),
    );
    expect(wireframe).not.toBe(states);
    expect(states).not.toMatch(/<\s*script/i);
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

  it("draws a comparison matrix as a grid with the recommended column framed, with no script", () => {
    const matrix = decodeCanvasBlock({
      blockId: "state-store",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "comparison-matrix",
      options: [
        { optionId: "postgres", label: "Postgres" },
        { optionId: "sqlite", label: "SQLite" },
      ],
      criteria: [
        { criterionId: "durability", label: "Crash safety" },
        { criterionId: "offline", label: "Works offline" },
      ],
      cells: [
        { criterionId: "durability", optionId: "postgres", score: 4 },
        { criterionId: "durability", optionId: "sqlite", score: 5 },
        { criterionId: "offline", optionId: "sqlite", glyph: "yes" },
      ],
      recommendedOptionId: "sqlite",
    });

    const markup = renderArtifactThumbnail(definition([matrix], "State store"));

    expect(markup.startsWith("<svg")).toBe(true);
    expect(markup).not.toMatch(/<\s*script/i);
    expect(markup).toContain("SQLite");
    expect(markup).toContain("Crash safety");
    expect(markup).toContain('data-recommended="true"');
  });

  it("draws a display formula as its escaped source and a math paragraph as prose", () => {
    const formula = decodeCanvasBlock({
      blockId: "inequality",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "math",
      layout: "display",
      source: "a<b \\Rightarrow a+c<b+c",
    });
    const sentence = decodeCanvasBlock({
      blockId: "area",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "math",
      layout: "inline",
      runs: [{ text: "A circle covers " }, { math: "\\pi r^2" }],
    });

    const markup = renderArtifactThumbnail(definition([formula, sentence], "Proof"));

    expect(markup.startsWith("<svg")).toBe(true);
    expect(markup).toContain('data-math="display"');
    expect(markup).toContain("a&lt;b \\Rightarrow a+c&lt;b+c");
    expect(markup).toContain('data-math="inline"');
    expect(markup).not.toMatch(/<\s*script|<foreignObject/i);
  });

  it("keeps a recommended option past the visible columns in the comparison matrix thumbnail", () => {
    const options = Array.from({ length: 7 }, (_value, index) => ({
      optionId: `option-${String(index)}`,
      label: `Choice${String(index)}`,
    }));
    const matrix = decodeCanvasBlock({
      blockId: "wide-decision",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "comparison-matrix",
      options,
      criteria: [{ criterionId: "fit", label: "Fit" }],
      cells: options.map((option, index) => ({
        criterionId: "fit",
        optionId: option.optionId,
        score: index,
      })),
      recommendedOptionId: "option-6",
    });

    const markup = renderArtifactThumbnail(definition([matrix], "Wide"));

    expect(markup).toContain("Choice6");
    expect(markup).toContain('data-recommended="true"');
    expect(markup).not.toContain("Choice4");
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
