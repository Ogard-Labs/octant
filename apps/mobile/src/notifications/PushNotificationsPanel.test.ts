import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../design-system/theme";
import { PushNotificationsPanel } from "./PushNotificationsPanel";
import { createUnavailableNotificationPermissionPort } from "./notificationPermissionPort";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
}));

describe("mobile notification settings", () => {
  it("explains unavailable push without offering to request permission", () => {
    const markup = renderToStaticMarkup(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(PushNotificationsPanel, {
          transport: undefined,
          permission: createUnavailableNotificationPermissionPort(),
        }),
      }),
    );

    expect(markup).toContain("Push notifications are unavailable in this build.");
    expect(markup).toContain("Open Octant to check for updates");
    expect(markup).not.toContain("Enable on this host");
    expect(markup).not.toContain("permission was not granted");
    expect(markup).not.toContain("Clear token on this host");
  });
});
