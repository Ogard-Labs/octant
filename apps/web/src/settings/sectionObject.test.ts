import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "s").exec(styles);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return match[1] ?? "";
}

describe("a settings section", () => {
  it("leaves the label on the page rather than boxing the whole section", () => {
    const body = rule(".settings-card-section");
    expect(body).toMatch(/border:\s*0/);
    expect(body).toMatch(/background:\s*transparent/);
  });

  it("leaves the base row group unboxed for first run, which shares it outside Settings", () => {
    // Settings draws its card under `.settings-view`; the unscoped rule is what
    // the first-run wizard still reads.
    const body = rule(".settings-card-section--open > .setgroup");
    expect(body).toMatch(/padding:\s*0/);
    expect(body).toMatch(/border:\s*0/);
    expect(body).toMatch(/background:\s*transparent/);
    expect(styles).not.toMatch(/border-inline:\s*1px solid/);
  });

  it("groups a section's rows in one card: the card radius, one hairline, a raised fill, no shadow", () => {
    const flat = styles.replace(/\s+/g, " ");
    const card =
      /\.settings-view \.settings-card-section--open > :is\(\.setgroup, \.settings-fact-list, \.settings-panel__body\) \{([^}]*)\}/.exec(
        flat,
      )?.[1] ?? "";
    expect(card).toMatch(/background:\s*var\(--oct-settings-card-fill\)/);
    expect(card).toMatch(/border:\s*1px solid var\(--oct-hairline\)/);
    expect(card).toMatch(/border-radius:\s*var\(--oct-radius-md\)/);
    expect(card).toMatch(/box-shadow:\s*none/);
    // Menus and popovers inside a row have to escape the card, so it never clips.
    expect(card).toMatch(/overflow:\s*visible/);
    expect(card).not.toMatch(/overflow:\s*hidden/);
    expect(flat).toMatch(
      /--oct-settings-card-fill: color-mix\(in oklab, var\(--oct-fg\) 3%, var\(--oct-bg\)\)/,
    );
  });

  it("rounds the first and last row to the card instead of clipping them", () => {
    const flat = styles.replace(/\s+/g, " ");
    expect(flat).toMatch(/> :first-child \{ border-start-start-radius: inherit;/);
    expect(flat).toMatch(/> :last-child \{ border-end-start-radius: inherit;/);
  });

  it("divides rows with a hairline inset 16px from the card's edges", () => {
    const flat = styles.replace(/\s+/g, " ");
    expect(flat).toMatch(/--oct-settings-row-inset: 16px/);
    expect(flat).toMatch(
      /> :is\(\.setgroup, \.settings-fact-list\) > \* \+ \* \{ background-image: linear-gradient\(var\(--oct-hairline\), var\(--oct-hairline\)\);[^}]*background-size: calc\(100% - 2 \* var\(--oct-settings-row-inset\)\) 1px;/,
    );
  });

  it("gives a row 52px and a 16px inset", () => {
    const flat = styles.replace(/\s+/g, " ");
    expect(flat).toMatch(
      /\.setgroup > \.setgroup-note \+ \.setrow \{ min-height: 52px; padding: var\(--oct-space-3\) var\(--oct-space-4\);/,
    );
  });

  it("keeps its overflow visible, because its rows hold menus that escape it", () => {
    expect(rule(".settings-card-section")).toMatch(/overflow:\s*visible/);
  });

  it("leaves the group inside it unboxed, so the edges do not double up", () => {
    const body = rule(".setgroup");
    expect(body).toMatch(/border:\s*0/);
    expect(body).toMatch(/background:\s*transparent/);
  });
});
