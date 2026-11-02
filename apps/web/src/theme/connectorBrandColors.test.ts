import { describe, expect, it } from "vitest";
import { CONNECTOR_LOGOS } from "../extensions/connectorLogos";
import { CONNECTOR_BRAND_COLORS, connectorLogoInks } from "./connectorBrandColors";

describe("connector brand colours", () => {
  it("records a brand colour for every bundled mark", () => {
    for (const id of Object.keys(CONNECTOR_LOGOS)) {
      expect(CONNECTOR_BRAND_COLORS[id], id).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps a near-black mark in the ink colour in the dark theme, and a pale one in the light theme", () => {
    expect(connectorLogoInks("vercel").dark).toBeUndefined();
    expect(connectorLogoInks("vercel").light).toBe("#000000");
    expect(connectorLogoInks("intercom").light).toBeUndefined();
    expect(connectorLogoInks("intercom").dark).toBe("#6afdef");
  });

  it("draws a mark that reads on both tiles in its brand colour in both themes", () => {
    expect(connectorLogoInks("stripe")).toEqual({ light: "#635bff", dark: "#635bff" });
  });

  it("uses the ink for a connector with no recorded colour", () => {
    expect(connectorLogoInks("unknown")).toEqual({ light: undefined, dark: undefined });
  });
});
