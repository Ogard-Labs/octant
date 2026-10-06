import type { CanvasBlock } from "@octant/contracts/canvas";
import { formatCanvasNumber } from "@octant/domain/canvas-number-format";
import { describe, expect, it } from "vitest";
import { renderArtifactHtml, renderArtifactMarkdown } from "./artifactDocumentRender";

function definition(blocks: ReadonlyArray<CanvasBlock>, title = "Launch plan") {
  return { title, blocks };
}

const heading = {
  blockId: "heading-1",
  schemaVersion: 1,
  kind: "heading",
  level: 1,
  text: "Scope",
} as unknown as CanvasBlock;

const prose = {
  blockId: "text-1",
  schemaVersion: 1,
  kind: "rich-text",
  text: "Ship the reading copy.",
} as unknown as CanvasBlock;

const metric = {
  blockId: "metric-1",
  schemaVersion: 1,
  kind: "metric",
  label: "Signups",
  value: 12,
} as unknown as CanvasBlock;

const MARKDOWN = `# Launch plan

## Scope

Ship the reading copy.

Signups: 12
`;

const HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Launch plan</title><style>body{font-family:system-ui,sans-serif;background:#f4f4f5;color:#3f3f46;margin:24px;line-height:1.45}h1{font-size:20px}h2,h3,h4,h5,h6{font-size:16px}table{border-collapse:collapse}td,th{border:1px solid #a1a1aa;padding:4px 8px;text-align:left}pre{white-space:pre-wrap}a{color:inherit}</style></head><body><h1>Launch plan</h1><h2>Scope</h2><p>Ship the reading copy.</p><p>Signups: 12</p></body></html>\n';

describe("rendering a canvas as a document", () => {
  it("snapshots the markdown and html reading of the same blocks", () => {
    const source = definition([heading, prose, metric]);

    expect(renderArtifactMarkdown(source)).toEqual({
      kind: "rendered",
      title: "Launch plan",
      body: MARKDOWN,
    });
    expect(renderArtifactHtml(source)).toEqual({
      kind: "rendered",
      title: "Launch plan",
      body: HTML,
    });
  });

  it("keeps a table cell that ends in a backslash from splitting the row", () => {
    const table = {
      blockId: "table-1",
      schemaVersion: 1,
      kind: "table",
      columns: [{ columnId: "pattern", label: "Pattern" }],
      rows: [["one\\|two"]],
    } as unknown as CanvasBlock;

    const rendered = renderArtifactMarkdown(definition([table]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    const row = rendered.body.split("\n").find((line) => line.includes("one"));
    // One cell: the backslash and the pipe are both escaped, so only the two outer
    // pipes delimit.
    expect(row).toBe("| one\\\\\\|two |");
  });

  it("does not emit script or an external reference", () => {
    const html = renderArtifactHtml(definition([], "</title><script>alert(1)</script><title>"));

    expect(html.kind).toBe("rendered");
    if (html.kind !== "rendered") return;
    expect(html.body).not.toMatch(/<script/i);
    expect(html.body).toContain("&lt;script&gt;");
    expect(html.body).not.toMatch(/\b(?:src|href)=/i);
  });

  it("redacts text the share filter would not let leave the host", () => {
    const markdown = renderArtifactMarkdown(
      definition([
        {
          ...prose,
          text: "token sk-proj-abcdefghij0123456789",
        } as unknown as CanvasBlock,
      ]),
    );

    expect(markdown.kind).toBe("rendered");
    if (markdown.kind !== "rendered") return;
    expect(markdown.body).toContain("[redacted]");
    expect(markdown.body).not.toContain("sk-proj-");
  });

  it("reads an exported number through the format the block names", () => {
    // The document a destination receives is the same reading the screen
    // shows, so a named format is applied on export too, not only in the app.
    const formatted = renderArtifactMarkdown(
      definition([
        {
          blockId: "metric-format",
          schemaVersion: 1,
          kind: "metric",
          label: "Requests",
          value: 1_360_000,
          format: "compact",
        } as unknown as CanvasBlock,
      ]),
    );

    expect(formatted.kind).toBe("rendered");
    if (formatted.kind !== "rendered") return;
    expect(formatted.body).toContain(`Requests: ${formatCanvasNumber(1_360_000, "compact")}`);
    expect(formatted.body).not.toContain("1360000");
  });

  it("writes a treemap as an indented table of every measure", () => {
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

    const rendered = renderArtifactMarkdown(definition([treemap]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(rendered.body).toContain("| Item | Lines of code | Edits |");
    // A leaf row is indented under its group, and the group's readings are its sum.
    expect(rendered.body).toContain("| \u00A0\u00A0A | 10 | 2 |");
    expect(rendered.body).toContain("| Root | 40 | 7 |");
  });

  it("writes a heatmap matrix as a table of every coordinate and its total", () => {
    const matrix = {
      blockId: "commits",
      schemaVersion: 5,
      kind: "heatmap",
      layout: "matrix",
      valueLabel: "Commits",
      rows: [
        { rowId: "mon", label: "Mon" },
        { rowId: "tue", label: "Tue" },
      ],
      columns: [
        { columnId: "h09", label: "09" },
        { columnId: "h10", label: "10" },
      ],
      cells: [
        { rowId: "mon", columnId: "h09", value: 3 },
        { rowId: "tue", columnId: "h10", value: 6 },
      ],
    } as unknown as CanvasBlock;

    const rendered = renderArtifactMarkdown(definition([matrix]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(rendered.body).toContain("| Row | 09 | 10 | Total |");
    // A coordinate the block does not list reads as an empty cell, not a zero.
    expect(rendered.body).toContain("| Mon | 3 |  | 3 |");
    expect(rendered.body).toContain("| Tue |  | 6 | 6 |");
  });

  it("writes a calendar heatmap as a dated list of readings", () => {
    const calendar = {
      blockId: "failures",
      schemaVersion: 5,
      kind: "heatmap",
      layout: "calendar",
      valueLabel: "Test failures",
      days: [
        { date: "2026-09-01", value: 0 },
        { date: "2026-09-02", value: 4, note: "Flaky suite" },
      ],
    } as unknown as CanvasBlock;

    const rendered = renderArtifactMarkdown(definition([calendar]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(rendered.body).toContain("| Date | Test failures | Note |");
    expect(rendered.body).toContain("| 2026-09-01 | 0 |  |");
    expect(rendered.body).toContain("| 2026-09-02 | 4 | Flaky suite |");
  });

  it("writes a bar list as a ranked table with an optional second reading", () => {
    const barList = {
      blockId: "hottest-files",
      schemaVersion: 6,
      kind: "bar-list",
      valueLabel: "Edits",
      secondaryLabel: "Lines",
      rows: [
        { label: "apps/web", value: 41, secondaryValue: 1189 },
        { label: "packages/domain", value: 33 },
      ],
    } as unknown as CanvasBlock;

    const rendered = renderArtifactMarkdown(definition([barList]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(rendered.body).toContain("| Item | Edits | Lines |");
    // The author's declared order is kept; a row without a second reading leaves
    // an empty cell rather than a zero.
    expect(rendered.body).toContain(`| apps/web | 41 | ${formatCanvasNumber(1189)} |`);
    expect(rendered.body).toContain("| packages/domain | 33 |  |");
  });

  it("carries a metric caption into its reading", () => {
    const captioned = {
      blockId: "metric-caption",
      schemaVersion: 6,
      kind: "metric",
      label: "Signups",
      value: 12,
      caption: "since last release",
    } as unknown as CanvasBlock;

    const rendered = renderArtifactMarkdown(definition([captioned]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(rendered.body).toContain("Signups: 12 — since last release");
  });

  it("writes an entity-relationship model as an attribute table and a relationship list", () => {
    const er = {
      blockId: "order-schema",
      schemaVersion: 8,
      kind: "er",
      entities: [
        {
          entityId: "person",
          label: "Person",
          attributes: [{ attributeId: "person-id", name: "id", type: "uuid", key: true }],
        },
        {
          entityId: "order",
          label: "Order",
          attributes: [
            { attributeId: "order-id", name: "id", type: "uuid", key: true },
            { attributeId: "order-person", name: "person_id", type: "uuid" },
          ],
        },
      ],
      relationships: [
        {
          relationshipId: "person-places-order",
          source: "person",
          target: "order",
          sourceCardinality: "one",
          targetCardinality: "many",
          label: "places",
        },
      ],
    } as unknown as CanvasBlock;

    const rendered = renderArtifactMarkdown(definition([er]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(rendered.body).toContain("| Entity | Attribute | Type | Key |");
    expect(rendered.body).toContain("| Person | id | uuid | key |");
    expect(rendered.body).toContain("| Order | person_id | uuid |  |");
    expect(rendered.body).toContain("- Person one — many Order (places)");
  });

  it("writes a swimlane as numbered steps per lane and a connection list", () => {
    const swimlane = {
      blockId: "support-flow",
      schemaVersion: 8,
      kind: "swimlane",
      lanes: [
        { laneId: "customer", label: "Customer", kind: "actor" },
        { laneId: "support", label: "Support", kind: "team" },
      ],
      steps: [
        { stepId: "report", laneId: "customer", label: "Report a problem" },
        { stepId: "triage", laneId: "support", label: "Is it a defect?", decision: true },
      ],
      connections: [
        { connectionId: "report-triage", source: "report", target: "triage", label: "then" },
      ],
    } as unknown as CanvasBlock;

    const rendered = renderArtifactMarkdown(definition([swimlane]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(rendered.body).toContain("### Customer");
    expect(rendered.body).toContain("1. Report a problem");
    expect(rendered.body).toContain("### Support");
    expect(rendered.body).toContain("1. Is it a defect?");
    expect(rendered.body).toContain("- Report a problem → Is it a defect?: then");
  });

  it("writes a mind map as a nested list, nesting the HTML branches as real lists", () => {
    const mindmap = {
      blockId: "release-mindmap",
      schemaVersion: 8,
      kind: "mindmap",
      nodes: [
        { nodeId: "release", label: "Release readiness" },
        { nodeId: "tests", label: "Test coverage", parentId: "release", note: "green on head" },
        { nodeId: "docs", label: "Documentation", parentId: "release" },
        { nodeId: "guide", label: "User guide", parentId: "docs" },
      ],
    } as unknown as CanvasBlock;

    const markdown = renderArtifactMarkdown(definition([mindmap]));
    const html = renderArtifactHtml(definition([mindmap]));

    expect(markdown.kind).toBe("rendered");
    expect(html.kind).toBe("rendered");
    if (markdown.kind !== "rendered" || html.kind !== "rendered") return;
    expect(markdown.body).toContain("- Release readiness");
    expect(markdown.body).toContain("  - Test coverage — green on head");
    expect(markdown.body).toContain("    - User guide");
    expect(html.body).toContain(
      "<ul><li>Release readiness<ul><li>Test coverage — green on head</li><li>Documentation<ul><li>User guide</li></ul></li></ul></li></ul>",
    );
  });
});
