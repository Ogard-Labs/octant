import { describe, expect, it } from "vitest";
import {
  BROWSER_USE_PLUGIN,
  BROWSER_SELECTION_GUIDANCE,
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
    expect(BROWSER_SELECTION_GUIDANCE).toContain("octant_browser");
    if (selection.kind !== "plugin") throw new Error("expected plugin selection");
    expect(
      validateBrowserUseSelection({
        ...selection,
        packageId: "00000000-0000-0000-0000-000000000000" as never,
      }),
    ).toBe(false);
  });
});
