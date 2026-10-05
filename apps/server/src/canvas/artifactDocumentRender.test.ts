import type { CanvasBlock } from "@octant/contracts/canvas";
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
      columns: [{ columnId: "path", label: "Path" }],
      rows: [["C:\\temp\\|x"]],
    } as unknown as CanvasBlock;

    const rendered = renderArtifactMarkdown(definition([table]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    const row = rendered.body.split("\n").find((line) => line.includes("temp"));
    // One cell: every pipe inside it is escaped, so only the two outer pipes delimit.
    expect(row).toBe("| C:\\\\temp\\\\\\|x |");
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
});
