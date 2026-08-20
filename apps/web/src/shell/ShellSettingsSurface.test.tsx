import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultShellSettings } from "@octant/domain/shell-policy";
import { ShellSettingsSurface } from "./ShellSettingsSurface";

describe("ShellSettingsSurface", () => {
  it("announces settings with the same visually hidden live region the workspace uses", () => {
    render(
      <ShellSettingsSurface
        agentRunSettingsClient={{} as never}
        announcement="Tab activated."
        announcementSequence={1}
        automationNotificationClient={{} as never}
        chatController={{} as never}
        codeController={{} as never}
        diagnosticsExportClient={{} as never}
        discoveryController={{} as never}
        executionProfiles={null}
        extensionClient={{} as never}
        githubClient={{} as never}
        hostControlClient={{} as never}
        isNarrow={false}
        nativeBoundsAvailable={false}
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
        visibleSettings={["enable-chat"]}
      />,
    );

    const liveRegion = document.querySelector('[data-announcement-sequence="1"]');
    expect(liveRegion).toHaveClass("sr-only");
    expect(liveRegion).toHaveTextContent("Tab activated.");
    expect(screen.getByRole("status")).toHaveTextContent("Opening Settings");
  });
});
