import { readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

/**
 * The steps an interface icon may be drawn at. Neighbouring steps are far
 * enough apart to read as a deliberate difference; anything between them reads
 * as an accident, because at one pixel apart nobody can tell which was meant.
 */
const ICON_SCALE = new Set([12, 14, 16, 20, 24]);

/**
 * Components whose `size` is not an icon's. An avatar's diameter answers to the
 * row it sits in, not to the icon scale.
 */
const SIZED_BY_SOMETHING_ELSE = new Set(["UserAvatar", "ProviderMark"]);

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
});

/** Every `size={N}` in the source, paired with the JSX element carrying it. */
function sizedElements(source: string): ReadonlyArray<{ element: string; size: number }> {
  const found: Array<{ element: string; size: number }> = [];
  for (const match of source.matchAll(/<([A-Z][A-Za-z0-9]*)\b[^<>]*?\bsize=\{(\d+)\}/g)) {
    const [, element, size] = match;
    if (element === undefined || size === undefined) continue;
    found.push({ element, size: Number(size) });
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
