import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = join(process.cwd(), "src");

function sourceFiles(directory: string, suffix: string): ReadonlyArray<string> {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path, suffix));
    else if (entry.endsWith(suffix) && !entry.includes(".test.")) found.push(path);
  }
  return found;
}

// A selector that is inherently round: nothing here is a button, a field, a
// tab, a menu row, or a chip. A control takes the control radius instead, so a
// rule that reaches for the pill token or a circle on one of those fails below
// until it is moved to `--oct-radius-sm`.
const ROUND_SELECTORS: ReadonlyArray<string> = [
  // Switches and radio buttons.
  "input.switch",
  "input.switch::after",
  "input.switch:checked::after",
  '.octant-switch[data-slot="switch"]',
  '.octant-switch[data-slot="switch"] > [data-slot="switch-thumb"]',
  ".canvas-mockup__switch",
  ".canvas-mockup__knob",
  '.check input[type="radio"]',
  '.check input[type="radio"]:checked::after',
  ".device-pick__radio",
  // Avatars and monogram glyphs.
  ".avatar",
  ".user-avatar",
  ".skeleton-circle",
  ".canvas-mockup__avatar",
  ".provider-glyph--monogram",
  // Status dots, live marks and unread marks.
  ".tag .dot",
  ".statuslist .dot",
  ".st",
  ".filetab .dirty",
  '.dock-tool-buttons__button[data-dock-open="true"]::after',
  ".chart-dot",
  ".screen-live::before",
  ".pool li::before",
  ".ckpt::before",
  ".prov-state::before",
  ".mrow-dot",
  ".tabitem .dot-badge",
  ".endpoint-state__dot",
  ".host-selector__dot",
  ".browser-workspace__server-dot",
  ".computers-card__dot",
  ".dock-card__dot",
  ".library__dot",
  ".project-tile__dot",
  ".work-list__active-dot",
  ".device-dot",
  ".canvas-block__summary-dot",
  ".canvas-block__note::before",
  ".canvas-design__running-dot",
  ".chat-composer__model-options-dot",
  ".board-status-mark__dot",
  ".content-tab__attention",
  ".settings-accent__dot",
  ".thread-activity-pip__pulse",
  ".code-project-views__color-dot",
  ".code-overview__lifecycle-mark",
  ".code-debug-breakpoint::before, .code-debug-breakpoint-unresolved::before",
  '.sidebar-navigation__thread-status[data-activity="unread"]::before',
  ".code-home__row .code-home__badge::before",
  '.pull-request-chip[data-checks="failing"]::before, .pull-request-chip[data-checks="pending"]::before',
  '.inbox-view__row[data-unseen="true"] .oct-row-label::after',
  ".composer-model-picker__rail-accent",
  ".composer-model-picker__rail-status",
  ".composer-model-picker__level-stops > span",
  ".thread-task-viewer__mark",
  '.thread-task-viewer__steps > li[data-step-status="in-progress"] .thread-task-viewer__mark::after',
  // Count badges and numbered marks.
  ".bell .bell-count",
  ".browser-pip__count",
  ".code-board__filter-count",
  ".sidebar-rail__badge",
  ".first-run__rail-marker",
  ".endpoint-flow__step-number",
  ".provider-catalog__step-marker",
  ".library__step-mark",
  ".canvas-flow-board__callout",
  ".canvas-mockup__callout-mark",
  ".settings-app-background__preset-mark",
  // Spinners.
  ".spinner",
  ".device-spinner",
  ".device-touch",
  // Round colour swatches.
  ".browser-markup__swatch",
  ".claude-account-accent-picker__swatch",
  ".provider-history__swatch",
  // Meters, progress bars, and their fills.
  ".meter",
  ".ctxmeter",
  ".range",
  ".zen-timer-bar",
  ".context-window-popover__meter",
  ".context-window-popover__limit-meter",
  ".computers-card__track",
  ".composer-model-picker__level-track",
  ".composer-model-picker__reasoning-slider::-webkit-slider-runnable-track",
  ".composer-model-picker__reasoning-slider::-moz-range-track",
  ".canvas-mockup__progress-track, .canvas-mockup__slider-track",
  ".canvas-mockup__progress-fill",
  ".canvas-ref__progress-track",
  ".canvas-ref__progress-fill",
  ".goal-loop__burn-bar",
  ".dock-card__bar",
  ".environment-move__bar",
  ".thread-move-frozen__progress",
  ".rail-usage__bar",
  ".plan-usage__bar--smooth",
  ".provider-limits__window meter",
  ".provider-limits__window meter::-webkit-meter-bar",
  ".provider-limits__window meter::-webkit-meter-optimum-value",
  ".provider-limits__window meter::-moz-meter-bar",
  // A slider's thumb, a scrollbar's thumb, and a sheet's grabber.
  ".range::-webkit-slider-thumb",
  ".range::-moz-range-thumb",
  ".octant-slider::-webkit-slider-thumb",
  ".octant-slider::-moz-range-thumb",
  ".canvas-mockup__slider-knob",
  ":where(*)::-webkit-scrollbar-thumb",
  ".monaco-scrollable-element > .scrollbar > .slider",
  ".bsheet-grip",
];

