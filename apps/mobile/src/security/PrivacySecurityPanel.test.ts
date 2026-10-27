import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../design-system/theme";
import { PrivacySecurityPanel } from "./PrivacySecurityPanel";
import { createUnavailableDeviceIntegrityPort } from "./deviceIntegrityPort";
import { createSecureWindowScreenshotPrivacyPort } from "./deviceProtectionModule";
import { createUnavailableKeyStorageProtectionPort } from "./keyStorageProtectionPort";
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
          keyStorage: createUnavailableKeyStorageProtectionPort(),
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

  it("on iOS names what the protection covers and that a screenshot is not blocked", () => {
    const markup = renderToStaticMarkup(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(PrivacySecurityPanel, {
          hostHealth: "ready",
          integrity: createUnavailableDeviceIntegrityPort(),
          keyStorage: createUnavailableKeyStorageProtectionPort(),
          screenshotPrivacy: createSecureWindowScreenshotPrivacyPort(
            { setSecureWindow: async () => "applied", keyStorageProtection: async () => "unknown" },
            "app-switcher-and-recording",
          ),
        }),
      }),
    );

    expect(markup).toContain("The app switcher and a recorded or mirrored screen show no Octant");
    expect(markup).toContain("iOS cannot block a screenshot");
    expect(markup).not.toContain("Screenshots, screen recordings");
    expect(markup).toContain("Use standard capture");
  });
});
