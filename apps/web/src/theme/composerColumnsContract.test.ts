import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(import.meta.dirname, "../styles/octant.css"), "utf8");
const chat = readFileSync(resolve(import.meta.dirname, "../styles/chat.css"), "utf8");

function rule(selector: string): string {
  const from = styles.indexOf(`\n${selector} {`);
  expect(from).toBeGreaterThanOrEqual(0);
  return styles.slice(from, styles.indexOf("}", from));
}

describe("the composer's columns", () => {
  it("derives the box's buttons and the row's cells from one cell token, so the row cannot drift from the box", () => {
    expect(styles).toMatch(/--oct-composer-cell:\s*28px;/);
    for (const selector of [
      '.composer-field__attach button[data-size="icon"],\n.composer-field__actions button[data-size="icon"]',
      ".composer-place__icon",
      ".composer-row",
    ]) {
      const body = rule(selector);
      expect(body).toContain("var(--oct-composer-cell)");
      expect(body).not.toMatch(/\b28px/);
    }
  });

  it("derives the row's inset and its text edge from the box's inset and gap", () => {
    expect(rule(".composer-field")).toContain("var(--oct-composer-inset)");
    expect(rule(".composer-field")).toContain("var(--oct-composer-gap)");
    expect(rule(".composer-place")).toContain("var(--oct-composer-gap)");
    expect(styles).toMatch(
      /\.composer-frame:not\(\.composer-frame--held\) > :is\(\.composer-start, \.composer-under\) \{\s*padding-inline: var\(--oct-composer-inset\)/,
    );
  });

  it("places the info panel against the row, not its trigger, so it stays inside the composer", () => {
    expect(rule(".composer-under")).toContain("position: relative");
    expect(rule(".thread-info")).toContain("position: static");
    expect(rule(".thread-info__panel")).toMatch(/left: 0;/);
  });

  it("starts the row on the same column in every mode: an empty leading group takes no gap", () => {
    // Chat's row opened with an empty group that still took the row's 4px gap, so
    // its first control stood 4px right of Code's (439.9 against 435.9) while the
    // prompt's text edge was the same.
    expect(chat).toMatch(/\.chat-composer__leading:empty \{\s*display: none;/);
    expect(rule(".composer-row")).not.toMatch(/padding/);
    expect(rule(".composer-under")).toMatch(/padding: 0;/);
  });

  it("makes the box's one line a whole number of pixels, so its cells centre on whole pixels", () => {
    // 28px cell + two 8px insets is the 44px box; the prompt's line is rounded to
    // an even pixel so the centring margin is whole at any transcript size.
    expect(rule(".composer-input")).toMatch(/round\(\s*nearest,[^;]*2px\s*\)/);
    expect(rule(".composer-field")).toMatch(/--oct-composer-line:\s*round\(/);
  });

  it("stands a thread's composer and its text column the same gutter from a phone's edges", () => {
    // The panel is padded 20px at 680px and below, so the composer and the
    // column each take the one gutter token, which is 0 there: 20px each side
    // at 390, 430 and 680 as on the start screen, not 40.
    expect(rule(".composer.thread-composer")).toContain("min(100% - var(--oct-thread-gutter)");
    expect(styles).toMatch(/--oct-thread-column:\s*min\(100% - var\(--oct-thread-gutter\)/);
    expect(rule(".thread-column")).toContain("var(--oct-thread-column)");
    expect(styles).toMatch(
      /@media \(max-width: 680px\) \{\s*:root \{\s*--oct-thread-gutter:\s*0px;/,
    );
    // Wider layouts keep the 20px each side the column always had.
    expect(styles).toMatch(/--oct-thread-gutter:\s*40px;/);
  });
});
