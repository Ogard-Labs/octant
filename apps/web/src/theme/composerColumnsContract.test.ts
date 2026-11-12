import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(import.meta.dirname, "../styles/octant.css"), "utf8");

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
});
