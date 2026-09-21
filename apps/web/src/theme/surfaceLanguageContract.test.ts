import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return readFileSync(join(webRoot, relative), "utf8");
}

/**
 * DESIGN.md "Language" is the part of the system that leaves the renderer.
 * These checks keep the renderer honest about it: one face, one set of type
 * roles, and no uppercase kickers creeping back into headings.
 */
describe("surface language", () => {
  it("ships Inter as the interface face with the system face as fallback", () => {
    expect(read("styles.css")).toContain('@import "@fontsource-variable/inter/opsz.css";');
    expect(DEFAULT_THEME_SETTINGS.typography.ui.family).toMatch(/^'Inter Variable', /);
    expect(DEFAULT_THEME_SETTINGS.typography.ui.family).toContain("system-ui");
    expect(read("styles/octant.css")).toMatch(/^body \{[^}]*font-optical-sizing: auto;/m);
  });

  it("defines every heading and label role once", () => {
    const surface = read("styles/surface.css");
    for (const role of [
      ".oct-title {",
      ".oct-title--hero {",
      ".oct-subtitle {",
      ".oct-section-label {",
      ".oct-row-label {",
      ".oct-row-detail {",
      ".oct-meta {",
      ".oct-meta--mono {",
    ]) {
      expect(surface).toContain(role);
    }
    // Only the page title carries the strong weight.
    const strong = surface.match(/font-weight: var\(--oct-weight-strong\)/g) ?? [];
    expect(strong).toHaveLength(1);
    expect(surface).not.toContain("text-transform: uppercase");
    expect(surface).not.toMatch(/font-size:\s*1[12]\.5px/);
  });

  it("keeps the one page shell and the one way back", () => {
    const surface = read("styles/surface.css");
    const component = read("surface/SurfaceHeader.tsx");
    expect(surface).toContain(".surface-header {");
    expect(surface).toContain(".surface-toolbar {");
    expect(surface).toContain(".surface-row {");
    expect(surface).toContain(".surface-empty {");
    expect(component.match(/Back to workspace/g)).toHaveLength(1);
    expect(component).not.toContain(">Close<");
  });

  it("keeps sidebar and menu labels in sentence case", () => {
    const sidebar = read("styles.css").match(
      /\.project-section > \.sidebar-section \{[^}]+\}/,
    )?.[0];
    expect(sidebar).toContain("text-transform: none;");
    const palette = read("styles/palette.css").match(
      /\.command-palette__group-label \{[^}]+\}/,
    )?.[0];
    expect(palette).toContain("text-transform: none;");
  });
});
