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
 * A selector list's selectors, or a selector's compounds: split only outside
 * brackets, since `:is(.a, .b)` and `[data-x="a b"]` hold commas and spaces
 * of their own.
 */
function splitOutsideBrackets(text: string, separator: RegExp): ReadonlyArray<string> {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    if (depth === 0 && separator.test(char)) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * The classes a compound selector asks of its own element. `:has()` and
 * `:not()` name other elements or what the element is not, so what they hold
 * is left out; `:is()` and `:where()` describe the element itself and stay.
 */
function ownClasses(compound: string): ReadonlyArray<string> {
  let own = "";
  let skipUntilDepth: number | undefined;
  let depth = 0;
  for (let index = 0; index < compound.length; index += 1) {
    const char = compound[index] ?? "";
    if (skipUntilDepth === undefined && /^:(?:has|not)\($/.test(compound.slice(index, index + 5))) {
      skipUntilDepth = depth;
    }
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    if (skipUntilDepth === undefined) own += char;
    else if (char === ")" && depth === skipUntilDepth) skipUntilDepth = undefined;
  }
  return own.match(/\.[A-Za-z0-9_-]+/g) ?? [];
}

/**
 * DESIGN.md "Voice" and "Face" are the part of the system that leaves the renderer.
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
      ".oct-nav-name {",
      ".oct-nav-group {",
      ".oct-activity-line {",
      ".oct-menu-option {",
      ".oct-row-label {",
      ".oct-row-detail {",
      ".oct-meta {",
      ".oct-meta--mono {",
    ]) {
      expect(surface).toContain(role);
    }
    // Only the large title carries the title weight; a page header's title is
    // the strong weight.
    const title = surface.match(/font-weight: var\(--oct-weight-title\)/g) ?? [];
    expect(title).toHaveLength(1);
    expect(surface).not.toContain("text-transform: uppercase");
    expect(surface).not.toMatch(/font-size:\s*1[12]\.5px/);
  });

  it("sets the start screen's question in the primary ink at regular weight and a window title's size, in every style", () => {
    const question = read("composer/welcome-heading.css");
    const rule = question.match(/\.welcome__question \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("color: var(--oct-fg);");
    expect(rule).toContain("font-weight: var(--oct-weight-regular);");
    expect(rule).toContain("font-size: var(--oct-text-xl);");
    // One size at every width: no narrower step to swap to.
    expect(question).not.toMatch(/@media/);
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

  it("draws the Agents, Artifacts and Automations lists as the one page table", () => {
    const table = read("styles/surface-table.css");
    expect(table).toMatch(
      /\.surface-table__head,\s*\.surface-table__row \{[^}]*grid-template-columns: var\(--surface-table-columns\)/,
    );
    // The table loads with the pages that draw it, not with the window.
    expect(read("styles/surface.css")).not.toContain(".surface-table");
    // Each page names its columns and draws its cells; the head, the rows'
    // rail and hover, and the open button's reset are the table's. Three
    // hand-drawn copies had three row heights and two label sizes, so a page's
    // own head, row and open button may place themselves and nothing more.
    const pages = [
      {
        markup: "agents/AgentsCenter.tsx",
        sheet: "styles/agents-center.css",
        own: [".agents-table__head", ".agents-center-row", ".agents-center-row__open"],
      },
      {
        markup: "artifacts/ArtifactTableRow.tsx",
        sheet: "styles/artifacts.css",
        own: [".artifact-table__head", ".artifact-table-row", ".artifact-table-row__open"],
      },
      {
        markup: "automation/AutomationCenter.tsx",
        sheet: "styles/automation.css",
        own: [".automation-table__head", ".automation-row", ".automation-row__open"],
      },
    ] as const;
    const theTables =
      /(?:^|[\s;])(?:min-height|height|padding(?:-block|-inline)?|border(?:-bottom|-width)?|background|grid-template-columns|column-gap|font-size|font-weight)\s*:/;
    for (const page of pages) {
      const component = read(page.markup);
      expect(component).toContain('className="surface-table__head ');
      expect(component).toMatch(/className="surface-table__row /);
      expect(component).toContain("oct-row-label surface-table__label");
      expect(component).toContain("oct-meta surface-table__meta");
      const rules = read(page.sheet).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(rules).toContain("--surface-table-columns:");
      const redrawn: string[] = [];
      for (const block of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = splitOutsideBrackets(block[1] ?? "", /,/);
        // What a selector styles is its last compound, whatever it stands
        // under and whatever state it is in: a hover on the row is the
        // table's, and so is the row inside the dock's list. A rule about a
        // cell inside the row is the page's own.
        const named = selectors.filter((selector) => {
          const subject = splitOutsideBrackets(selector, /[\s>+~]/).at(-1) ?? "";
          const classes = ownClasses(subject);
          return page.own.some((own) => classes.includes(own));
        });
        if (named.length > 0 && theTables.test(block[2] ?? "")) redrawn.push(...named);
      }
      expect(redrawn).toEqual([]);
    }
  });

  it("gives destinations and Settings one page title", () => {
    const surface = read("styles/surface.css");
    const title = surface.match(/\.oct-page-title \{[^}]*\}/)?.[0] ?? "";
    expect(title).toContain("font-size: var(--oct-text-2xl);");
    expect(title).toContain("font-weight: var(--oct-weight-strong);");
    expect(title).toContain("letter-spacing: var(--oct-tracking-sf-26);");
    expect(read("surface/SurfaceHeader.tsx")).toContain('className="oct-page-title"');
    expect(read("shell/SettingsView.tsx")).toContain('<h1 className="oct-page-title"');
  });

  it("sets the title band's facts as Meta, and names, group labels, activity lines and menu options as their own roles", () => {
    const app = read("styles.css");
    for (const selector of [".workspace-pane__context", ".workspace-pane__crumb"]) {
      const rule = app.match(new RegExp(`${selector.replace(".", "\\.")} \\{[^}]*\\}`))?.[0] ?? "";
      expect(rule).toContain("font-size: var(--oct-text-xs);");
      expect(rule).toContain("font-weight: var(--oct-weight-regular);");
    }
    const surface = read("styles/surface.css");
    const role = (name: string) => surface.match(new RegExp(`\\.${name} \\{[^}]*\\}`))?.[0] ?? "";
    // A name in navigation: the interface size, medium weight (the weak
    // regular names read faint beside their icons, maintainer feedback), no
    // tracking.
    const name = role("oct-nav-name");
    expect(name).toContain("font-size: var(--oct-text-detail);");
    expect(name).toContain("font-weight: var(--oct-weight-medium);");
    expect(name).toContain("letter-spacing: var(--oct-tracking-sf-14);");
    // A group label: a quiet 12px caption, not a Section label.
    const group = role("oct-nav-group");
    expect(group).toContain("font-size: var(--oct-text-xs);");
    expect(group).toContain("font-weight: var(--oct-weight-regular);");
    expect(group).toContain("color: var(--oct-muted);");
    // A thread's activity line is the text's size, told apart by ink.
    const activity = role("oct-activity-line");
    expect(activity).toContain("font-size: var(--oct-text-detail);");
    expect(activity).toContain("color: var(--oct-meta);");
    // A menu option: the interface size at medium weight.
    const option = role("oct-menu-option");
    expect(option).toContain("font-size: var(--oct-text-detail);");
    expect(option).toContain("font-weight: var(--oct-weight-medium);");
    // The surfaces that play a role carry its class and set no type of their own.
    expect(read("projects/SidebarThreadRowContent.tsx")).toContain(
      "oct-nav-name sidebar-navigation__thread-title",
    );
    expect(read("shell/SidebarProfile.tsx")).toContain("oct-nav-name sidebar-label");
    expect(read("shell/SplitWorkspace.tsx")).toContain("oct-nav-name workspace-pane__title");
    expect(read("shell/SettingsNavigation.tsx")).toContain("oct-nav-group setnav-section");
    expect(read("projects/ProjectSidebarSection.tsx")).toContain("oct-nav-group sidebar-section");
    expect(read("transcript/TurnHeader.tsx")).toContain(
      "oct-activity-line turn-header__worked-for",
    );
    expect(read("transcript/TurnHeader.tsx")).toContain("oct-activity-line turn-time");
    expect(read("ui/shadcn/menu-row.ts")).toContain("oct-menu-option");
    const heading = app.match(/\.activity-nav__group > h2 \{[^}]*\}/)?.[0] ?? "";
    expect(heading).not.toMatch(/font-|letter-spacing|line-height/);
    expect(read("styles/octant.css").match(/\.turn-time \{[^}]*\}/)?.[0] ?? "").not.toMatch(
      /font-size|line-height|color/,
    );
  });

  it("gives a reply's running text a 1.6 leading and a 16px list indent without touching its size", () => {
    const chat = read("styles/chat.css");
    const text = chat.match(/\.chat-rich-text :is\(p, li, td, th\) \{[^}]*\}/)?.[0] ?? "";
    expect(text).toContain("line-height: var(--oct-leading-reading);");
    expect(text).not.toContain("font-size");
    expect(read("styles/octant.css")).toMatch(/--oct-leading-reading:\s*1\.6;/);
    const lists =
      chat.match(/\.chat-rich-text ul,\n\.chat-rich-text ol \{[^}]*padding-left[^}]*\}/)?.[0] ?? "";
    expect(lists).toContain("padding-left: 16px;");
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
