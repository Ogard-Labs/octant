import { describe, expect, it } from "vitest";
import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_ROLES,
  getDefaultToken,
  getRoleDefinition,
  isKnownThemeTokenRole,
} from "./tokens";
import { parseHexColor } from "./color";
import { meetsContrast } from "./contrast";

describe("theme semantic token catalog", () => {
  it("covers every required token category from the approved design", () => {
    const categories = new Set(THEME_TOKEN_ROLES.map((role) => role.category));
    expect(categories).toContain("foundation");
    expect(categories).toContain("surface");
    expect(categories).toContain("control");
    expect(categories).toContain("border");
    expect(categories).toContain("text");
    expect(categories).toContain("focus");
    expect(categories).toContain("accent");
    expect(categories).toContain("status");
    expect(categories).toContain("diff");
    expect(categories).toContain("palette");
  });

  it("covers application foundation, navigation, editor, terminal, diff, focus, and status surfaces", () => {
    const ids = new Set(THEME_TOKEN_ROLES.map((role) => role.id));
    for (const required of [
      "app-background",
      "chrome",
      "sidebar",
      "workspace",
      "floating",
      "border",
      "text-primary",
      "text-secondary",
      "text-muted",
      "focus-ring",
      "selection",
      "accent",
      "accent-foreground",
      "success-text",
      "warning-text",
      "danger-text",
      "addition-text",
      "deletion-text",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("publishes unique role ids", () => {
    const ids = THEME_TOKEN_ROLES.map((role) => role.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("provides valid six-digit hex defaults for every role in both modes", () => {
    for (const role of THEME_TOKEN_ROLES) {
      expect(() => parseHexColor(role.defaultLight)).not.toThrow();
      expect(() => parseHexColor(role.defaultDark)).not.toThrow();
    }
  });

  it("default token maps match the catalog defaults", () => {
    for (const role of THEME_TOKEN_ROLES) {
      expect(DEFAULT_LIGHT_TOKENS[role.id]).toBe(role.defaultLight);
      expect(DEFAULT_DARK_TOKENS[role.id]).toBe(role.defaultDark);
    }
  });

  it("resolves default tokens by mode", () => {
    expect(getDefaultToken("accent", "light")).toBe(getRoleDefinition("accent").defaultLight);
    expect(getDefaultToken("accent", "dark")).toBe(getRoleDefinition("accent").defaultDark);
  });

  it("uses the design system's warm charcoal-and-brass palette in both modes", () => {
    expect(DEFAULT_LIGHT_TOKENS).toMatchObject({
      "app-background": "#edece7",
      workspace: "#f2f1ed",
      floating: "#e6e5e0",
      "text-primary": "#26251e",
      accent: "#d9a441",
      "accent-foreground": "#14130f",
      "accent-text": "#8a6218",
    });
    expect(DEFAULT_DARK_TOKENS).toMatchObject({
      "app-background": "#0e0d0a",
      workspace: "#14130f",
      floating: "#1c1b16",
      "text-primary": "#f2f1ed",
      accent: "#d9a441",
      "accent-foreground": "#14130f",
      "accent-text": "#d9a441",
    });
  });

  it("keeps the brass accent fill constant across modes while accent-as-text darkens for light", () => {
    expect(DEFAULT_LIGHT_TOKENS["accent"]).toBe(DEFAULT_DARK_TOKENS["accent"]);
    expect(DEFAULT_LIGHT_TOKENS["accent-text"]).not.toBe(DEFAULT_LIGHT_TOKENS["accent"]);
    expect(DEFAULT_DARK_TOKENS["accent-text"]).toBe(DEFAULT_DARK_TOKENS["accent"]);
  });

  it("contrast targets reference known roles", () => {
    for (const role of THEME_TOKEN_ROLES) {
      if (role.contrastTarget !== undefined) {
        expect(isKnownThemeTokenRole(role.contrastTarget)).toBe(true);
      }
    }
  });

  it("keeps every palette choice legible on the sidebar in both modes", () => {
    const palette = THEME_TOKEN_ROLES.filter((role) => role.category === "palette");
    expect(palette.map((role) => role.id)).toEqual([
      "palette-red",
      "palette-orange",
      "palette-yellow",
      "palette-green",
      "palette-teal",
      "palette-blue",
      "palette-purple",
      "palette-pink",
    ]);
    for (const role of palette) {
      expect(role.contrastTarget).toBe("sidebar");
      expect(role.defaultLight).not.toBe(role.defaultDark);
      expect(meetsContrast(role.defaultLight, DEFAULT_LIGHT_TOKENS["sidebar"]!, "ui")).toBe(true);
      expect(meetsContrast(role.defaultDark, DEFAULT_DARK_TOKENS["sidebar"]!, "ui")).toBe(true);
    }
  });

  it("keeps accent legible as text through the dedicated accent-text role", () => {
    const role = getRoleDefinition("accent-text");
    expect(role.category).toBe("accent");
    expect(role.contrastTarget).toBe("workspace");
    expect(role.contrastLevel).toBe("normal-text");
    expect(
      meetsContrast(role.defaultLight, DEFAULT_LIGHT_TOKENS["workspace"]!, "normal-text"),
    ).toBe(true);
    expect(meetsContrast(role.defaultDark, DEFAULT_DARK_TOKENS["workspace"]!, "normal-text")).toBe(
      true,
    );
  });

  it("holds danger text to normal-text contrast on the floating surface it actually sits on", () => {
    const role = getRoleDefinition("danger-text");
    expect(role.contrastTarget).toBe("floating");
    expect(meetsContrast(role.defaultLight, DEFAULT_LIGHT_TOKENS["floating"]!, "normal-text")).toBe(
      true,
    );
    expect(meetsContrast(role.defaultDark, DEFAULT_DARK_TOKENS["floating"]!, "normal-text")).toBe(
      true,
    );
  });

  it("rejects unknown token roles", () => {
    expect(isKnownThemeTokenRole("accent")).toBe(true);
    expect(isKnownThemeTokenRole("unknown-role")).toBe(false);
    expect(() => getRoleDefinition("unknown-role")).toThrow();
  });
});
