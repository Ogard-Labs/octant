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

    expect(controlRules).toMatch(/border-radius:\s*var\(--oct-radius-sm\)/);
    expect(controlRules).toMatch(/background:\s*transparent/);
    expect(controlRules).not.toMatch(/rgb\(/);
  });

  it("keeps the composer and a preference group flat, one fill step above the page with one hairline", () => {
    const composerRules = between(
      systemStyles,
      "/* The composer is a flat box, one step from the surface behind it,",
      ".composer-chips {",
    );
    const settingsGroupRules = between(settingsStyles, ".setgroup {", "/* Rows inside a group");

    expect(composerRules).toMatch(/box-shadow:\s*none/);
    expect(composerRules).toMatch(/outline:\s*1px solid var\(--oct-border\)/);
    expect(composerRules).toMatch(/--octant-(?:card|floating|workspace)/);
    expect(composerRules).not.toMatch(/rgb\(/);
    expect(settingsGroupRules).toMatch(/background:\s*transparent/);
    expect(settingsGroupRules).toMatch(/box-shadow:\s*none/);
    expect(settingsGroupRules).not.toMatch(/rgb\(/);
    // Inside Settings the group is a card one step above the page: its fill
    // and one hairline, with no shadow.
    const card = settingsStyles
      .replace(/\s+/g, " ")
      .match(/\.settings-view \.settings-card-section--open > :is\([^)]*\) \{([^}]*)\}/)?.[1];
    expect(card).not.toMatch(/box-shadow/);
    expect(card).toMatch(/outline:\s*1px solid var\(--oct-hairline\)/);
    expect(card).not.toMatch(/rgb\(/);
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
