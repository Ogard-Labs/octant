import { readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Search } from "lucide-react";
import { describe, expect, it } from "vitest";
import { ICON_STROKE_WIDTH, IconDefaults, MARK_TICK_STROKE_WIDTH } from "./IconDefaults";

const sourceRoot = resolve(process.cwd(), "src");

/**
 * The steps an interface icon may be drawn at. Neighbouring steps are far
 * enough apart to read as a deliberate difference; anything between them reads
 * as an accident, because at one pixel apart nobody can tell which was meant.
 */
const ICON_SCALE = new Set([12, 14, 16, 20]);

/**
 * Components whose `size` is not an icon's. An avatar's diameter answers to the
 * row it sits in, not to the icon scale.
 */
const SIZED_BY_SOMETHING_ELSE = new Set(["UserAvatar", "ProviderMark", "ProviderGlyph"]);

/**
 * What a call site may name as a stroke: the one stroke, or the named heavier
 * stroke for a tick inside a small filled mark. Names are compared as written,
 * so a number that happens to equal the constant is still refused.
 */
const ALLOWED_STROKES: ReadonlySet<string> = new Set([
  String(ICON_STROKE_WIDTH),
  "MARK_TICK_STROKE_WIDTH",
]);

/**
 * The files that may draw a stroke other than the icon stroke, and why. Each is
 * a drawing, not an interface icon: the stroke is data or a diagram's own
 * weight, and the app's icons stay at the one stroke without it.
 */
const STROKE_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ["ui/IconDefaults.tsx", "the provider that sets the one stroke"],
  ["agents/AgentRunDependencyGraph.tsx", "diagram edges, a hairline weight of their own"],
  ["agents/AgentsCenterGraph.tsx", "diagram edges, a hairline weight of their own"],
  ["browser/BrowserMarkupStage.tsx", "marks a person draws on a page; the width is their choice"],
  ["shell/ShellState.tsx", "a glyph cut into a dither mask, where it must be heavy to survive"],
]);

describe("icon scale contract", () => {
  it("asks for every interface icon at one of the scale's steps", () => {
    const offenders: Array<string> = [];
    for (const file of collectSourceFiles(sourceRoot)) {
      const relative = file.slice(sourceRoot.length + 1);
      const source = readFileSync(file, "utf8");
      for (const { element, size } of sizedElements(source)) {
        if (SIZED_BY_SOMETHING_ELSE.has(element) || ICON_SCALE.has(size)) continue;
        offenders.push(`${relative}: <${element} size={${String(size)}}`);
      }
      for (const size of objectSizes(source)) {
        if (!ICON_SCALE.has(size)) offenders.push(`${relative}: { size: ${String(size)} }`);
      }
    }

    // Before this contract the app asked for icons at twelve sizes between 10
    // and 24, with 13, 14 and 15 accounting for 215 of them — three sizes
    // inside a 2px band, often inside one component, where no two of them
    // could be told apart on purpose.
    //
    // This governs what the call site asks for, which decides 309 of the 326
    // icons. The other 17 carry a `className="icon"`, and that rule sets a
    // width in CSS, which beats an SVG's own size attribute — so those render
    // at 19px whatever they ask for. That is a separate defect: `.icon`
    // belongs to a sprite system this app never adopted, and resolving it is
    // a design-system decision rather than a sweep.
    expect(offenders).toEqual([]);
  });

  it("draws every interface icon at the one stroke", () => {
    const offenders: Array<string> = [];
    for (const file of collectSourceFiles(sourceRoot)) {
      const relative = file.slice(sourceRoot.length + 1);
      if (STROKE_EXCEPTIONS.has(relative)) continue;
      for (const width of strokeWidths(readFileSync(file, "utf8"))) {
        if (!ALLOWED_STROKES.has(width)) offenders.push(`${relative}: strokeWidth ${width}`);
      }
    }

    // Icons took their own stroke at each call site: ten values between 1.25
    // and 3, and nothing noticed. The stroke now comes from `IconDefaults`, so
    // a call site that names one is either restating it or departing from it.
    expect(offenders).toEqual([]);
  });

  it("gives an icon the one stroke when it asks for none", () => {
    const markup = renderToStaticMarkup(
      createElement(IconDefaults, null, createElement(Search, { size: 14 })),
    );

    expect(markup).toContain(`stroke-width="${String(ICON_STROKE_WIDTH)}"`);
  });

  it("sees a stroke or size given in a props object and not only in JSX", () => {
    const source = [
      'import { Slash } from "lucide-react";',
      "createElement(Slash, { 'aria-hidden': true, size: 13, strokeWidth: 1.8 });",
      "const spread = <Slash {...{ size: 24 }} />;",
      "const tick = <Check strokeWidth={MARK_TICK_STROKE_WIDTH} />;",
    ].join("\n");

    expect(strokeWidths(source)).toEqual(["MARK_TICK_STROKE_WIDTH", "1.8"]);
    expect(objectSizes(source)).toEqual([13, 24]);
    expect(strokeWidths(source).filter((width) => !ALLOWED_STROKES.has(width))).toEqual(["1.8"]);
    expect(strokeWidths("const edge = { strokeWidth: 1.25 };")).toEqual([]);
  });

  it("sees the icons the composer menus build without JSX", () => {
    for (const file of ["composer/useComposerAtMenu.ts", "composer/useComposerSlashCommands.ts"]) {
      expect(objectSizes(readFileSync(resolve(sourceRoot, file), "utf8"))).toEqual([12]);
    }
  });

  it("draws a tick inside a small filled mark heavier than the one stroke", () => {
    // 1.5 in the icon's own 24-unit grid is 0.75px at 12px: too faint for a
    // tick on an accent fill, which has to clear the 3:1 bar for graphics.
    expect(MARK_TICK_STROKE_WIDTH).toBeGreaterThan(ICON_STROKE_WIDTH);
    expect((MARK_TICK_STROKE_WIDTH * 12) / 24).toBeGreaterThanOrEqual(1.25);
  });

  it("sees a stroke named as a literal or an expression", () => {
    expect(
      strokeWidths('<A strokeWidth={1.8} />\n<B strokeWidth="1.5" />\n<C strokeWidth={w.x} />'),
    ).toEqual(["1.8", "1.5", "w.x"]);
  });

  it("sees a size asked for through a namespaced component", () => {
    const found = sizedElements(
      "<Icons.ChevronDown size={13} />\n<Check size={14} />\n<Ui.Icons.Dot size={12} />",
    );

    expect(found).toEqual([
      { element: "Icons.ChevronDown", size: 13 },
      { element: "Check", size: 14 },
      { element: "Ui.Icons.Dot", size: 12 },
    ]);
    expect(found.filter((one) => !ICON_SCALE.has(one.size))).toEqual([
      { element: "Icons.ChevronDown", size: 13 },
    ]);
  });
});

