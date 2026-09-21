import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../design-system/theme";
import { PrivacySecurityPanel } from "./PrivacySecurityPanel";
import { createUnavailableDeviceIntegrityPort } from "./deviceIntegrityPort";
import { createUnavailableScreenshotPrivacyPort } from "./screenshotPrivacyPort";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
}));

describe("mobile privacy settings", () => {
  it("explains unavailable capture protection before offering a privacy preference", () => {
    const markup = renderToStaticMarkup(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(PrivacySecurityPanel, {
          hostHealth: "ready",
          integrity: createUnavailableDeviceIntegrityPort(),
          screenshotPrivacy: createUnavailableScreenshotPrivacyPort(),
        }),
      }),
    );

    expect(markup).toContain(
      "Screenshot and app-switcher protection is unavailable in this build.",
    );
    expect(markup).not.toContain("Hide in recents");
    expect(markup).not.toContain("Use standard capture");
    expect(markup).not.toContain("Push and recents stay redacted");
  });
});
