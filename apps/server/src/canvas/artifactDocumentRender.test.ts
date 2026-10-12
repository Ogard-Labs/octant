import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBlock,
} from "@octant/contracts/canvas";
import { formatCanvasNumber } from "@octant/domain/canvas-number-format";
import {
  chartExampleBlocks,
  designBriefExample,
  launchGanttExample,
  layoutCanvasDiagram,
  notificationStatesExampleBlock,
  opsDashboardExampleBlocks,
  settingsScreenExampleBlock,
} from "@octant/domain";
import { describe, expect, it } from "vitest";
import {
  renderArtifactDocument,
  renderArtifactHtml,
  renderArtifactMarkdown,
} from "./artifactDocumentRender";
import { renderArtifactSidecarSvg } from "./artifactRender";

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
      writesDesignMarkup: false,
    });
    expect(renderArtifactHtml(source)).toEqual({
      kind: "rendered",
      title: "Launch plan",
      body: HTML,
      writesDesignMarkup: false,
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

  it("exports a row that carries an id as its cells, in the author's order", () => {
    const table = decodeCanvasBlock({
      blockId: "vendors",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "table",
      columns: [
        { id: "vendor", label: "Vendor", type: "text" },
        { id: "price", label: "Price", type: "number" },
      ],
      rows: [{ id: "acme", cells: ["Acme", 12] }, ["Globex", 9]],
    });

    const rendered = renderArtifactMarkdown(definition([table]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(rendered.body).toContain("| Acme | 12 |\n| Globex | 9 |");
    expect(rendered.body).not.toContain("acme");
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

  it("writes a sankey as its flows and a funnel or radar as every reading", () => {
    const blocks = ["sankey", "funnel", "radar"].map((chartType) => {
      const block = chartExampleBlocks.find((candidate) => candidate.chartType === chartType);
      if (block === undefined) throw new Error(`${chartType} example is missing.`);
      return block;
    });
    const rendered = renderArtifactMarkdown(definition(blocks));
    if (rendered.kind !== "rendered") throw new Error("expected a rendered document");
    expect(rendered.body).toContain("- Search → Docs = 5.2K");
    expect(rendered.body).toContain("- Visitors: Paid = 410");
    expect(rendered.body).toContain("- Self-hosted: Control = 5");
    const html = renderArtifactHtml(definition(blocks));
    if (html.kind !== "rendered") throw new Error("expected a rendered document");
    expect(html.body).toContain("Search → Docs = 5.2K");
  });

  it("writes a treemap as an indented table of every measure", () => {
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
    const barList = decodeCanvasBlock({
      blockId: "hottest-files",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "bar-list",
      valueLabel: "Edits",
      secondaryLabel: "Lines",
      rows: [
        { label: "packages/domain", value: 33 },
        { label: "apps/web", value: 41, secondaryValue: 1189 },
      ],
    });

    const rendered = renderArtifactMarkdown(definition([barList]));

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(rendered.body).toContain("| Item | Edits | Lines |");
    // A row without a second reading leaves an empty cell rather than a zero.
    const largest = `| apps/web | 41 | ${formatCanvasNumber(1189)} |`;
    const smaller = "| packages/domain | 33 |  |";
    expect(rendered.body).toContain(largest);
    expect(rendered.body).toContain(smaller);
    // The export ranks largest first, as the screen and the preview do.
    expect(rendered.body.indexOf(largest)).toBeLessThan(rendered.body.indexOf(smaller));
  });

  it("writes a comparison matrix as a table with each option's weighted score, its notes, and the recommendation", () => {
    const matrix = decodeCanvasBlock({
      blockId: "state-store",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "comparison-matrix",
      options: [
        { optionId: "postgres", label: "Postgres" },
        { optionId: "sqlite", label: "SQLite" },
      ],
      criteria: [
        { criterionId: "durability", label: "Crash safety", weight: 3 },
        { criterionId: "ops", label: "Operational cost", prefer: "lower" },
        { criterionId: "offline", label: "Works offline" },
      ],
      cells: [
        { criterionId: "durability", optionId: "postgres", score: 5 },
        { criterionId: "durability", optionId: "sqlite", score: 5, note: "WAL with full sync" },
        { criterionId: "ops", optionId: "postgres", score: 5 },
        { criterionId: "ops", optionId: "sqlite", score: 1 },
        { criterionId: "offline", optionId: "postgres", glyph: "partial" },
      ],
      scoreRange: { min: 1, max: 5 },
      recommendedOptionId: "sqlite",
      recommendation: "No server to run.",
    });

    const markdown = renderArtifactMarkdown(definition([matrix]));
    expect(markdown.kind).toBe("rendered");
    if (markdown.kind !== "rendered") return;
    expect(markdown.body).toContain("| Criterion | Weight | Postgres | SQLite (recommended) |");
    expect(markdown.body).toContain("| Crash safety | 3 | 5 | 5 [1] |");
    expect(markdown.body).toContain("| Operational cost (lower is better) | 1 | 5 | 1 |");
    // An empty coordinate reads as not assessed, never as a zero or a no.
    expect(markdown.body).toContain("| Works offline | 1 | Partial | Not assessed |");
    // Postgres: 3 × 1 + 1 × 0 + 1 × 0.5 = 3.5 of 5 → 1 + 0.7 × 4 = 3.8.
    // SQLite:   3 × 1 + 1 × 1 + 0 (missing)  = 4 of 5   → 1 + 0.8 × 4 = 4.2.
    expect(markdown.body).toContain(
      "| Weighted score |  | 3.8 of 5 | 4.2 of 5 (highest, 1 not scored) |",
    );
    expect(markdown.body).toContain("1. Crash safety · SQLite: WAL with full sync");
    expect(markdown.body).toContain("Recommended: SQLite. No server to run.");

    const html = renderArtifactHtml(definition([matrix]));
    expect(html.kind).toBe("rendered");
    if (html.kind !== "rendered") return;
    expect(html.body).toContain("<th>SQLite (recommended)</th>");
    expect(html.body).not.toMatch(/<\s*script/i);
  });

  it("writes math as GitHub math in Markdown and as MathML with its source in HTML", () => {
    const formula = decodeCanvasBlock({
      blockId: "bayes",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "math",
      layout: "display",
      source: "P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}",
      caption: "Bayes' theorem",
    });
    const sentence = decodeCanvasBlock({
      blockId: "area",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "math",
      layout: "inline",
      runs: [
        { text: "A circle covers " },
        { math: "\\pi r^2" },
        { text: " when " },
        { math: "r<1" },
      ],
    });

    const markdown = renderArtifactMarkdown(definition([formula, sentence]));
    expect(markdown.kind).toBe("rendered");
    if (markdown.kind !== "rendered") return;
    expect(markdown.body).toContain(
      "```math\nP(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}\n```\n\nBayes' theorem",
    );
    // A formula is a code span, so `<` stays mathematics rather than markup,
    // and the prose keeps the spaces that separate it from the formula.
    expect(markdown.body).toContain("A circle covers $`\\pi r^2`$ when $`r<1`$");

    const html = renderArtifactHtml(definition([formula, sentence]));
    expect(html.kind).toBe("rendered");
    if (html.kind !== "rendered") return;
    expect(html.body).toMatch(/<math[^>]*display="block"/);
    expect(html.body).toContain(
      '<annotation encoding="application/x-tex">P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}</annotation>',
    );
    expect(html.body).toContain("<figcaption>Bayes&apos; theorem</figcaption>");
    expect(html.body).toContain("<summary>Source</summary>");
    expect(html.body).toContain('A circle covers <span class="katex"><math');
    expect(html.body).toContain('<annotation encoding="application/x-tex">r&lt;1</annotation>');
    // MathML alone: no KaTeX glyph layer that would need its stylesheet and fonts.
    expect(html.body).not.toContain("katex-html");
    expect(html.body).not.toMatch(/<\s*script|\son\w+=|href=/i);
  });

  it("writes a formula the typesetter refuses, or one carrying a secret, as text", () => {
    const broken = decodeCanvasBlock({
      blockId: "broken",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "math",
      layout: "display",
      source: "\\frac{1}{",
    });
    const secret = decodeCanvasBlock({
      blockId: "secret",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "math",
      layout: "display",
      source: "\\text{sk-proj-abcdefghijklmnopqrstu}",
    });

    const html = renderArtifactHtml(definition([broken, secret]));
    expect(html.kind).toBe("rendered");
    if (html.kind !== "rendered") return;
    expect(html.body).toContain("<pre>\\frac{1}{</pre>");
    expect(html.body).toContain("[redacted]");
    expect(html.body).not.toContain("sk-proj");

    const markdown = renderArtifactMarkdown(definition([secret]));
    expect(markdown.kind === "rendered" && markdown.body).not.toContain("sk-proj");
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

  it("writes a design as its numbered frame titles and never its markup", () => {
    const design = decodeCanvasBlock({
      blockId: "checkout",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "design",
      title: "Checkout",
      size: "phone",
      styles: "body { color: #1c1917; }",
      frames: [
        { frameId: "cart", title: "Cart", html: '<h1>Cart</h1><a href="#paid">Pay</a>' },
        { frameId: "paid", title: "Paid", html: "<p>Thanks</p>" },
      ],
    });

    const markdown = renderArtifactMarkdown(definition([design]));
    const html = renderArtifactHtml(definition([design]));

    expect(markdown.kind).toBe("rendered");
    expect(html.kind).toBe("rendered");
    if (markdown.kind !== "rendered" || html.kind !== "rendered") return;
    expect(markdown.body).toContain("## Checkout\n\n1. Cart\n2. Paid\n");
    expect(html.body).toContain("<h2>Checkout</h2><ol><li>Cart</li><li>Paid</li></ol>");
    expect(markdown.body).not.toContain("Pay");
    expect(html.body).not.toContain("color: #1c1917");
  });

  describe("a design's frames, once the person exporting has acknowledged its markup leaves as written", () => {
    const frames = { frames: "as-written" } as const;
    const srcdocs = (html: string): ReadonlyArray<string> =>
      Array.from(html.matchAll(/<iframe[^>]* srcdoc="([^"]*)"/g), (match) =>
        (match[1] ?? "")
          .replaceAll("&quot;", '"')
          .replaceAll("&apos;", "'")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&"),
      );

    it("writes a static design as one sandboxed page per screen, with the frame policy inside the page", () => {
      const design = decodeCanvasBlock({
        blockId: "checkout",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "design",
        title: "Checkout",
        size: "phone",
        styles: "body { color: #1c1917; }",
        frames: [
          {
            frameId: "cart",
            title: "Cart",
            html: '<h1 title="a &amp; b">Cart</h1><a href="#paid">Pay</a>',
          },
          { frameId: "paid", title: "Paid", html: "<p>Thanks</p>" },
        ],
      });
      const html = renderArtifactHtml(definition([design]), frames);
      if (html.kind !== "rendered") throw new Error("The export did not render.");

      // No script, an opaque origin, and nothing the page may load.
      expect(html.body.match(/<iframe /g)).toHaveLength(2);
      expect(html.body.match(/<iframe sandbox="" /g)).toHaveLength(2);
      // A document of static frames admits no script anywhere.
      expect(html.body).toContain("frame-src 'none'");
      expect(html.body).not.toContain("script-src");
      expect(html.body).not.toContain("allow-scripts");
      expect(html.body).not.toContain("allow-same-origin");
      const [cart, paid] = srcdocs(html.body);
      for (const page of [cart, paid]) {
        expect(page).toContain(
          `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">`,
        );
        expect(page).toContain("body { color: #1c1917; }");
      }
      expect(cart).toContain('<h1 title="a &amp; b">Cart</h1>');
      expect(cart).not.toContain("Thanks");
      expect(paid).toContain("<p>Thanks</p>");
      // The page is an attribute value: its quotes cannot end it.
      expect(html.body).not.toContain('srcdoc="<');
      // The titles still read without the frames.
      expect(html.body).toContain("<h2>Checkout</h2>");
      expect(html.body).toContain("<figcaption>Cart</figcaption>");
    });

    it("writes a running prototype as one page sandboxed to scripts alone, with no way to connect", () => {
      const prototype = decodeCanvasBlock({
        blockId: "cart",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "design",
        title: "Cart",
        size: "phone",
        runsScript: true,
        frames: [
          {
            frameId: "cart",
            title: "Cart",
            html: '<button onclick="add()">Add</button><script>function add() {}</script>',
          },
          { frameId: "paid", title: "Paid", html: '<a href="#cart">Back</a>' },
        ],
      });
      const html = renderArtifactHtml(definition([prototype]), frames);
      if (html.kind !== "rendered") throw new Error("The export did not render.");

      expect(html.body.match(/<iframe /g)).toHaveLength(1);
      expect(html.body).toContain('<iframe sandbox="allow-scripts" ');
      // The document refuses a frame that tries to load another page, and
      // admits inline script only because a frame here runs some.
      expect(html.body).toContain(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`,
      );
      expect(html.body).not.toContain("allow-same-origin");
      const [page] = srcdocs(html.body);
      expect(page).toContain(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`,
      );
      // The policy is in force before any script in the page is read.
      expect(page?.indexOf("Content-Security-Policy")).toBeLessThan(page?.indexOf("<script") ?? -1);
      expect(page).toContain("<script>function add() {}</script>");
      // A link between screens stays inside the frame's own page.
      expect(page).toContain('href="about:srcdoc#cart"');
    });

    it("draws a placeholder where a design named an image, which stays on this host", () => {
      const design = decodeCanvasBlock({
        blockId: "home",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "design",
        title: "Home",
        size: "phone",
        assets: [
          {
            assetId: "shot",
            source: { kind: "generated-image", imageId: "44444444-4444-4444-8444-444444444444" },
          },
        ],
        frames: [{ frameId: "home", title: "Home", html: '<img src="octant-asset:shot" alt="">' }],
      });
      const html = renderArtifactHtml(definition([design]), frames);
      if (html.kind !== "rendered") throw new Error("The export did not render.");
      const [page] = srcdocs(html.body);
      expect(page).toContain('<img src="data:image/svg+xml');
      expect(html.body).not.toContain("octant-asset:shot");
      expect(html.body).not.toContain("44444444-4444-4444-8444-444444444444");
    });

    it("still writes a design drawn in the workspace theme as its titles, because an export carries no theme", () => {
      const spec = decodeCanvasBlock({
        blockId: "spec",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "design",
        title: "Spec",
        size: "document",
        frames: [
          {
            frameId: "spec",
            title: "Spec",
            html: '<article class="oct-article"><h1>Ranking</h1></article>',
          },
        ],
      });
      const html = renderArtifactHtml(definition([spec]), frames);
      if (html.kind !== "rendered") throw new Error("The export did not render.");
      expect(html.body).not.toContain("<iframe");
      expect(html.body).toContain("<h2>Spec</h2><ol><li>Spec</li></ol>");
    });

    it("keeps Markdown to the titles", () => {
      const design = decodeCanvasBlock({
        blockId: "checkout",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "design",
        title: "Checkout",
        size: "phone",
        frames: [{ frameId: "cart", title: "Cart", html: "<h1>Cart</h1>" }],
      });
      const markdown = renderArtifactDocument(definition([design]), "markdown", frames);
      if (markdown.kind !== "rendered") throw new Error("The export did not render.");
      expect(markdown.body).toContain("## Checkout\n\n1. Cart\n");
      expect(markdown.body).not.toContain("<h1>Cart</h1>");
    });
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

  it("writes a mockup as an outline of its component tree, per variant, with its callouts", () => {
    const markdown = renderArtifactMarkdown(definition([notificationStatesExampleBlock]));
    const html = renderArtifactHtml(definition([notificationStatesExampleBlock]));

    expect(markdown.kind).toBe("rendered");
    expect(html.kind).toBe("rendered");
    if (markdown.kind !== "rendered" || html.kind !== "rendered") return;
    expect(markdown.body).toContain("## Notifications");
    expect(markdown.body).toContain("Phone mockup, styled.");
    expect(markdown.body).toContain("### Error");
    expect(markdown.body).toContain("- Stack, Notifications");
    expect(markdown.body).toContain("  - Button, Try again, accent, callout 1");
    expect(markdown.body).toContain(
      "1. Try again — Retries once, then keeps the toast until online.",
    );
    expect(markdown.body.indexOf("### Loaded")).toBeLessThan(markdown.body.indexOf("### Empty"));
    expect(html.body).toContain(
      "<h3>Empty</h3><ul><li>Stack, Notifications<ul><li>Heading, Notifications</li>",
    );
    expect(html.body).toContain(
      "<ol><li>Try again — Retries once, then keeps the toast until online.</li></ol>",
    );
  });

  it("writes a single-screen wireframe without variant headings, nesting the tree", () => {
    const markdown = renderArtifactMarkdown(definition([settingsScreenExampleBlock]));
    expect(markdown.kind).toBe("rendered");
    if (markdown.kind !== "rendered") return;
    expect(markdown.body).toContain("Desktop mockup, wireframe.");
    expect(markdown.body).not.toContain("### ");
    expect(markdown.body).toContain("- Window, Settings");
    expect(markdown.body).toContain("      - Form field, Display name, Ada Lovelace");
  });

  it("writes a dashboard in reading order where it sits, each placed block once", () => {
    const [board, ...placed] = opsDashboardExampleBlocks;
    if (board === undefined) throw new Error("missing dashboard");
    // Placed blocks listed before the dashboard still read inside it.
    const source = definition([prose, ...placed.slice(0, 2), board, ...placed.slice(2), heading]);
    const markdown = renderArtifactMarkdown(source);
    if (markdown.kind !== "rendered") throw new Error("expected markdown");
    const order = [
      "Ship the reading copy.",
      "## Service health",
      "Requests per second:",
      "p95 latency:",
      "Error rate:",
      "API: Healthy",
      "p50: 09:00",
      "Job queue:",
      "| Incident | Severity | Open (h) |",
      "## Scope",
    ].map((needle) => markdown.body.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markdown.body.split("Requests per second:")).toHaveLength(2);

    const html = renderArtifactHtml(source);
    if (html.kind !== "rendered") throw new Error("expected html");
    const htmlOrder = [
      "<h2>Service health</h2>",
      "Requests per second:",
      "Slow search in eu-west",
      "<h2>Scope</h2>",
    ].map((needle) => html.body.indexOf(needle));
    expect(htmlOrder.every((index) => index >= 0)).toBe(true);
    expect([...htmlOrder].sort((a, b) => a - b)).toEqual(htmlOrder);
  });
});

describe("rendering tabs and columns as a document", () => {
  it("reads each tab under its label and each named block once, in the group", () => {
    const blocks = designBriefExample.map((block) => decodeCanvasBlock(block));
    const rendered = renderArtifactMarkdown(definition(blocks, "Design brief"));
    if (rendered.kind !== "rendered") throw new Error("expected a rendered document");
    const labels = ["Metrics", "Core loop", "World", "Economy", "Content", "Live ops", "Risks"];
    const positions = labels.map((label) => rendered.body.indexOf(`### ${label}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The question is placed in the last tab only, and the sign-off columns
    // follow the tabs, each note once.
    const question = "Does the keep unlock by level or by story progress?";
    expect(rendered.body.split(question)).toHaveLength(2);
    expect(rendered.body.indexOf(question)).toBeGreaterThan(
      rendered.body.indexOf("### Open questions"),
    );
    expect(rendered.body.split("Design signs off the loop and the zone map.")).toHaveLength(2);
  });

  it("reads a dashboard in a tab as it reads at the top level: its title, then its tiles, once", () => {
    const blocks = designBriefExample.map((block) => decodeCanvasBlock(block));
    for (const format of ["markdown", "html"] as const) {
      const rendered =
        format === "markdown"
          ? renderArtifactMarkdown(definition(blocks, "Design brief"))
          : renderArtifactHtml(definition(blocks, "Design brief"));
      if (rendered.kind !== "rendered") throw new Error("expected a rendered document");
      const metricsTab = rendered.body.indexOf("Metrics");
      const board = rendered.body.indexOf("Launch metrics");
      const loopTab = rendered.body.indexOf("Core loop");
      expect(metricsTab).toBeGreaterThanOrEqual(0);
      expect(board).toBeGreaterThan(metricsTab);
      expect(loopTab).toBeGreaterThan(board);
      expect(rendered.body.split("Daily players")).toHaveLength(2);
      expect(rendered.body.indexOf("Daily players")).toBeGreaterThan(board);
      expect(rendered.body.indexOf("Daily players")).toBeLessThan(loopTab);
    }
    const markdown = renderArtifactMarkdown(definition(blocks, "Design brief"));
    if (markdown.kind !== "rendered") throw new Error("expected a rendered document");
    expect(markdown.body).toContain("## Launch metrics");
  });
});

describe("exporting a styled diagram and a Gantt plan", () => {
  const blocks = designBriefExample.map((block) => decodeCanvasBlock(block));
  const loop = blocks.find((block) => block.blockId === "loop");
  if (loop?.kind !== "diagram") throw new Error("fixture");
  const layout = layoutCanvasDiagram(loop);

  it("places the HTML picture's nodes where the board's layout places them", () => {
    const html = renderArtifactHtml(definition([loop], "Core loop"));
    if (html.kind !== "rendered") throw new Error("expected a rendered document");
    for (const node of layout.nodes) {
      const drawn = new RegExp(
        `<(rect|polygon) data-node-id="${node.nodeId}"(?: x="(\\d+)" y="(\\d+)")?`,
      ).exec(html.body);
      expect(drawn?.[1]).toBe(node.shape === "decision" ? "polygon" : "rect");
      if (drawn?.[1] === "rect") {
        expect(Number(drawn[2])).toBe(Math.round(node.x));
        expect(Number(drawn[3])).toBe(Math.round(node.y));
      }
    }
    expect(html.body).toContain('stroke-dasharray="5 3"');
    expect(html.body).not.toMatch(/<script|<marker|\sid="/i);
  });

  it("names each shaped node by its role in the Markdown reading", () => {
    const markdown = renderArtifactMarkdown(definition([loop], "Core loop"));
    if (markdown.kind !== "rendered") throw new Error("expected a rendered document");
    expect(markdown.body).toContain("- Encounter? (decision)");
    expect(markdown.body).toContain("- Start run (terminator)");
    expect(markdown.body).toContain("Encounter? ⇢ Return to camp: flee");
    expect(markdown.body).not.toContain("<svg");
  });

  it("draws the sidecar picture's nodes at the board's layout, scaled into the page", () => {
    const svg = renderArtifactSidecarSvg({ title: "Core loop", blocks: [loop] });
    const drawn = [...svg.matchAll(/<rect data-node-id="([^"]+)" x="(\d+)" y="(\d+)"/g)].map(
      (match) => ({ nodeId: match[1], x: Number(match[2]), y: Number(match[3]) }),
    );
    const rects = layout.nodes.filter((node) => node.shape !== "decision");
    expect(drawn.map((node) => node.nodeId)).toEqual(rects.map((node) => node.nodeId));
    // Scaled, not rearranged: one shared column, and the same order down it.
    expect(new Set(drawn.map((node) => node.x)).size).toBe(1);
    const ys = drawn.map((node) => node.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    const [first, second] = drawn;
    const [firstBox, secondBox] = rects;
    const scale = ((second?.y ?? 0) - (first?.y ?? 0)) / ((secondBox?.y ?? 0) - (firstBox?.y ?? 1));
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThanOrEqual(1);
  });

  it("reads a plan's days from the Gantt layout", () => {
    const markdown = renderArtifactMarkdown(
      definition([decodeCanvasBlock(launchGanttExample)], "Launch"),
    );
    if (markdown.kind !== "rendered") throw new Error("expected a rendered document");
    expect(markdown.body).toContain("Build: Playable prototype (doing), 2026-06-08 → 2026-06-19");
    expect(markdown.body).toContain("Ship: Store listing (todo)\n");
  });
});
