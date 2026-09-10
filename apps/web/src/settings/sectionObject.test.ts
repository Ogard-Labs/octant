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
  it("builds its card from its content children, leaving the label on the page", () => {
    // The label and its one-line description read as the section's title, so
    // they stay out on the page ground; the card is the content under them.
    expect(rule(".settings-card-section")).toMatch(/border:\s*0/);
    const sides = rule(".settings-card-section > h2 ~ *:not(.settings-section-note)");
    expect(sides).toMatch(/border-inline:\s*1px solid var\(--oct-hairline\)/);
    expect(sides).toMatch(/background:\s*var\(--oct-surface\)/);
  });

  it("closes the card at the top and the bottom, rounded", () => {
    const top = rule(
      ".settings-card-section > h2 + *:not(.settings-section-note),\n.settings-card-section > .settings-section-note + *",
    );
    expect(top).toMatch(/border-top:\s*1px solid var\(--oct-hairline\)/);
    expect(top).toMatch(/border-start-start-radius:\s*var\(--oct-radius-lg\)/);
    const bottom = rule(".settings-card-section > h2 ~ *:last-child:not(.settings-section-note)");
    expect(bottom).toMatch(/border-bottom:\s*1px solid var\(--oct-hairline\)/);
    expect(bottom).toMatch(/border-end-end-radius:\s*var\(--oct-radius-lg\)/);
  });

  it("keeps its overflow visible, because its rows hold menus that escape it", () => {
    expect(rule(".settings-card-section")).toMatch(/overflow:\s*visible/);
  });

  it("holds every child off that edge, not only the rows", () => {
    const body = rule(
      ".settings-card-section > h2 ~ *:not(.settings-section-note),\n.settings-card-section > .setgroup > *,\n.settings-card-section > .provider-settings__form > *",
    );
    expect(body).toMatch(/padding-inline:\s*var\(--oct-space-5\)/);
    // A wrapper passes the inset through rather than adding a second one.
    expect(
      rule(
        ".settings-card-section > .setgroup,\n.settings-card-section > .provider-settings__form",
      ),
    ).toMatch(/padding-inline:\s*0/);
  });

  it("is not un-carded again by a later rule at the same specificity", () => {
    // Every section carries `--open`. It used to reset the fill and the radius,
    // which at equal specificity beat the base rule and flattened all
    // seventeen destinations while the base rule still read correctly.
    const body = rule(".settings-card-section--open");
    expect(body).not.toMatch(/border-radius:\s*0/);
  });

  it("leaves the group inside it unboxed, so the edges do not double up", () => {
    const body = rule(".setgroup");
    expect(body).toMatch(/border:\s*0/);
    expect(body).toMatch(/background:\s*transparent/);
  });
});
