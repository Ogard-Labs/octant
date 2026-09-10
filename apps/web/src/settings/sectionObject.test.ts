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
  it("draws its own edge over the surface fill", () => {
    const body = rule(".settings-card-section");
    expect(body).toMatch(/border:\s*1px solid var\(--oct-hairline\)/);
    expect(body).toMatch(/border-radius:\s*var\(--oct-radius-lg\)/);
    expect(body).toMatch(/background:\s*var\(--oct-surface\)/);
  });

  it("keeps its overflow visible, because its rows hold menus that escape it", () => {
    expect(rule(".settings-card-section")).toMatch(/overflow:\s*visible/);
  });

  it("holds every child off that edge, not only the rows", () => {
    const body = rule(
      ".settings-card-section > *,\n.settings-card-section > .setgroup > *,\n.settings-card-section > .provider-settings__form > *",
    );
    expect(body).toMatch(/padding-inline:\s*var\(--oct-space-4\)/);
    // A wrapper passes the inset through rather than adding a second one.
    expect(
      rule(
        ".settings-card-section > .setgroup,\n.settings-card-section > .provider-settings__form",
      ),
    ).toMatch(/padding-inline:\s*0/);
  });

  it("leaves the group inside it unboxed, so the edges do not double up", () => {
    const body = rule(".setgroup");
    expect(body).toMatch(/border:\s*0/);
    expect(body).toMatch(/background:\s*transparent/);
  });
});
