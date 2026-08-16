import { describe, expect, it } from "vitest";
import { formatScreenshotSafeLabel } from "./screenshotSafeLabel";

describe("formatScreenshotSafeLabel", () => {
  it("passes ordinary titles through", () => {
    expect(formatScreenshotSafeLabel("Ship the preview")).toBe("Ship the preview");
  });

  it("scrubs secretish and path-bearing titles", () => {
    expect(formatScreenshotSafeLabel("rotate sk-live-secret")).toBe(
      "Details available on the host.",
    );
    expect(formatScreenshotSafeLabel("edit /Users/example/code/app")).toBe(
      "Details available on the host.",
    );
  });
});
