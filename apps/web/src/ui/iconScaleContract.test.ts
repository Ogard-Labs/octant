import { readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Search } from "lucide-react";
import { describe, expect, it } from "vitest";
import { ICON_STROKE_WIDTH, IconDefaults } from "./IconDefaults";

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
      for (const { element, size } of sizedElements(readFileSync(file, "utf8"))) {
        if (SIZED_BY_SOMETHING_ELSE.has(element) || ICON_SCALE.has(size)) continue;
        offenders.push(`${relative}: <${element} size={${String(size)}}`);
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
        if (width !== String(ICON_STROKE_WIDTH))
          offenders.push(`${relative}: strokeWidth ${width}`);
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

/** Every `strokeWidth` a JSX element names, as written. */
function strokeWidths(source: string): ReadonlyArray<string> {
  return [...source.matchAll(/\bstrokeWidth=(?:\{([^}]*)\}|"([^"]*)")/g)].map((match) =>
    (match[1] ?? match[2] ?? "").trim(),
  );
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
    if (extname(entry.name) !== ".tsx") continue;
    files.push(path);
  }
  return files;
}
