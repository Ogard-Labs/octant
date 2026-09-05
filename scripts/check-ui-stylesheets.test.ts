import { describe, expect, it } from "vitest";
import {
  collectPrimitiveClasses,
  compareWithBaseline,
  findStylesheetFindings,
  serializeBaseline,
} from "./check-ui-stylesheets";

const CSS = "apps/web/src/styles/feature.css";

describe("UI stylesheet check", () => {
  it("flags a raw colour in a rule but not in a token definition", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ":root {",
          "  --octant-border: #303030;",
          "  --octant-shadow-sm: 0 1px 2px rgb(0 0 0 / 24%);",
          "}",
          ".row {",
          "  border-color: var(--octant-border);",
          "  color: #f0f0f0;",
          "}",
        ].join("\n"),
      }),
    ).toEqual([
      { rule: "color-literal", file: CSS, line: 7, detail: "color uses a raw colour: #f0f0f0" },
    ]);
  });

  it("lets a block that depicts a fixed scheme keep its literal colours", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          "/* ui-style-exception: fixed-scheme */",
          ".scheme-preview--light {",
          "  background: #fafafb;",
          "}",
          ".scheme-preview--label {",
          "  color: #1b1b1b;",
          "}",
        ].join("\n"),
      }),
    ).toEqual([
      { rule: "color-literal", file: CSS, line: 6, detail: "color uses a raw colour: #1b1b1b" },
    ]);
  });

  it("accepts only type-scale tokens and on-scale steps for font-size", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { font-size: var(--oct-text-xs); }",
          ".g { font-size: var(--oct-text-2xl); }",
          ".b { font-size: calc(11 * var(--oct-text-step)); }",
          ".c { font-size: calc(10 * var(--oct-text-step)); }",
          ".d { font-size: 11.5px; }",
          ".e { font-size: 0.875rem; }",
          ".f { font-size: inherit; }",
        ].join("\n"),
      }).map((finding) => `${String(finding.line)} ${finding.detail}`),
    ).toEqual([
      "4 font-size calc(10 * var(--oct-text-step)) is not a type-scale token",
      "5 font-size 11.5px is not a type-scale token",
      "6 font-size 0.875rem is not a type-scale token",
    ]);
  });

  it("flags raw durations but not motion tokens or the reduced-motion idiom", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { transition: opacity var(--oct-motion-fast) ease; }",
          ".b { transition: opacity 120ms ease; }",
          ".c { animation: spin 1.4s linear infinite; }",
          "@media (prefers-reduced-motion: reduce) {",
          "  .d { transition-duration: 0.01ms !important; animation-duration: 0s; }",
          "}",
        ].join("\n"),
      }).map((finding) => `${finding.rule} ${String(finding.line)} ${finding.detail}`),
    ).toEqual([
      "motion-literal 2 transition uses a raw duration: 120ms",
      "motion-literal 3 animation uses a raw duration: 1.4s",
    ]);
  });

  it("flags !important outside accessibility fallbacks", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { margin: 0 !important; }",
          "@media (forced-colors: active) { .b { border: 1px solid CanvasText !important; } }",
        ].join("\n"),
      }),
    ).toEqual([
      {
        rule: "important",
        file: CSS,
        line: 1,
        detail: "margin uses !important outside an accessibility fallback",
      },
    ]);
  });

  it("flags bold weights so only page titles and content emphasis stay heavy", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { font-weight: var(--oct-weight-display); }",
          ".b { font-weight: 600; }",
          ".c { font-weight: var(--oct-weight-strong); }",
        ].join("\n"),
      }).map((finding) => `${finding.rule} ${String(finding.line)}`),
    ).toEqual(["heavy-weight 2", "heavy-weight 3"]);
  });

  it("flags feature rules that repaint a shared control instead of placing it", () => {
    const primitives = collectPrimitiveClasses({
      "apps/web/src/code/CodeHome.tsx":
        '<OctantButton className="code-home__card window-no-drag" variant="ghost" />',
      "apps/web/src/code/CodeRail.tsx": '<OctantButton className={cn("code-rail__item", extra)} />',
    });
    expect(
      findStylesheetFindings(
        {
          [CSS]: [
            ".code-home__card { min-height: 0; padding: 12px; border: 1px solid var(--oct-border); }",
            ".code-home__card:hover { background: var(--oct-fg-soft); }",
            ".code-rail__item { color: var(--oct-muted); }",
            ".code-home__card .code-home__title { color: var(--oct-fg); }",
          ].join("\n"),
        },
        primitives,
      ).map((finding) => `${finding.rule} ${String(finding.line)} ${finding.detail}`),
    ).toEqual([
      "control-repaint 1 border repaints OctantButton through .code-home__card",
      "control-repaint 2 background repaints OctantButton through .code-home__card",
      "control-repaint 3 color repaints OctantButton through .code-rail__item",
    ]);
  });

  it("fails closed on any colour literal and ratchets the other rules against the baseline", () => {
    const findings = findStylesheetFindings({
      [CSS]: [".a { color: #fff; font-size: 11.5px; }", ".b { font-size: 12.5px; }"].join("\n"),
      "apps/web/src/styles/other.css": ".c { transition: opacity 120ms ease; }",
    });
    expect(
      compareWithBaseline(findings, {
        "font-size-scale": { [CSS]: 1 },
        "motion-literal": { "apps/web/src/styles/other.css": 2 },
      }),
    ).toEqual([
      { kind: "exceeded", rule: "color-literal", file: CSS, recorded: 0, current: 1 },
      { kind: "exceeded", rule: "font-size-scale", file: CSS, recorded: 1, current: 2 },
      {
        kind: "stale",
        rule: "motion-literal",
        file: "apps/web/src/styles/other.css",
        recorded: 2,
        current: 1,
      },
    ]);
  });

  it("records only the ratcheted rules in the baseline", () => {
    const findings = findStylesheetFindings({
      [CSS]: ".a { color: #fff; font-size: 11.5px; margin: 0 !important; }",
    });
    expect(JSON.parse(serializeBaseline(findings))).toEqual({
      "font-size-scale": { [CSS]: 1 },
      important: { [CSS]: 1 },
    });
  });
});
