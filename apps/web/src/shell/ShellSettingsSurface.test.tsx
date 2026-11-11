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
      />,
    );

    const liveRegion = document.querySelector('[data-announcement-sequence="1"]');
    expect(liveRegion).toHaveClass("sr-only");
    expect(liveRegion).toHaveTextContent("Tab activated.");
    expect(screen.getByRole("status")).toHaveTextContent("Opening Settings");
  });

  it("shows Settings in outline while it loads and keeps the words for assistive technology", () => {
    const { container } = render(
      <ShellSettingsSurface
        agentRunSettingsClient={{} as never}
        announcement=""
        announcementSequence={0}
        automationNotificationClient={{} as never}
        chatController={{} as never}
        codeController={{} as never}
        diagnosticsExportClient={{} as never}
        discoveryController={{} as never}
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
        presentation="sheet"
        providerController={{} as never}
        search=""
        settings={{ ...defaultShellSettings(), firstRunOnboarding: "completed" }}
        sidebarVibrancySupported={false}
        themeController={{ draft: undefined, settings: undefined } as never}
        usageClient={{} as never}
      />,
    );

    const status = screen.getByRole("status", { name: "Opening Settings" });
    expect(status).toHaveAttribute("data-presentation", "sheet");
    // A rail and a page, drawn as bars that assistive technology skips.
    expect(container.querySelector(".settings-loading__rail")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelector(".settings-loading__page")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelectorAll(".settings-loading .skeleton").length).toBeGreaterThan(4);
    // The spinner and its two lines are gone; only the bars are drawn.
    expect(screen.queryByText("Loading the Octant settings surface.")).toBeNull();
  });
});
