import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = join(process.cwd(), "src");
const leftoverRadius = /border-radius:\s*(?:[5-9]|1[0-4])px\b/;
const leftoverButtonPaint = /\.btn-(?:primary|secondary|ghost|danger|icon|group)\b/;
const leftoverButtonClass = /\bbtn-(?:icon|group)\b/;

function sourceFiles(directory: string, suffix: string): ReadonlyArray<string> {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      found.push(...sourceFiles(path, suffix));
      continue;
    }
    if (entry.endsWith(suffix)) found.push(path);
  }
  return found;
}

function cssFiles(directory: string): ReadonlyArray<string> {
  return sourceFiles(directory, ".css");
}

describe("the public-block visual language", () => {
  it("does not leave old 5–14px radii on product chrome", () => {
    const leftovers = cssFiles(webRoot)
      .map((path) => ({
        path: relative(webRoot, path),
        css: readFileSync(path, "utf8"),
      }))
      .filter((file) => leftoverRadius.test(file.css))
      .map((file) => file.path);

    expect(leftovers).toEqual([]);
  });

  it("does not keep leftover .btn colour recipes beside the adapter", () => {
    const leftovers = cssFiles(webRoot)
      .map((path) => ({
        path: relative(webRoot, path),
        css: readFileSync(path, "utf8"),
      }))
      .filter((file) => leftoverButtonPaint.test(file.css))
      .map((file) => file.path);

    expect(leftovers).toEqual([]);
  });

  it("does not leave leftover OctantNativeSelect on product surfaces", () => {
    const leftovers = ["tsx", "ts"]
      .flatMap((suffix) => sourceFiles(webRoot, `.${suffix}`))
      .filter((path) => !path.includes(".test."))
      .map((path) => ({
        path: relative(webRoot, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter((file) => file.source.includes("OctantNativeSelect"))
      .map((file) => file.path);

    expect(leftovers).toEqual([]);
  });

  it("does not leave leftover btn-icon or btn-group class names on product surfaces", () => {
    const leftovers = ["tsx", "ts"]
      .flatMap((suffix) => sourceFiles(webRoot, `.${suffix}`))
      .filter((path) => !path.includes(".test."))
      .map((path) => ({
        path: relative(webRoot, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter((file) => leftoverButtonClass.test(file.source))
      .map((file) => file.path);

    expect(leftovers).toEqual([]);
  });

  it("does not flatten the Code composer into two hairline boxes", () => {
    const shell = readFileSync(join(webRoot, "styles/shell.css"), "utf8");
    const styles = readFileSync(join(webRoot, "styles.css"), "utf8");

    // The adapter card is a layout hook on `.composer`. Flattening it
    // (transparent, no radius, no lift) and boxing the input and row as
    // separate fields is what left Code welcome looking like the old chrome
    // after the shared recipe shipped.
    expect(shell).not.toMatch(/\.code-composer-adapter__card\s*\{[^}]*box-shadow:\s*none/);
    expect(shell).not.toMatch(/\.code-composer-adapter__card\s*>\s*\.composer-row\s*\{/);
    expect(styles).not.toMatch(/\.code-thread-workspace__composer\s*\{[^}]*box-shadow:\s*none/);
  });

  it("lifts the composer with the mid shadow, not the hairline-only small shadow", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const frame = system.match(/^\.composer \{\n(?:.*\n)*?\}/m)?.[0] ?? "";

    expect(frame).toMatch(/box-shadow:\s*var\(--octant-shadow-md\)/);
    expect(frame).not.toMatch(/box-shadow:\s*var\(--octant-shadow-sm\)/);
  });

  it("keeps the composer prompt frameless so the shadcn textarea cannot paint a second field", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    const input = system.match(/\.composer-input\s*\{[^}]+\}/)?.[0] ?? "";

    // OctantTextarea ships rounded-md + shadow-xs. Those must not survive
    // inside `.composer`, or Code/Chat welcome read as a 10px field sitting
    // in a 20px frame — the old two-box chrome.
    expect(input).toMatch(/border-radius:\s*0/);
    expect(input).toMatch(/box-shadow:\s*none/);
    expect(input).toMatch(/border:\s*0/);
  });

  it("tucks the Code checkout card behind the composer as a second raised card", () => {
    const shell = readFileSync(join(webRoot, "styles/shell.css"), "utf8");
    const stack = shell.match(/\.code-composer-adapter__stack \{\n(?:.*\n)*?\}/m)?.[0] ?? "";
    const dock = shell.match(/\.code-composer-adapter__dock \{\n(?:.*\n)*?\}/m)?.[0] ?? "";

    expect(stack).toMatch(/position:\s*relative/);
    expect(stack).toMatch(/isolation:\s*isolate/);
    expect(stack).toMatch(/flex-direction:\s*column/);
    expect(dock).toMatch(/margin:\s*-20px auto 0/);
    expect(dock).toMatch(/width:\s*calc\(100% - 20px\)/);
    expect(dock).toMatch(/border-radius:\s*var\(--oct-radius-lg\)/);
    expect(dock).toMatch(/box-shadow:\s*var\(--octant-shadow-sm\)/);
    expect(dock).not.toMatch(/border-radius:\s*0 0/);
    expect(dock).not.toMatch(/position:\s*absolute/);
  });

  it("does not keep a native select recipe on the composer row", () => {
    const system = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    expect(system).not.toMatch(/\.composer-row select\b/);
  });
});
