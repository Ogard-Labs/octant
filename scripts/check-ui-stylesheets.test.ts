import { describe, expect, it } from "vitest";
import {
  collectPrimitiveClasses,
  collectScriptedTokens,
  compareWithBaseline,
  findComponentScaleFindings,
  findStylesheetFindings,
  findUndefinedTokenFindings,
  serializeBaseline,
} from "./check-ui-stylesheets";
import { findUiColorLiteralViolations } from "./check-ui-color-literals";

const CSS = "apps/web/src/styles/feature.css";

describe("UI stylesheet check", () => {
  it("keeps raw colors in mobile theme data and out of mobile feature views", () => {
    expect(
      findUiColorLiteralViolations({
        "apps/mobile/design-system/tokens.ts": 'export const ink = "#1b1b1b";',
        "apps/mobile/src/ui/StatusCard.tsx": 'const style = { color: "#1b1b1b" };',
      }),
    ).toEqual(["apps/mobile/src/ui/StatusCard.tsx:1 uses a hardcoded color: #1b1b1b"]);
  });

  it("flags a token that nothing defines, because the browser drops it without a word", () => {
    expect(
      findUndefinedTokenFindings({
        [CSS]: [".card {", "  background: var(--oct-surface-muted);", "}"].join("\n"),
        "apps/web/src/styles/tokens.css": ":root {\n  --octant-surface-muted: #2b2b2b;\n}",
      }),
    ).toEqual([
      {
        rule: "undefined-token",
        file: CSS,
        line: 2,
        detail: "background reads --oct-surface-muted, which nothing defines",
      },
    ]);
  });

  it("accepts a token another stylesheet, a script, the library, or a fallback stands behind", () => {
    const scripted = collectScriptedTokens({
      "apps/web/src/theme/apply.ts":
        'root.style.setProperty("--octant-ui-font-size", size);\nroot.style.setProperty(`--octant-palette-${name}`, value);',
    });
    expect(
      findUndefinedTokenFindings(
        {
          [CSS]: [
            ".row {",
            "  color: var(--oct-fg);",
            "  font-size: var(--octant-ui-font-size);",
            "  fill: var(--octant-palette-teal);",
            "  max-width: var(--available-width);",
            "  border-color: var(--not-defined-anywhere, currentColor);",
            "}",
          ].join("\n"),
          "apps/web/src/styles/tokens.css": ":root {\n  --oct-fg: var(--octant-ui-font-size);\n}",
        },
        scripted,
      ),
    ).toEqual([]);
  });

  it("does not let a template that spans a whole namespace excuse a misspelled token", () => {
    // The theme provider sets `--octant-${role}`. Read as a family, that prefix
    // accepted every `--octant-*` name, so a typo in the namespace this check
    // mostly guards passed without a finding.
    const scripted = collectScriptedTokens({
      "apps/web/src/theme/apply.ts": "root.style.setProperty(`--octant-${role}`, color);",
    });
    expect(scripted.prefixes).toEqual([]);
    expect(
      findUndefinedTokenFindings(
        { [CSS]: ".card {\n  border-color: var(--octant-border-strnog);\n}" },
        scripted,
      ).map((finding) => finding.detail),
    ).toEqual(["border-color reads --octant-border-strnog, which nothing defines"]);
  });

  it("never baselines an undefined token", () => {
    const findings = findUndefinedTokenFindings({
      [CSS]: ".card {\n  background: var(--oct-surface-muted);\n}",
    });
    expect(compareWithBaseline(findings, {})).toEqual([
      { kind: "exceeded", rule: "undefined-token", file: CSS, recorded: 0, current: 1 },
    ]);
    expect(serializeBaseline(findings)).toBe("{}\n");
  });

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

  it("flags declarations with off-scale spacing literals", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [".a { padding: 6px 10px; }", ".b { gap: 14px; }"].join("\n"),
      }).map((finding) => `${finding.rule} ${finding.line} ${finding.detail}`),
    ).toEqual([
      "spacing-scale 1 padding 6px 10px is off the 4px spacing scale",
      "spacing-scale 2 gap 14px is off the 4px spacing scale",
    ]);
  });

  it("accepts on-scale spacing, small nudges, automatic margins, and spacing tokens", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { gap: 8px; }",
          ".b { padding: 0 12px 2px; }",
          ".c { margin: 0 auto; }",
          ".d { padding: var(--oct-space-2); }",
          ".e { padding: 1px 0; }",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("does not flag off-scale spacing inside a fixed-scheme exception block", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          "/* ui-style-exception: fixed-scheme */",
          ".scheme-preview {",
          "  gap: 6px;",
          "}",
        ].join("\n"),
      }),
    ).toEqual([]);
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

  it("flags a raw duration and an annotation however they are cased or spaced", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { TRANSITION-DELAY: 120ms; }",
          ".b { margin: 0 ! IMPORTANT; }",
          ".c { --Transition-Delay: 120ms; }",
        ].join("\n"),
      }).map((finding) => `${finding.rule} ${String(finding.line)}`),
    ).toEqual(["motion-literal 1", "important 2"]);
  });

  it("reads the annotation only where CSS puts it, not inside a value", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          '.a::after { content: "Use !important"; }',
          ".b { --status: !important-foo; }",
          ".c { font-weight: 700 !important; }",
        ].join("\n"),
      }).map((finding) => `${finding.rule} ${String(finding.line)}`),
    ).toEqual(["important 3", "heavy-weight 3"]);
  });

  it("flags a selector that only spells an accessibility feature out", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".prefers-reduced-motion { margin: 0 !important; }",
          "@media (prefers-contrast: more) { .b { outline-width: 2px !important; } }",
        ].join("\n"),
      }).map((finding) => `${finding.rule} ${String(finding.line)}`),
    ).toEqual(["important 1"]);
  });

  it("flags a raw colour written as a modern colour function", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { color: oklch(60% 0.2 30); }",
          ".b { background: color-mix(in oklab, #fff, #000); }",
          ".c { color: var(--octant-text); }",
        ].join("\n"),
      }).map((finding) => `${finding.rule} ${String(finding.line)}`),
    ).toEqual(["color-literal 1", "color-literal 2"]);
  });

  it("flags a raw duration written as a delay", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { transition-delay: 120ms; }",
          ".b { animation-delay: 120ms; }",
          ".c { transition-delay: var(--oct-motion-fast); }",
        ].join("\n"),
      }).map((finding) => `${finding.rule} ${String(finding.line)}`),
    ).toEqual(["motion-literal 1", "motion-literal 2"]);
  });

  it("flags a numeric weight above 600 that is not a hundred step", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { font-weight: 650; }",
          ".b { font-weight: 700 !important; }",
          ".c { font-weight: 600; }",
        ].join("\n"),
      }).map((finding) => `${finding.rule} ${String(finding.line)}`),
    ).toEqual(["heavy-weight 1", "important 2", "heavy-weight 2"]);
  });

  it("allows emphasis at 600 and keeps bold for the title roles", () => {
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { font-weight: var(--oct-weight-medium); }",
          ".b { font-weight: 600; }",
          ".c { font-weight: var(--oct-weight-strong); }",
          ".d { font-weight: bold; }",
          ".e { font-weight: 700; }",
        ].join("\n"),
      }).map((finding) => `${finding.rule} ${String(finding.line)}`),
    ).toEqual(["heavy-weight 4", "heavy-weight 5"]);
  });

  it("lets only the title roles in surface.css use the title weight", () => {
    const rule = ".oct-title { font-weight: var(--oct-weight-title); }";
    expect(
      findStylesheetFindings({ "apps/web/src/styles/surface.css": rule }).map(
        (finding) => finding.rule,
      ),
    ).toEqual([]);
    expect(
      findStylesheetFindings({ [CSS]: rule }).map(
        (finding) => `${finding.rule} ${String(finding.line)}`,
      ),
    ).toEqual(["heavy-weight 1"]);
  });

  it("lets a feature paint a button it asked for in the bare variant", () => {
    const primitives = collectPrimitiveClasses({
      "Tile.tsx": '<OctantButton className="tile" variant="bare">x</OctantButton>',
      "Card.tsx": "<OctantButton className=\"card\" variant={'bare'}>x</OctantButton>",
      "Row.tsx": '<OctantButton className="row" variant="ghost">x</OctantButton>',
    });
    expect(primitives.has("tile")).toBe(false);
    expect(primitives.has("card")).toBe(false);
    expect(primitives.get("row")).toBe("OctantButton");
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

  it("does not credit a later element's class to a primitive whose braced prop holds a greater-than", () => {
    const primitives = collectPrimitiveClasses({
      "apps/web/src/palette/CommandPalette.tsx": [
        "<OctantInput",
        "  aria-expanded={results.length > 0}",
        "/>",
        '<p className="command-palette__scope" role="note">Scope</p>',
      ].join("\n"),
      "apps/web/src/shell/ThreadSearchOverlay.tsx": [
        "<OctantInput",
        "  onChange={(event) => setQuery(event.target.value)}",
        "  disabled={hits.length >= 10 || count > limit}",
        "  value={items as Array<string>}",
        '  className="thread-search__field"',
        "/>",
        '<p className="thread-search__listing" role="note">Listing</p>',
      ].join("\n"),
    });
    // The first input has no class of its own: the paragraph after it must not
    // be read as part of its tag.
    expect([...primitives.keys()]).toEqual(["thread-search__field"]);
  });

  it("collects a class past an arrow function, from every literal, and when unstyled is off", () => {
    const primitives = collectPrimitiveClasses({
      "apps/web/src/code/A.tsx":
        '<OctantButton onClick={() => save()} className="feature-action" />',
      "apps/web/src/code/B.tsx":
        '<OctantButton className={cn("feature-first", open && "feature-second")} />',
      "apps/web/src/code/C.tsx": '<OctantButton unstyled={false} className="feature-third" />',
      "apps/web/src/code/D.tsx": '<OctantButton unstyled className="feature-owned" />',
    });
    expect([...primitives.keys()].sort()).toEqual([
      "feature-action",
      "feature-first",
      "feature-second",
      "feature-third",
    ]);
  });

  it("flags a repaint written in a nested block", () => {
    const primitives = collectPrimitiveClasses({
      "apps/web/src/code/A.tsx": '<OctantButton className="feature-action" />',
    });
    expect(
      findStylesheetFindings(
        {
          [CSS]: [
            ".feature-action {",
            "  &:hover { background-color: var(--oct-fg-soft); }",
            "  @media (min-width: 600px) { & { color: var(--oct-fg); } }",
            "}",
          ].join("\n"),
        },
        primitives,
      ).map((finding) => `${finding.rule} ${String(finding.line)}`),
    ).toEqual(["control-repaint 2", "control-repaint 3"]);
  });

  it("flags a repaint written on a border side or in another case", () => {
    const primitives = collectPrimitiveClasses({
      "apps/web/src/code/A.tsx": '<OctantButton className="feature-action" />',
    });
    expect(
      findStylesheetFindings(
        {
          [CSS]: [
            ".feature-action { border-top: 1px solid var(--oct-border); }",
            ".feature-action { border-inline-color: var(--oct-border); }",
            ".feature-action { BACKGROUND: var(--oct-fg-soft); }",
            ".feature-action { padding: 8px; }",
          ].join("\n"),
        },
        primitives,
      ).map((finding) => `${finding.rule} ${String(finding.line)}`),
    ).toEqual(["control-repaint 1", "control-repaint 2", "control-repaint 3"]);
  });

  it("does not read an arrow function's => as the end of a primitive's attributes", () => {
    const primitives = collectPrimitiveClasses({
      "apps/web/src/chat/Support.tsx": [
        '<OctantButton className="support__copy" onClick={() => copy(id)} type="button">',
        "  Copy support ID",
        "</OctantButton>",
        '<ul aria-label="Sources" className="chat-transcript__citations">',
      ].join("\n"),
    });
    expect([...primitives.keys()]).toEqual(["support__copy"]);
  });

  it("does not collect classes from a JSX fragment passed as a prop", () => {
    const primitives = collectPrimitiveClasses({
      "apps/web/src/code/Fragment.tsx": [
        '<OctantButton className="fragment__trigger" content={<><span className="fragment__inner" /></>}>',
        "  Open",
        "</OctantButton>",
        '<ul className="fragment__list" />',
      ].join("\n"),
    });
    expect([...primitives.keys()]).toEqual(["fragment__trigger"]);
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

  it("ratchets off-scale spacing when its count rises or falls", () => {
    const findings = findStylesheetFindings({ [CSS]: ".a { gap: 6px; }" });
    expect(compareWithBaseline(findings, { "spacing-scale": { [CSS]: 0 } })).toEqual([
      { kind: "exceeded", rule: "spacing-scale", file: CSS, recorded: 0, current: 1 },
    ]);
    expect(compareWithBaseline(findings, { "spacing-scale": { [CSS]: 2 } })).toEqual([
      { kind: "stale", rule: "spacing-scale", file: CSS, recorded: 2, current: 1 },
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

  it("flags a corner that is not a radius token, and keeps the allowed shapes", () => {
    const findings = findStylesheetFindings({
      [CSS]: [
        ".a { border-radius: 8px; }",
        ".b { border-radius: 0.5rem; }",
        ".c { border-top-left-radius: 9999px; }",
        ".d { border-radius: 100%; }",
        ".e { border-radius: 6px 6px 0 0; }",
      ].join("\n"),
    });
    expect(findings.map((finding) => [finding.rule, finding.line])).toEqual([
      ["radius-token", 1],
      ["radius-token", 2],
      ["radius-token", 3],
      ["radius-token", 4],
      ["radius-token", 5],
    ]);
    expect(
      findStylesheetFindings({
        [CSS]: [
          ".a { border-radius: var(--oct-radius-sm); }",
          ".b { border-radius: var(--oct-radius-md) var(--oct-radius-md) 0 0; }",
          ".c { border-radius: max(2px, calc(var(--oct-radius-sm) - 2px)); }",
          ".d { border-radius: 50%; }",
          ".e { border-radius: 0; }",
          ".f { border-radius: 2px 2px 0 0; }",
          ".g { border-radius: inherit; }",
          ".h { border-end-end-radius: var(--oct-radius-pill); }",
          ".i { --note-radius: 8px; }",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("flags a literal corner in a class or an inline style but not a named one", () => {
    const findings = findComponentScaleFindings({
      "apps/web/src/feature/Card.tsx": [
        'const a = "rounded-[10px] p-2";',
        'const b = "rounded-t-[var(--oct-radius-md)] rounded-md rounded-full";',
        "const c = { borderRadius: 10 };",
        'const d = { borderRadius: "var(--oct-radius-sm)" };',
        "const e = { borderRadius: `var(--oct-radius-${name})` };",
      ].join("\n"),
    });
    expect(findings.map((finding) => [finding.rule, finding.line])).toEqual([
      ["radius-token", 1],
      ["radius-token", 3],
    ]);
  });

  it("refuses a corner that only mentions a radius token among other parts", () => {
    const refused = [
      "var(--oct-radius-sm, 8px)",
      "8px var(--oct-radius-sm)",
      "calc(var(--oct-radius-sm) + 20px)",
      "calc(8px - var(--oct-radius-sm))",
      "max(8px, calc(var(--oct-radius-sm) - 2px))",
    ];
    const findings = findStylesheetFindings({
      [CSS]: refused.map((value, index) => `.a${index} { border-radius: ${value}; }`).join("\n"),
    });
    expect(findings.map((finding) => finding.line)).toEqual([1, 2, 3, 4, 5]);
    expect(
      findStylesheetFindings({
        [CSS]: ".a { border-radius: calc(var(--oct-radius-md) - 8px) var(--oct-radius-sm) / 0; }",
      }),
    ).toEqual([]);
  });

  it("refuses an arbitrary rounded class or inline corner that mixes in a literal", () => {
    const findings = findComponentScaleFindings({
      "apps/web/src/feature/Card.tsx": [
        'const a = "rounded-[8px_var(--oct-radius-sm)]";',
        'const b = "rounded-[var(--oct-radius-sm,8px)]";',
        'const c = "rounded-[calc(var(--oct-radius-sm)+20px)]";',
        'const d = { borderRadius: "8px var(--oct-radius-sm)" };',
        'const e = { borderRadius: "var(--oct-radius-sm, 8px)" };',
        'const f = { "borderRadius": 12 };',
        'const g = "rounded-[var(--oct-radius-sm)] rounded-[--oct-radius-md] rounded-(--oct-radius-md)";',
        'const h = { borderRadius: "var(--oct-radius-sm)" };',
      ].join("\n"),
    });
    expect(findings.map((finding) => finding.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reads every longhand and logical corner in an inline style", () => {
    const findings = findComponentScaleFindings({
      "apps/web/src/feature/Card.tsx": [
        "const a = { borderTopLeftRadius: 10 };",
        'const b = { borderTopRightRadius: "9px" };',
        "const c = { borderBottomLeftRadius: 10, borderBottomRightRadius: 3 };",
        "const d = { borderStartStartRadius: 7, borderEndEndRadius: 7 };",
        'const e = { "border-start-end-radius": "7px" };',
        "const f = { borderStartEndRadius: 0, borderEndStartRadius: 4 };",
      ].join("\n"),
    });
    expect(findings.map((finding) => finding.line)).toEqual([1, 2, 3, 4, 4, 5]);
  });

  it("flags a literal off-token corner inside a conditional, a template or a style assignment", () => {
    const findings = findComponentScaleFindings({
      "apps/web/src/feature/Card.tsx": [
        'const a = { borderRadius: open ? 10 : "var(--oct-radius-sm)" };',
        "const b = { borderRadius: `8px ${inner}` };",
        "const c = { borderRadius: `var(--oct-radius-${name})` };",
        "const d = { borderRadius: size > 10 ? 4 : 0, color: red };",
        "node.style.borderRadius = round ? '50%' : '9px';",
        'node.style.setProperty("border-top-left-radius", "11px");',
        "const e = { borderRadius: value };",
        "const f = style.borderTopLeftRadius;",
      ].join("\n"),
    });
    expect(findings.map((finding) => finding.line)).toEqual([1, 2, 5, 6]);
  });

  it("reads only the literals that can become a corner, not comparison operands", () => {
    const findings = findComponentScaleFindings({
      "apps/web/src/feature/Card.tsx": [
        'const a = { borderRadius: kind === "pill" ? "50%" : 0 };',
        'const b = { borderRadius: kind !== "8px" ? 0 : "var(--oct-radius-sm)" };',
        'const c = { borderRadius: ["a", "b"].includes("8px") ? 0 : 0 };',
        'const d = { borderRadius: "8px" === kind ? 0 : 0 };',
        'const e = { borderRadius: kind === "pill" ? "8px" : 0 };',
        'const f = { borderRadius: kind === "pill" || "9px" };',
      ].join("\n"),
    });
    expect(findings.map((finding) => finding.line)).toEqual([5, 6]);
  });

  it("reads recipes in subfolders of the shared recipe folders", () => {
    const findings = findComponentScaleFindings({
      "apps/web/src/ui/base/menu/OctantMenuItem.tsx": 'x = "h-[30px]";',
      "apps/web/src/ui/shadcn/field/input.tsx": 'x = "size-[1.15rem]";',
    });
    expect(findings.map((finding) => finding.rule)).toEqual([
      "control-height-scale",
      "control-height-scale",
    ]);
  });

  it("flags a recipe height off the 20, 24, 28, 32 scale and only in the shared recipes", () => {
    const recipe = [
      'const ok = "h-[round(2.154rem,2px)] size-[round(up,1.538rem,2px)] h-[28px] h-(--oct-space-5)";',
      'const off = "h-[round(1.25rem,2px)] size-[1.15rem] h-[30px] min-h-[4rem]";',
    ].join("\n");
    const findings = findComponentScaleFindings({
      "apps/web/src/ui/base/OctantThing.tsx": recipe,
      "apps/web/src/feature/Panel.tsx": recipe,
    });
    expect(findings.map((finding) => [finding.rule, finding.file, finding.line])).toEqual([
      ["control-height-scale", "apps/web/src/ui/base/OctantThing.tsx", 2],
      ["control-height-scale", "apps/web/src/ui/base/OctantThing.tsx", 2],
      ["control-height-scale", "apps/web/src/ui/base/OctantThing.tsx", 2],
    ]);
  });

  it("judges a rounded recipe height by its rounded result at the 13px root", () => {
    const findings = findComponentScaleFindings({
      "apps/web/src/ui/base/OctantThing.tsx": [
        'const ok = "h-[round(1.5rem,2px)] h-[round(nearest,1.85rem,4px)] h-[round(up,1.4rem,2px)] h-[round(to-zero,2.5rem,2px)]";',
        'const off = "h-[round(down,1.538rem,2px)] h-[round(to-zero,1.538rem,2px)] h-[round(up,1.6rem,2px)]";',
        'const open = "h-[round(var(--x),2px)] h-[round(1.5rem,var(--step))]";',
      ].join("\n"),
    });
    expect(findings.map((finding) => finding.line)).toEqual([2, 2, 2]);
  });

  it("ratchets radius and control-height findings and records them in the baseline", () => {
    const findings = [
      ...findStylesheetFindings({ [CSS]: ".a { border-radius: 8px; }" }),
      ...findComponentScaleFindings({ "apps/web/src/ui/base/OctantThing.tsx": 'x = "h-[30px]";' }),
    ];
    expect(JSON.parse(serializeBaseline(findings))).toEqual({
      "radius-token": { [CSS]: 1 },
      "control-height-scale": { "apps/web/src/ui/base/OctantThing.tsx": 1 },
    });
    expect(compareWithBaseline(findings, {})).toHaveLength(2);
  });
});
