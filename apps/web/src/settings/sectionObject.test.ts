import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");

/**
 * Rules whose selector mentions `.settings-card-section`, as bodies. The card
 * is assembled from its content children (0109), and the selectors that pick
 * those children have been reshaped several times to cover a second heading
 * level and each panel's own description class. Asserting on what the rules
 * *set* rather than on their exact text keeps this honest without pinning a
 * selector that is expected to grow.
 */
function sectionRules(): ReadonlyArray<string> {
  const bodies: string[] = [];
  const pattern = /([^{}]*\.settings-card-section[^{}]*)\{([^}]*)\}/g;
  for (const match of styles.matchAll(pattern)) {
    const selector = match[1] ?? "";
    if (selector.includes("@")) continue;
    bodies.push(match[2] ?? "");
  }
  return bodies;
}

function someRuleSets(declaration: RegExp): boolean {
  return sectionRules().some((body) => declaration.test(body));
}

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

  it("builds the card out of its content children", () => {
    expect(someRuleSets(/border-inline:\s*1px solid var\(--oct-hairline\)/)).toBe(true);
    expect(someRuleSets(/background:\s*var\(--oct-surface\)/)).toBe(true);
  });

  it("closes that card at the top and the bottom, rounded", () => {
    expect(someRuleSets(/border-top:\s*1px solid var\(--oct-hairline\)/)).toBe(true);
    expect(someRuleSets(/border-start-start-radius:\s*var\(--oct-radius-lg\)/)).toBe(true);
    expect(someRuleSets(/border-bottom:\s*1px solid var\(--oct-hairline\)/)).toBe(true);
    expect(someRuleSets(/border-end-end-radius:\s*var\(--oct-radius-lg\)/)).toBe(true);
  });

  it("holds its content off that edge", () => {
    expect(someRuleSets(/padding-inline:\s*var\(--oct-space-5\)/)).toBe(true);
  });

  it("keeps its overflow visible, because its rows hold menus that escape it", () => {
    expect(rule(".settings-card-section")).toMatch(/overflow:\s*visible/);
  });

  it("is not un-carded again by a later rule at the same specificity", () => {
    // Every section carries `--open`. It used to reset the fill and the radius,
    // which at equal specificity beat the base rule and flattened all
    // seventeen destinations while the base rule still read correctly.
    expect(rule(".settings-card-section--open")).not.toMatch(/border-radius:\s*0/);
  });

  it("leaves the group inside it unboxed, so the edges do not double up", () => {
    const body = rule(".setgroup");
    expect(body).toMatch(/border:\s*0/);
    expect(body).toMatch(/background:\s*transparent/);
  });
});