// The stylesheet blocks whose declaration reaches for a circle or the pill.
// It reads the shorthand (with a `/` second radius), the physical corner
// longhands (`border-top-left-radius`) and the logical ones
// (`border-start-start-radius`).
const roundDeclaration =
  /border(?:-[a-z]+-[a-z]+)?-radius:\s*[^;]*(?:--oct-radius-pill|\b9999?9px\b|\b50%|\b100%)/;

function roundBlocks(css: string): ReadonlyArray<string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: string[] = [];
  const hits: string[] = [];
  let buffer = "";
  for (const char of stripped) {
    if (char === "{") {
      stack.push(buffer.replace(/\s+/g, " ").trim());
      buffer = "";
    } else if (char === "}") {
      const selector = stack.pop() ?? "";
      if (roundDeclaration.test(buffer)) hits.push(selector);
      buffer = "";
    } else buffer += char;
  }
  return hits;
}

describe("what is allowed to be round", () => {
  it("rounds a control at the control radius and only inherently round things at the pill or a circle", () => {
    const allowed = new Set(ROUND_SELECTORS);
    const stray: string[] = [];
    for (const path of sourceFiles(webRoot, ".css")) {
      for (const selector of roundBlocks(readFileSync(path, "utf8"))) {
        if (!allowed.has(selector)) stray.push(`${relative(webRoot, path)}: ${selector}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("keeps every allow-listed selector alive, so the list cannot outlive what it names", () => {
    const seen = new Set<string>();
    for (const path of sourceFiles(webRoot, ".css")) {
      for (const selector of roundBlocks(readFileSync(path, "utf8"))) seen.add(selector);
    }
    expect(ROUND_SELECTORS.filter((selector) => !seen.has(selector))).toEqual([]);
  });

  it("uses the pill token and 9999px for nothing but the token's own definition", () => {
    const literal = /\b9999?9px\b/;
    const offenders = sourceFiles(webRoot, ".css")
      .filter((path) => literal.test(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")))
      .map((path) => relative(webRoot, path));
    expect(offenders).toEqual(["styles/octant.css"]);
    const octant = readFileSync(join(webRoot, "styles/octant.css"), "utf8");
    expect(octant.match(/\b9999?9px\b/g)).toHaveLength(1);
  });

  it("sees every spelling of a round corner", () => {
    for (const declaration of [
      "border-radius: var(--oct-radius-pill)",
      "border-radius: 4px / 50%",
      "border-radius: 9999px 0 0 9999px",
      "border-top-left-radius: 50%",
      "border-start-start-radius: var(--oct-radius-pill)",
      "border-end-end-radius: 9999px",
    ]) {
      expect(roundBlocks(`.x { ${declaration}; }`), declaration).toEqual([".x"]);
    }
    expect(roundBlocks(".x { border-radius: var(--oct-radius-sm); }")).toEqual([]);
  });

  it("gives a recipe the full round class only for a switch (2), a slider (1), and a colour swatch (1), counted per file", () => {
    const full = /\brounded(?:-[a-z]+)?-full\b|\brounded(?:-[a-z]+)?-\[(?:9999?9px|50%|100%)\]/g;
    const counts: Record<string, number> = {};
    for (const path of [...sourceFiles(webRoot, ".tsx"), ...sourceFiles(webRoot, ".ts")]) {
      const found = readFileSync(path, "utf8").match(full);
      if (found) counts[relative(webRoot, path)] = found.length;
    }
    expect(counts).toEqual({
      "profile/ProfileEditor.tsx": 1,
      "ui/shadcn/slider.tsx": 1,
      "ui/shadcn/switch.tsx": 2,
    });
  });
});
