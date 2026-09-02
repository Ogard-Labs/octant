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
  it("keeps composer-row controls quiet so the frame is the only field", () => {
    const controlRules = between(
      systemStyles,
      "/* One control size and one label size across the whole row.",
      "/* The frame's direct labels are its message fields;",
    );

    expect(controlRules).toMatch(/border-radius:\s*var\(--oct-radius-(?:sm|pill)\)/);
    expect(controlRules).toMatch(/background:\s*transparent/);
    expect(controlRules).not.toMatch(/rgb\(/);
  });

  it("lifts the composer and Settings cards with Octant depth tokens", () => {
    const composerRules = between(
      systemStyles,
      "/* The composer is a raised object, not a field ruled onto the page:",
      ".composer-chips {",
    );
    const settingsGroupRules = between(settingsStyles, ".setgroup {", "/* Rows inside a group");

    expect(composerRules).toMatch(/box-shadow:\s*var\(--octant-shadow-md\)/);
    expect(composerRules).toMatch(/--octant-(?:card|floating|workspace)/);
    expect(composerRules).not.toMatch(/rgb\(/);
    expect(settingsGroupRules).toMatch(/--octant-settings-card/);
    expect(settingsGroupRules).toMatch(/--octant-shadow-sm/);
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