/**
 * Every stroke an icon is given, as written: a JSX `strokeWidth=` attribute, or
 * a `strokeWidth:` key in a props object. The object form is only read in a file
 * that imports from the icon library, so a chart's or a drawing's own
 * `strokeWidth` data key is not mistaken for an icon's.
 */
function strokeWidths(source: string): ReadonlyArray<string> {
  const found = [...source.matchAll(/\bstrokeWidth=(?:\{([^}]*)\}|"([^"]*)")/g)].map((match) =>
    (match[1] ?? match[2] ?? "").trim(),
  );
  if (importsIcons(source)) {
    for (const match of source.matchAll(/\bstrokeWidth:\s*([^,}\n]+)/g)) {
      found.push((match[1] ?? "").trim());
    }
  }
  return found;
}

function importsIcons(source: string): boolean {
  return /from\s+"lucide-react"/.test(source);
}

/**
 * Sizes given in a props object rather than a JSX attribute: the object handed
 * to `createElement(Icon, { size: 13 })`, or spread into an element with
 * `{...{ size: 13 }}`. Only read in a file that imports from the icon library.
 */
function objectSizes(source: string): ReadonlyArray<number> {
  if (!importsIcons(source)) return [];
  const found: Array<number> = [];
  for (const match of source.matchAll(/(?:createElement\([^,()]+,\s*|\.\.\.)\{([^{}]*)\}/g)) {
    for (const size of (match[1] ?? "").matchAll(/\bsize:\s*(\d+)\b/g)) {
      found.push(Number(size[1]));
    }
  }
  return found;
}

/** Every `size={N}` in the source, paired with the JSX element carrying it. */
function sizedElements(source: string): ReadonlyArray<{ element: string; size: number }> {
  const found: Array<{ element: string; size: number }> = [];
  // A component can be reached through a namespace (`<Icons.ChevronDown />`),
  // and a matcher that stopped at the first dot would skip those silently —
  // the contract would keep passing while the drift it exists to catch walked
  // straight through it.
  for (const match of source.matchAll(
    /<([A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*)\b[^<>]*?\bsize=\{([^{}]*)\}/g,
  )) {
    const [, element, expression] = match;
    if (element === undefined || expression === undefined) continue;
    // A literal, or a choice between literals (`wide ? 24 : 16`); a computed
    // size has no number to read, and a prop like `size={0 ? "a" : "b"}` on a
    // button is not an icon's.
    const choice = expression.includes("?");
    const numbers = expression.includes("*")
      ? []
      : (expression.match(/(?<![\w.])\d+(?![\w.])/g) ?? []);
    for (const number of numbers) {
      if (!choice && !/^\d+$/.test(expression.trim())) continue;
      if (choice && Number(number) < 10) continue;
      found.push({ element, size: Number(number) });
    }
  }
  return found;
}

function collectSourceFiles(root: string): ReadonlyArray<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
      continue;
    }
    if (entry.name.includes(".test.")) continue;
    if (extname(entry.name) !== ".tsx" && extname(entry.name) !== ".ts") continue;
    files.push(path);
  }
  return files;
}
