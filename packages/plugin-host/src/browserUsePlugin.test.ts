import { describe, expect, it } from "vitest";
import { BROWSER_USE_PLUGIN, browserUseSelection, isBrowserUseSelection } from "./browserUsePlugin";

describe("Browser use selection", () => {
  it("pins the host-owned Browser plugin identity", () => {
    const selection = browserUseSelection("composer");
    expect(BROWSER_USE_PLUGIN.slug).toBe("browser");
    expect(isBrowserUseSelection(selection)).toBe(true);
    expect(isBrowserUseSelection({ ...selection, packageId: "00000000-0000-0000-0000-000000000000" as never })).toBe(false);
  });
});
