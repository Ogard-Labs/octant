import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = join(process.cwd(), "src");

// Properties a pointer answers with. A transition on any of them makes a
// hover, focus or press fade in, which read as a web page (seen 2026-11-16).
const pointerProperty =
  /\b(?:all|background(?:-color)?|color|border-color|box-shadow|outline|text-decoration-color|fill|stroke)\b/;

// What may still fade a paint: a progress arc, a chart mark redrawn when its
// data or legend changes, and the state of a checkbox or switch the person has
// just toggled. None of them is a control answering the pointer.
const stateTransitions = [
  ".composer-context-meter__used",
  ".canvas-block__chart-mark",
  ".canvas-block__treemap-mark",
  ".canvas-block__heatmap-mark",
  ".check input",
  "input.switch",
  ".octant-switch",
];

function sourceFiles(directory: string, suffix: string): ReadonlyArray<string> {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path, suffix));
    else if (entry.endsWith(suffix)) found.push(path);
  }
  return found;
}

describe("pointer answers are instant", () => {
  it("fades no stylesheet paint on hover, focus or press", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(webRoot, ".css")) {
      const css = readFileSync(path, "utf8");
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = (rule[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
        for (const declaration of (rule[2] ?? "").matchAll(
          /transition(?:-property)?\s*:([^;]*);/g,
        )) {
          const value = declaration[1] ?? "";
          if (!pointerProperty.test(value)) continue;
          if (stateTransitions.some((allowed) => selector.includes(allowed))) continue;
          offenders.push(`${relative(webRoot, path)}: ${selector.split("\n").pop() ?? ""}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives the shared recipes no transition class and the filled button variants a pressed step", () => {
    const recipes = sourceFiles(join(webRoot, "ui", "shadcn"), ".tsx");
    const withTransition = recipes
      .filter((path) => !path.endsWith("switch.tsx") && !path.includes(".test."))
      .filter((path) => /\btransition(?:-[a-z[]\S*)?\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(webRoot, path));
    expect(withTransition).toEqual([]);

    const button = readFileSync(join(webRoot, "ui", "shadcn", "button.tsx"), "utf8");
    for (const variant of ["default", "solid", "destructive", "outline", "secondary", "ghost"]) {
      const line = button.split("\n").find((row) => new RegExp(`^\\s*${variant}:`).test(row));
      const entry = line === undefined ? "" : button.slice(button.indexOf(line));
      expect(entry.slice(0, 600), variant).toMatch(/active:bg-/);
    }
    expect(button).toMatch(/chip:[^\n]*[\s\S]{0,300}?active:bg-/);
  });
});
