import { render, screen } from "@testing-library/react";
import { defaultShellSettings } from "@octant/domain/shell-policy";
import { describe, expect, it, vi } from "vitest";

vi.mock("./SettingsView", () => ({
  SettingsView: (props: { readonly hostBridge?: unknown }) => (
    <div data-testid="settings-view">
      {props.hostBridge === undefined ? "Host bridge missing" : "Host bridge available"}
    </div>
  ),
}));

import { ShellSettingsSurface } from "./ShellSettingsSurface";

describe("ShellSettingsSurface host integration", () => {
  it("forwards the desktop host bridge to native-only settings", async () => {
    render(
      <ShellSettingsSurface
        agentRunSettingsClient={{} as never}
        announcement=""
        announcementSequence={0}
        automationNotificationClient={{} as never}
        chatController={{} as never}
        codeController={{} as never}
        diagnosticsExportClient={{} as never}
        discoveryController={{} as never}
        executionProfiles={null}
        extensionClient={{} as never}
        githubClient={{} as never}
        hostBridge={{ listOpenInApplications: vi.fn() } as never}
        hostControlClient={{} as never}
        isNarrow={false}
        nativeBoundsAvailable
        onBack={vi.fn()}
        onDeepLinkApplied={vi.fn()}
        onResetLayout={vi.fn()}
        onResetNativeBounds={vi.fn()}
        onSearchChange={vi.fn()}
        onSettingsChange={vi.fn()}
        providerController={{} as never}
        search=""
        settings={{ ...defaultShellSettings(), firstRunOnboarding: "completed" }}
        sidebarVibrancySupported={false}
        themeController={{ draft: undefined, settings: undefined } as never}
        usageClient={{} as never}
        visibleSettings={["open-in-applications"]}
      />,
    );

    expect(await screen.findByTestId("settings-view")).toHaveTextContent("Host bridge available");
  });
});
