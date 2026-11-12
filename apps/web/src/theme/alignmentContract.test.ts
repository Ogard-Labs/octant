import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(import.meta.dirname, "../styles", file), "utf8");
const shell = read("shell.css");
const dock = read("dock.css");
const settings = read("settings.css");
const octant = read("octant.css");
const chat = read("chat.css");
const usage = read("usage.css");
const projectThreads = read("project-threads.css");
const root = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");

function rule(source: string, selector: string): string {
  const from = source.indexOf(`\n${selector} {`);
  expect(from, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf("}", from));
}

describe("the shell's edges and gaps", () => {
  it("keeps one 4px gap between icon buttons in the title band, the tool row and the sidebar's header", () => {
    for (const selector of [".window-chrome__trailing", ".dock-tool-buttons"]) {
      expect(rule(shell, selector), selector).toMatch(/gap:\s*var\(--oct-space-1\)/);
    }
    expect(
      rule(
        shell,
        ".sidebar__chrome-actions,\n.sidebar__chrome-activity,\n.sidebar__primary-actions",
      ),
    ).toMatch(/gap:\s*var\(--oct-space-1\)/);
  });

  it("collapses an empty Project slot so it adds no second gap between controls", () => {
    expect(rule(shell, ".window-chrome__open-in-action:empty")).toMatch(/display:\s*none/);
  });

  it("keeps the band's 8px inset at both ends and a tile bar's end on it", () => {
    const trailing = rule(shell, ".window-chrome__trailing");
    expect(trailing).toMatch(/padding:\s*0 var\(--oct-space-2\)/);
    const leading = rule(shell, ".window-chrome__leading--browser");
    expect(leading).toMatch(/padding:\s*2px 4px 2px var\(--oct-space-2\)/);
    const bar = rule(dock, ".dock-tile__bar");
    expect(bar).toMatch(/padding:\s*0 var\(--oct-space-2\) 0 var\(--oct-space-3\)/);
    // The hairline is inside the 32px: a border would put the controls' centre
    // on a half pixel.
    expect(bar).not.toMatch(/border-bottom/);
    expect(bar).toMatch(/box-shadow:\s*inset 0 -1px 0/);
    expect(rule(dock, ".dock-tile__control > svg")).toContain("var(--oct-icon-sm)");
  });

  it("makes each rail button its 32px face, and centres the first face on the title rail", () => {
    expect(rule(shell, ".sidebar-rail__button")).toMatch(/margin:\s*-1px;/);
    expect(rule(usage, ".rail-usage__ring")).toMatch(/margin:\s*-1px;/);
    const scroll = rule(shell, ".sidebar-rail__scroll");
    expect(scroll).toMatch(
      /--sidebar-rail-top:\s*calc\(\(var\(--oct-title-rail-h\) - 32px\) \/ 2\)/,
    );
    expect(scroll).toMatch(/padding:\s*var\(--sidebar-rail-top\) 0/);
  });

  it("keeps the dock bar's content box at the dock's width less 16px, from the 280px minimum up", () => {
    const toolbar = rule(dock, ".right-utility-dock__toolbar");
    // The bar never reserves the title band's room: that left a 0px content box
    // at 300px (349px of padding) and a clipped column.
    expect(toolbar).not.toContain("--octant-window-chrome-reserved-width");
    const padding = /padding:\s*4px (\S+) \S+ (\S+);/.exec(toolbar);
    expect(padding).not.toBeNull();
    const inset = (value: string | undefined) => (value === "var(--oct-space-2)" ? 8 : Number.NaN);
    const horizontal = inset(padding?.[1]) + inset(padding?.[2]);
    for (const width of [280, 300, 330, 360, 640]) {
      expect(width - horizontal, `content box at ${width}px`).toBe(width - 16);
    }
  });

  it("stands a dock card's title and every row's name on one edge", () => {
    expect(rule(dock, ".dock-card__head")).toMatch(/border:\s*0;/);
    // 4 + 6 + 4 is the 14px an icon takes, so icon and dot rows share a column.
    const dot = rule(dock, ".dock-card__dot");
    expect(dot).toMatch(/width:\s*6px/);
    expect(dot).toMatch(/margin-inline:\s*var\(--oct-space-1\)/);
  });

  it("draws a Settings card's edge inside its box so its rows keep an exact 16px inset", () => {
    const card = settings.slice(
      settings.indexOf(".settings-card-section--open\n  > :is(.setgroup"),
    );
    const body = card.slice(0, card.indexOf("}"));
    expect(body).toMatch(/border:\s*0;/);
    expect(body).toMatch(/outline:\s*1px solid transparent;/);
    expect(body).toMatch(/outline-offset:\s*-1px;/);
  });

  it("sets the lines of a row that is a sum of lines in whole pixels", () => {
    expect(octant).toMatch(
      /--oct-line-label:\s*round\(calc\(var\(--oct-leading-label\) \* 1em\), 1px\)/,
    );
    expect(rule(settings, ".setrow-label")).toContain("var(--oct-line-label)");
    expect(rule(settings, ".setrow-hint")).toContain("var(--oct-line-detail)");
    expect(rule(shell, ".sidebar-navigation__thread-title")).toContain("var(--oct-line-label)");
    expect(rule(shell, ".sidebar-navigation__thread-facts")).toContain("var(--oct-line-meta)");
    expect(rule(projectThreads, ".move-thread__title")).toContain("var(--oct-line-label)");
  });

  it("gives the Move to Project list one icon box, whether the Project has a picture or not", () => {
    const mark = rule(projectThreads, ".move-thread__title > :is(svg, .project-icon)");
    expect(mark).toContain("width: var(--oct-icon-md)");
    expect(mark).toContain("height: var(--oct-icon-md)");
  });

  it("ends the account row's chevron on the navigation inset a thread's status mark ends on", () => {
    expect(rule(root, ".sidebar-profile .sidebar-item")).toMatch(
      /padding-inline:\s*10px var\(--oct-nav-inset\)/,
    );
  });

  it("starts the composer row on the box's columns in Chat as in Code, and keeps the prompt line whole", () => {
    expect(rule(chat, ".chat-composer__leading:empty")).toMatch(/display:\s*none/);
    expect(rule(octant, ".composer-input")).toContain("round(");
    expect(rule(octant, ".composer-input")).toMatch(/line-height:\s*var\(--oct-composer-line\)/);
    expect(rule(octant, ".composer-field__attach,\n.composer-field__actions")).toContain(
      "var(--oct-composer-line)",
    );
  });
});
