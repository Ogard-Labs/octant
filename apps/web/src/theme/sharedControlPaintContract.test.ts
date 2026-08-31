import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesRoot = resolve(import.meta.dirname, "../styles");
const systemStyles = readFileSync(resolve(stylesRoot, "octant.css"), "utf8");
const settingsStyles = readFileSync(resolve(stylesRoot, "settings.css"), "utf8");
const chatStyles = readFileSync(resolve(stylesRoot, "chat.css"), "utf8");

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("shared control paint ownership", () => {
  it("lets shared recipes paint controls in the composer row", () => {
    const controlRules = between(
      systemStyles,
      "/* One control size and one label size across the whole row.",
      "/* The frame's direct labels are its message fields;",
    );

    expect(controlRules).not.toMatch(/\b(?:background|color|border|border-color|border-radius):/);
  });

  it("uses bridge aliases and semantic depth tokens for raised product surfaces", () => {
    const composerRules = between(
      systemStyles,
      "/* The composer is a raised object, not a field ruled onto the page:",
      ".composer-chips {",
    );
    const settingsGroupRules = between(
      settingsStyles,
      ".settings-card-section > .setgroup,",
      "/* Rows inside a group",
    );

    expect(composerRules).not.toContain("--octant-");
    expect(composerRules).not.toMatch(/rgb\(/);
    expect(settingsGroupRules).not.toContain("--octant-");
    expect(settingsGroupRules).not.toMatch(/rgb\(/);
  });

  it("uses the shared pill radius token instead of literal pill values", () => {
    expect(systemStyles).not.toContain("border-radius: 999px;");
    expect(chatStyles).not.toContain("border-radius: 999px;");
  });

  it("keeps light-dark selection inside elevation colors", () => {
    const elevationTokens = between(systemStyles, "--oct-elev-subtle:", "--oct-focus-ring:");

    expect(elevationTokens).not.toMatch(/light-dark\(\s*\d/);
  });
});
