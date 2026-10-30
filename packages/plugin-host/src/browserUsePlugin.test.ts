import { describe, expect, it } from "vitest";
import {
  BROWSER_USE_PLUGIN,
  BROWSER_TOOL_HOST_LINE,
  browserUseSelection,
  isBrowserUseSelection,
  validateBrowserUseSelection,
} from "./browserUsePlugin";

describe("Browser use selection", () => {
  it("pins the host-owned Browser plugin identity", () => {
    const selection = browserUseSelection("composer");
    expect(BROWSER_USE_PLUGIN.slug).toBe("browser");
    expect(isBrowserUseSelection(selection)).toBe(true);
    expect(validateBrowserUseSelection(selection)).toBe(true);
    if (selection.kind !== "plugin") throw new Error("expected plugin selection");
    expect(
      validateBrowserUseSelection({
        ...selection,
        packageId: "00000000-0000-0000-0000-000000000000" as never,
      }),
    ).toBe(false);
  });

  it("keeps the Browser host line within 40 tokens", () => {
    expect(BROWSER_TOOL_HOST_LINE).toContain("octant_browser");
    expect(Math.ceil(BROWSER_TOOL_HOST_LINE.length / 4)).toBeLessThanOrEqual(40);
  });
});
