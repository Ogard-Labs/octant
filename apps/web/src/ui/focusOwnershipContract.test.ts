import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const recipeDirectory = join(import.meta.dirname, "shadcn");

/**
 * The style every recipe is imported from paints keyboard focus per control,
 * as a wide translucent halo. That is a web idiom: it reads as a page element
 * that happens to be focusable. Octant paints one ring for the whole app —
 * a hairline gap then a muted ring, tight to the control (0086).
 *
 * Eight recipes carried the imported halo before this was checked, so the rule
 * is not self-enforcing: it survives exactly as long as something re-reads the
 * recipes after each upstream reconcile.
 */
describe("focus ownership", () => {
  const recipes = readdirSync(recipeDirectory)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => ({ name, source: readFileSync(join(recipeDirectory, name), "utf8") }));

  it("finds recipes to check", () => {
    expect(recipes.length).toBeGreaterThan(0);
  });

  it.each(recipes)("$name leaves keyboard focus to the app's own ring", ({ source }) => {
    const classNames = source.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(classNames).not.toMatch(/focus-visible:ring-/);
    expect(classNames).not.toMatch(/focus-visible:border-ring/);
  });
});
