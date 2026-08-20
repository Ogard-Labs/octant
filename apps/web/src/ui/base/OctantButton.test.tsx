import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantButton, OctantIconButton } from "./OctantButton";

function extractNamedLayer(raw: string, name: string): { body: string; remainder: string } {
  // Prose can name a layer too ("preflight lives in @layer base"), and the
  // first match must be the rule, not a comment about it.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const marker = `@layer ${name}`;
  const start = source.indexOf(marker);
  expect(start, `missing ${marker}`).toBeGreaterThanOrEqual(0);
  const openingBrace = source.indexOf("{", start);
  expect(openingBrace, `missing opening brace for ${marker}`).toBeGreaterThan(start);

  let depth = 1;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) {
      return {
        body: source.slice(openingBrace + 1, index),
        remainder: `${source.slice(0, start)}${source.slice(index + 1)}`,
      };
    }
  }

  throw new Error(`missing closing brace for ${marker}`);
}

describe("OctantButton", () => {
  it("renders the filled recipe on a default button without a site class", () => {
    render(<OctantButton type="button">Save Project</OctantButton>);

    const button = screen.getByRole("button", { name: "Save Project" });
    expect(button.className).toContain("bg-primary");
    expect(button.className).toContain("text-primary-foreground");
    expect(button.className).not.toContain("project-button");
  });

  it("keeps icon-only and ghost buttons without a fill", () => {
    render(
      <>
        <OctantButton type="button" variant="ghost">
          Cancel
        </OctantButton>
        <OctantIconButton label="Close dock" type="button">
          ×
        </OctantIconButton>
      </>,
    );

    expect(screen.getByRole("button", { name: "Cancel" }).className).not.toContain("bg-primary");
    expect(screen.getByRole("button", { name: "Close dock" })).toHaveClass("shell-icon-button");
    expect(screen.getByRole("button", { name: "Close dock" }).className).not.toContain(
      "bg-primary",
    );
  });

  it("layers the element reset so recipes can paint and leaves the keyboard outline unlayered", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const { body: baseLayer, remainder } = extractNamedLayer(styles, "base");

    expect(baseLayer).toMatch(/^\s*button\s*\{/m);
    expect(baseLayer).toContain("appearance: none;");
    expect(baseLayer).toContain("background: transparent;");
    expect(baseLayer).not.toContain("button:focus-visible");

    expect(remainder).not.toMatch(/(?:^|\n)button\s*\{/);
    expect(remainder).toMatch(/button:focus-visible\s*\{/);
    expect(remainder).toContain("outline: 2px solid var(--octant-focus-ring);");
    expect(styles).not.toContain(".project-button--primary");
  });
});
