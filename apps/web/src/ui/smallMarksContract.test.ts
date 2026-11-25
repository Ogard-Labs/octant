import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = join(process.cwd(), "src");

function files(directory: string, keep: (path: string) => boolean): ReadonlyArray<string> {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...files(path, keep));
    else if (keep(path)) found.push(path);
  }
  return found;
}

const stylesheets = files(webRoot, (path) => path.endsWith(".css")).map((path) => ({
  name: relative(webRoot, path),
  // A comment may name a rule that is gone.
  rules: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}));

/**
 * The spinner, the key cap and the status dot are each drawn by one adapter
 * with one rule. Each was drawn by hand wherever it was needed: eight copies
 * of the spin keyframe in thirteen stylesheets, keyboard hints in three
 * typefaces, and a dot per feature (counted 2026-11-25).
 */
describe("the three small marks", () => {
  it("turns every spinner with one keyframe, from one rule", () => {
    const keyframes: string[] = [];
    const turning: string[] = [];
    for (const { name, rules } of stylesheets) {
      for (const match of rules.matchAll(/@keyframes\s+([a-z0-9-]*spin[a-z0-9-]*)/g)) {
        keyframes.push(`${name}: ${match[1] ?? ""}`);
      }
      for (const block of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/animation(?:-name)?:[^;]*\boct-spin\b/.test(block[2] ?? "")) continue;
        turning.push(`${name}: ${(block[1] ?? "").trim()}`);
      }
    }
    expect(keyframes).toEqual(["styles/octant.css: oct-spin"]);
    expect(turning).toEqual(["styles/octant.css: .octant-spinner"]);
  });

  // A model endpoint's state is a ring that turns while it is checked. It is
  // a status mark with a turning state, not a spinner glyph, so it keeps a
  // keyframe of its own, and nothing else may borrow the exemption.
  it("lets only the endpoint's status ring turn by another keyframe", () => {
    const other: string[] = [];
    for (const { name, rules } of stylesheets) {
      for (const block of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = block[2] ?? "";
        if (!/animation:[^;]*var\(--oct-motion-spin\)/.test(body)) continue;
        if (/\boct-spin\b/.test(body)) continue;
        other.push(`${name}: ${(block[1] ?? "").trim()}`);
      }
    }
    expect(other).toEqual([
      'styles/provider-settings.css: .endpoint-state[data-tone="checking"] > .endpoint-state__dot',
    ]);
  });

  it("draws every keyboard hint with OctantKbd", () => {
    const raw = files(
      webRoot,
      (path) =>
        path.endsWith(".tsx") && !/\.test\.|[/\\]ui[/\\]base[/\\]OctantKbd\.tsx$/.test(path),
    ).filter((path) => /<kbd[\s>]/.test(readFileSync(path, "utf8")));
    expect(raw.map((path) => relative(webRoot, path))).toEqual([]);
  });

  it("leaves a key cap's ink, face and box to the adapter", () => {
    // What a feature may still say about its hint is where it stands.
    const paint =
      /(?:^|[\s;])(?:color|font(?:-family|-size|-weight)?|border(?:-radius)?|padding|line-height)\s*:/;
    const repainted: string[] = [];
    for (const { name, rules } of stylesheets) {
      for (const block of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = (block[1] ?? "").trim();
        if (selector.includes(".octant-kbd")) continue;
        const namesAHint =
          /(?:^|[\s>+~,])kbd(?![a-z-])/.test(selector) ||
          /\.(?:sidebar-item__key|octant-tooltip__key|settings-view__search-shortcut|composer-model-picker__hint|command-palette__shortcut)(?![a-z0-9_-])/.test(
            selector,
          );
        // The browser's own reset for code-like elements names kbd beside
        // code and pre; it sets no paint of a hint's own.
        if (!namesAHint || selector.includes(":where(")) continue;
        if (paint.test(block[2] ?? "")) repainted.push(`${name}: ${selector}`);
      }
    }
    expect(repainted).toEqual([]);
  });

  it("draws a state's dot with OctantStatusDot, and names the dots that are something else", () => {
    const system = stylesheets.find(({ name }) => name === "styles/octant.css")?.rules ?? "";
    for (const tone of ["active", "success", "warning", "danger", "accent"]) {
      expect(system).toContain(`.octant-status-dot[data-tone="${tone}"]`);
    }
    // The dots these pages drew themselves are gone; each now only places the
    // shared dot, or is not in the stylesheet at all.
    const moved = [
      ".agents-center-row__dot",
      ".host-selector__dot",
      ".dock-card__dot",
      ".browser-workspace__server-dot",
      ".work-list__active-dot",
      ".canvas-design__running-dot",
    ];
    const shape = /(?:^|[\s;])(?:width|height|border-radius|background(?:-color)?|animation)\s*:/;
    const redrawn: string[] = [];
    for (const { name, rules } of stylesheets) {
      for (const block of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = (block[1] ?? "").trim();
        if (!moved.some((dot) => selector.includes(dot))) continue;
        if (shape.test(block[2] ?? "")) redrawn.push(`${name}: ${selector}`);
      }
    }
    expect(redrawn).toEqual([]);
  });
});
