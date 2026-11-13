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
const components = read("components.css");
const code = read("code.css");
const root = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");
const source = (file: string) => readFileSync(resolve(import.meta.dirname, "..", file), "utf8");
const toggleGroup = source("ui/shadcn/toggle-group.tsx");
const slider = source("ui/shadcn/slider.tsx");
const toast = source("ui/base/OctantToast.tsx");
const splitWorkspace = source("shell/SplitWorkspace.tsx");
const everyStylesheet = [
  "agents-center.css",
  "chat.css",
  "environment.css",
  "octant.css",
  "shell.css",
  "surface.css",
].map(read);

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
    // The rail variant of the button draws no border, so the button is its
    // face and no negative margin gives a border back.
    expect(rule(shell, ".sidebar-rail__button")).not.toMatch(/margin/);
    expect(rule(usage, ".rail-usage__ring")).not.toMatch(/margin/);
    expect(source("ui/shadcn/button.tsx")).toMatch(/rail:\s*"[^"]*border-0/);
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
      /padding-inline:\s*calc\(var\(--oct-nav-inset\) - \(20px - var\(--oct-icon-md\)\) \/ 2\) var\(--oct-nav-inset\)/,
    );
  });

  it("centres the account row's 20px avatar on the centre line of the 16px navigation icons", () => {
    // 12px inset + 8px half an icon = 20px; the avatar starts at 12 - 2 = 10px
    // so its centre is the same 20px in from the row's start.
    expect(octant).toMatch(/--oct-nav-inset:\s*12px;/);
    expect(octant).toMatch(/--oct-icon-md:\s*16px;/);
    expect(rule(root, ".sidebar-profile .sidebar-item")).toMatch(
      /\(20px - var\(--oct-icon-md\)\) \/ 2/,
    );
  });

  it("makes every control height one of 24, 28, 32 and 44: tray segments, the rail's faces and the account row", () => {
    expect(octant).toMatch(/--oct-tray-segment-h:\s*24px;/);
    expect(octant).toMatch(/--oct-nav-head-h:\s*44px;/);
    expect(rule(octant, ".modeswitch .modeswitch__tray > .mode")).toMatch(
      /height:\s*var\(--oct-tray-segment-h\)/,
    );
    // Two pixels of padding around a 24px segment make every tray 28px tall.
    expect(rule(octant, ".modeswitch__tray")).toMatch(/padding:\s*2px;/);
    expect(toggleGroup).toContain("p-[2px]");
    expect(toggleGroup).toContain("h-[round(1.846rem,2px)]");
    expect(toggleGroup).not.toContain("h-[round(1.75rem,2px)]");
  });

  it("keeps a tray's inner corner on the tray's corner less its padding, never under 2px", () => {
    expect(rule(octant, ".modeswitch .modeswitch__tray > .mode")).toMatch(
      /border-radius:\s*max\(2px, calc\(var\(--oct-radius-sm\) - 2px\)\)/,
    );
    expect(rule(octant, ".segment")).toMatch(
      /border-radius:\s*max\(2px, calc\(var\(--oct-radius-sm\) - 2px\)\)/,
    );
  });

  it("centres the Project views' first button on the icon column, so its folder shares the rows' centre line", () => {
    expect(rule(code, ".code-project-views__inline")).toMatch(
      /padding:\s*0 4px 0\s+calc\(var\(--oct-nav-inset\) - \(var\(--oct-rail-button-h\) - var\(--oct-icon-md\)\) \/ 2\);/,
    );
  });

  it("ends the toast's dismiss button on the toast's own padding and keeps the action's line as tall as every other", () => {
    expect(rule(octant, ".toast")).toMatch(/padding:\s*var\(--oct-space-3\)/);
    const dismiss = rule(octant, ".toast__dismiss");
    expect(dismiss).toMatch(/margin:\s*0;/);
    expect(dismiss).toContain("var(--oct-toast-control-h)");
    expect(rule(octant, ".toast .toast-title")).toContain("min-height: var(--oct-toast-control-h)");
    expect(octant).toMatch(/--oct-toast-control-h:\s*24px;/);
    expect(dismiss).not.toMatch(/-\d+px/);
    expect(toast).toContain('size="icon-sm"');
    const action = rule(octant, ".toast .toast__action");
    expect(action).toMatch(/display:\s*inline;/);
    expect(action).toMatch(/min-height:\s*0;/);
  });

  it("keeps a phone's thread gutter at 20px, the width of the start screen's, by taking none from the column", () => {
    expect(octant).toMatch(/--oct-thread-gutter:\s*40px;/);
    expect(octant).toMatch(
      /@media \(max-width: 680px\) \{\s*:root \{\s*--oct-thread-gutter:\s*0px;/,
    );
    // The panel the column sits in is padded 20px at that width already.
    expect(root).toMatch(
      /@media \(max-width: 680px\)[\s\S]*?\.workspace-pane__panel \{\s*padding:\s*24px var\(--oct-space-5\);/,
    );
    for (const sheet of everyStylesheet) {
      expect(sheet).not.toMatch(/min\(100% - 40px, var\(--oct-(thread-measure|composer-width)\)\)/);
    }
    expect(rule(octant, ".composer.thread-composer")).toContain("100% - var(--oct-thread-gutter)");
    expect(rule(octant, ".thread-column")).toContain("var(--oct-thread-column)");
  });

  it("starts a thread's title text on the edge of the thread's column, with the mark and the request chip after it", () => {
    const header = rule(root, '.workspace-pane__header[data-header-kind="title"]');
    expect(header).toMatch(
      /--pane-title-edge:\s*max\(var\(--oct-space-5\), calc\(\(100% - var\(--oct-thread-column\)\) \/ 2\)\);/,
    );
    expect(header).toMatch(
      /--pane-title-start:\s*calc\(var\(--pane-title-edge\) - var\(--oct-space-1\) - 1px\);/,
    );
    expect(header).toMatch(/padding-left:\s*var\(--pane-title-start\);/);
    // A header with content tabs keeps the insets it had: the tabs lead it.
    expect(rule(root, ".workspace-pane__header")).toMatch(/padding:\s*2px 0 2px 4px;/);
    expect(splitWorkspace).toContain('data-header-kind={showTabs ? "tabs" : "title"}');
    expect(root).toMatch(
      /\.shell--sidebar-collapsed \.workspace-pane__header\[data-header-kind="title"\] \{\s*padding-left: max\(var\(--octant-window-chrome-leading-width, 148px\), var\(--pane-title-start\)\);/,
    );
    expect(root).toMatch(
      /\.shell--sidebar-collapsed \.workspace-pane__header \{\s*padding-left: var\(--octant-window-chrome-leading-width, 148px\);/,
    );
    const title = splitWorkspace.indexOf('className="oct-nav-name workspace-pane__title"');
    const afterTitle = splitWorkspace.indexOf("{gripMark}", title);
    expect(title).toBeGreaterThan(0);
    expect(afterTitle).toBeGreaterThan(title);
    expect(splitWorkspace.indexOf("{pullRequestChip}", title)).toBeGreaterThan(afterTitle);
  });

  it("reads the column's edge from one property, so the title and the transcript cannot drift", () => {
    expect(octant).toMatch(
      /:root,\s*\.shell \{\s*--oct-thread-column:\s*min\(100% - var\(--oct-thread-gutter\), var\(--oct-thread-measure\)\);/,
    );
    // The column and every transcript piece take the property as their width...
    expect(rule(octant, ".thread-column")).toContain("width: var(--oct-thread-column)");
    expect(rule(chat, ".thread-connection-notice")).toContain("width: var(--oct-thread-column)");
    expect(rule(shell, ".work-thread-workspace__transcript")).toContain(
      "width: var(--oct-thread-column)",
    );
    expect(rule(shell, ".work-thread-workspace__transcript-trail")).toContain(
      "width: var(--oct-thread-column)",
    );
    // ...and none re-derives it from the measure and the gutter.
    for (const sheet of [chat, shell, ...everyStylesheet]) {
      expect(sheet).not.toMatch(
        /width:\s*min\(100% - var\(--oct-thread-gutter\), var\(--oct-thread-measure\)\)/,
      );
    }
    expect(root).not.toMatch(/--oct-thread-measure/);
  });

  it("gives Settings one rhythm: a 32px gutter on the band, 24px between sections, 48px under the last", () => {
    expect(rule(settings, ".settings-section-stack")).toMatch(/gap:\s*var\(--oct-space-6\)/);
    expect(rule(settings, ".settings-view__content-inner")).toMatch(
      /padding:\s*var\(--oct-space-12\) var\(--oct-settings-gutter\) var\(--oct-space-12\)/,
    );
    expect(settings).toMatch(
      /\.settings-view__workspace-titlebar \{[^}]*padding:\s*0 var\(--oct-settings-gutter\);/,
    );
    expect(settings).not.toMatch(
      /settings-view--sheet \.settings-view__workspace-titlebar \{\s*padding-inline-end/,
    );
  });

  it("leaves 12px under a Settings label and 12px under its note, in whole pixels", () => {
    expect(settings).not.toMatch(/> h2:has\(\+ \.settings-section-note\) \{/);
    expect(settings).not.toMatch(/> \.settings-section-head:has\(\+ \.settings-section-note\) \{/);
    const note = settings.slice(
      settings.indexOf(".settings-view .settings-card-section--open > .settings-section-note {"),
    );
    const body = note.slice(0, note.indexOf("}"));
    expect(body).toMatch(/padding:\s*0 0 var\(--oct-space-3\)/);
    expect(body).toContain("line-height: var(--oct-line-detail)");
  });

  it("draws the title band's mark, the thread's disclosures, the rail's badge and the thinking rule in the one hairline", () => {
    expect(rule(root, ".environment-mark")).toMatch(/border:\s*1px solid var\(--oct-hairline\)/);
    expect(rule(components, ".turn-activity__disclosure + .turn-activity__disclosure")).toContain(
      "1px solid var(--oct-hairline)",
    );
    expect(
      rule(components, ".turn-activity__toolchain > .turn-activity__disclosure:first-child"),
    ).toContain("1px solid var(--oct-hairline)");
    expect(rule(shell, ".sidebar-rail__badge")).toMatch(
      /border:\s*1px solid var\(--oct-hairline\)/,
    );
    expect(rule(shell, ".sidebar-rail__divider")).toMatch(/background:\s*var\(--oct-hairline\)/);
  });

  it("draws the rule beside reasoning at 1px in the strong border, which reads where the hairline did not", () => {
    // A reasoning rule is thin, not a 2px quote bar; the hairline was 1.2:1.
    expect(rule(octant, ".thinking")).toMatch(
      /border-left:\s*1px solid var\(--octant-border-strong\)/,
    );
    expect(rule(components, ".turn-activity__thinking-body")).toMatch(
      /border-left:\s*1px solid var\(--octant-border-strong\)/,
    );
  });

  it("paints a slider's track in the strong divider role, which holds 3:1 on a card in dark and light", () => {
    // The control fill is the card's own colour in dark, the soft ink was
    // 1.2:1 against it and the stronger hairline 1.5:1.
    expect(slider).toContain("bg-(--octant-divider-strong)");
    expect(slider).not.toContain("bg-(--oct-hairline-strong)");
    expect(slider).not.toContain("bg-(--oct-fg-soft)");
    expect(slider).not.toContain("bg-secondary");
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
