import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WindowChromeContainer } from "./WindowChromeContainer";

function chrome(overrides: Partial<React.ComponentProps<typeof WindowChromeContainer>> = {}) {
  const props: React.ComponentProps<typeof WindowChromeContainer> = {
    actions: {
      recoverZen: vi.fn(),
      startNewThreadDraft: vi.fn(),
      toggleBottomPanel: vi.fn(),
      runDockToolMenu: vi.fn(),
      toggleDock: vi.fn(),
      toggleDockTool: vi.fn(),
    },
    activeMode: "code",
    activeSurface: "Code thread",
    bottomPanelAvailable: false,
    bottomPanelPresentedOpen: false,
    dockAvailable: true,
    dockBrowserActive: true,
    dockPresentedOpen: false,
    hostReservesTitlebarInset: false,
    isNarrow: false,
    material: "opaque",
    presentedSidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
    sidebarRail: false,
    windowHistory: {
      canGoBack: false,
      canGoForward: false,
      back: vi.fn(),
      forward: vi.fn(),
    } as never,
    zenRecoveryNeeded: false,
    ...overrides,
  };
  return { ...render(<WindowChromeContainer {...props} />), props };
}

describe("the window chrome's dock toggle dot", () => {
  it("marks the closed dock's toggle while the agent's Browser is active", () => {
    chrome();
    expect(screen.getByRole("button", { name: "Open Right sidebar" })).toHaveAccessibleDescription(
      "Browser is active",
    );
  });

  it("is not shown while the dock is open", () => {
    chrome({ dockPresentedOpen: true });
    expect(screen.getByRole("button", { name: "Close Right sidebar" })).not.toHaveAttribute(
      "data-activity",
    );
  });

  it("is not shown in the narrow window, where the modal dock draws no card for it to promise", () => {
    chrome({ isNarrow: true });
    expect(screen.getByRole("button", { name: "More window actions" })).not.toHaveAttribute(
      "data-activity",
    );
  });
});
