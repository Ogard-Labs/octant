import type { ProjectId } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WindowChromeContainer } from "./WindowChromeContainer";

const codeThread = {
  activeCodeThreadId: "00000000-0000-4000-8000-000000000001",
  activeProjectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
};

function chrome(overrides: Partial<React.ComponentProps<typeof WindowChromeContainer>> = {}) {
  const props: React.ComponentProps<typeof WindowChromeContainer> = {
    actions: {
      addDockTab: vi.fn(),
      recoverZen: vi.fn(),
      startNewThreadDraft: vi.fn(),
      toggleBottomPanel: vi.fn(),
      runDockToolMenu: vi.fn(),
      toggleDock: vi.fn(),
      toggleDockTool: vi.fn(),
    },
    activeMode: "code",
    activeSurface: "Code thread",
    codeBoardRevision: 0,
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

describe("the window chrome's uncommitted changes", () => {
  it("leaves the count to Environment while a Code thread is open", () => {
    chrome(codeThread);
    expect(screen.queryByRole("button", { name: /Uncommitted changes/ })).toBeNull();
  });

  it("shows nothing outside Code", () => {
    chrome();
    expect(screen.queryByRole("button", { name: /Uncommitted changes/ })).toBeNull();
  });
});

describe("the window chrome's uncommitted changes on the Code start screen", () => {
  function readyEnvironment(insertions: number, deletions: number) {
    return {
      status: "ready",
      insertions,
      deletions,
    };
  }
  const draft = {
    activeProjectId: codeThread.activeProjectId,
    activeProjectIsCode: true,
    codeDraft: true,
    activeSurface: "New task",
  };

  it("reads the Project's own checkout and shows +0 −0 for a clean one", async () => {
    const environment = vi.fn().mockResolvedValue(readyEnvironment(0, 0));
    chrome({ ...draft, projectClient: { environment } as never });
    expect(
      await screen.findByRole("button", { name: "Uncommitted changes: 0 lines added, 0 removed" }),
    ).toHaveTextContent("+0−0");
    expect(environment).toHaveBeenCalledWith(draft.activeProjectId, expect.anything(), true);
  });

  it("holds a dash in the same slot until the reading lands", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const environment = vi.fn().mockReturnValue(new Promise((done) => (resolve = done)));
    chrome({ ...draft, projectClient: { environment } as never });
    expect(screen.getByRole("button", { name: "Uncommitted changes: not read" })).toHaveTextContent(
      "—",
    );
    resolve(readyEnvironment(4, 1));
    expect(
      await screen.findByRole("button", { name: "Uncommitted changes: 4 lines added, 1 removed" }),
    ).toBeInTheDocument();
  });

  it("shows nothing for a Project with no Git checkout", async () => {
    const environment = vi.fn().mockResolvedValue({ status: "unavailable" });
    chrome({ ...draft, projectClient: { environment } as never });
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: /Uncommitted changes/ })).toBeNull(),
    );
    expect(environment).toHaveBeenCalled();
  });

  it("shows nothing when the Project is not a Code Project", () => {
    const environment = vi.fn();
    chrome({ ...draft, activeProjectIsCode: false, projectClient: { environment } as never });
    expect(environment).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Uncommitted changes/ })).toBeNull();
  });
});
