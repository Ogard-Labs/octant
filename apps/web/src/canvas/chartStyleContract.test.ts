import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const canvasCss = readFileSync(join(webRoot, "styles/canvas.css"), "utf8");

describe("canvas chart motion", () => {
  it("has no entrance animation on a chart", () => {
    // Motion is a state change, never an entrance: a chart that fades or slides
    // in re-animates on every scroll into view. This chart's own rules carry no
    // animation, and no keyframe is defined for a chart selector.
    const chartRules = [...canvasCss.matchAll(/\.canvas-block__chart[^{]*\{[^}]*\}/g)]
      .map((match) => match[0])
      .join("\n");
    expect(chartRules).not.toMatch(/animation(?:-name)?\s*:/);
    const keyframeNames = [...canvasCss.matchAll(/@keyframes\s+([\w-]+)/g)].map(
      (match) => match[1],
    );
    expect(keyframeNames.some((name) => (name ?? "").includes("chart"))).toBe(false);
  });

  it("runs a mark transition only on a state change and keeps it under 200ms", () => {
    const rule = canvasCss.match(/\.canvas-block__chart-mark\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/transition:/);
    // The duration is a motion token (fast, 150ms; base, 200ms), never a raw
    // number chosen here, so it can never drift past the 200ms ceiling.
    const tokens = [...rule.matchAll(/var\(--oct-motion-([a-z-]+)\)/g)].map((match) => match[1]);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(["fast", "base"]).toContain(token);
    }
    const raw = [...rule.matchAll(/(\d+)ms/g)].map((match) => Number(match[1]));
    for (const duration of raw) expect(duration).toBeLessThanOrEqual(200);
  });

  it("turns the mark transition off under reduced motion and when the setting asks", () => {
    const reduceBlock =
      canvasCss.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(reduceBlock).toMatch(/\.canvas-block__chart-mark[^}]*transition:\s*none/);
    expect(canvasCss).toMatch(
      /\[data-octant-reduced-motion="true"\][^{]*\.canvas-block__chart-mark[^{]*\{[^}]*transition:\s*none/,
    );
  });
});
