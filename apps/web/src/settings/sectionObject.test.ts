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

  it("keeps routine row groups on the page ground", () => {
    const body = rule(".settings-card-section--open > .setgroup");
    expect(body).toMatch(/padding:\s*0/);
    expect(body).toMatch(/border:\s*0/);
    expect(body).toMatch(/background:\s*transparent/);
    expect(styles).not.toMatch(/border-inline:\s*1px solid/);
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
