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
  it("defaults to the platform face, bundles Geist as a choice, and sets code in Geist Mono", () => {
    expect(read("styles.css")).toContain('@import "@fontsource-variable/geist/index.css";');
    expect(read("styles.css")).toContain('@import "@fontsource-variable/geist-mono/index.css";');
    // The earlier default (Inter) and display face (Space Grotesk) are gone.
    expect(read("styles.css")).not.toContain("@fontsource-variable/inter");
    expect(read("styles/octant.css")).not.toContain("Octant Display");
    expect(DEFAULT_THEME_SETTINGS.typography.ui.family).toMatch(/^system-ui, /);
    expect(DEFAULT_THEME_SETTINGS.typography.ui.family).toContain("system-ui");
    expect(read("styles/octant.css")).toMatch(/^body \{[^}]*font-optical-sizing: auto;/m);
  });

  it("defines every heading and label role once", () => {
    const surface = read("styles/surface.css");
    for (const role of [
      ".oct-title {",
      ".oct-title--hero {",
      ".oct-page-title {",
      ".oct-section-label {",
      ".oct-row-label {",
      ".oct-row-detail {",
      ".oct-meta {",
      ".oct-meta--mono {",
    ]) {
      expect(surface).toContain(role);
    }
    // Only the large title carries the title weight; a display header's title
    // is the strong weight.
    const title = surface.match(/font-weight: var\(--oct-weight-title\)/g) ?? [];
    expect(title).toHaveLength(1);
    expect(surface).not.toContain("text-transform: uppercase");
    expect(surface).not.toMatch(/font-size:\s*1[12]\.5px/);
  });

  it("sets the start screen's question in the primary ink at regular weight, in every style", () => {
    const question = read("composer/welcome-heading.css");
    const rule = question.match(/\.welcome__question \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("color: var(--oct-fg);");
    expect(rule).toContain("font-weight: var(--oct-weight-regular);");
    expect(rule).toContain("font-size: var(--oct-text-2xl);");
    expect(rule).toContain("letter-spacing: -0.012em;");
    // No style recolours the question with its accent.
    expect(read("styles/colour.css")).not.toMatch(/oct-title--hero/);
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

  it("gives destinations and Settings one page title", () => {
    const surface = read("styles/surface.css");
    const title = surface.match(/\.oct-page-title \{[^}]*\}/)?.[0] ?? "";
    expect(title).toContain("font-size: var(--oct-text-sm);");
    expect(title).toContain("font-weight: var(--oct-weight-strong);");
    expect(read("surface/SurfaceHeader.tsx")).toContain('className="oct-page-title"');
    expect(read("shell/SettingsView.tsx")).toContain('<h1 className="oct-page-title"');
  });

  it("keeps sidebar and menu labels in sentence case", () => {
    const sidebar = read("styles/project-threads.css").match(
      /\.project-section > \.sidebar-section \{[^}]+\}/,
    )?.[0];
    expect(sidebar).toContain("text-transform: none;");
    const palette = read("styles/palette.css").match(
      /\.command-palette__group-label \{[^}]+\}/,
    )?.[0];
    expect(palette).toContain("text-transform: none;");
  });
});
