import type { CodeBoardCard, ProjectId } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadBoardCard } from "../shell/useThreadBoardCard";
import { WindowChromeContainer } from "./WindowChromeContainer";

vi.mock("../shell/useThreadBoardCard", () => ({ useThreadBoardCard: vi.fn() }));

beforeEach(() => {
  vi.mocked(useThreadBoardCard).mockReturnValue(undefined);
});

const codeThread = {
  threadId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
};

function cardWithChanges(
  changedFiles: Extract<CodeBoardCard["changedFiles"], { readonly kind: "observed" }>,
): CodeBoardCard {
  return { changedFiles } as CodeBoardCard;
}

function observed(insertions: number, deletions: number, freshness: "fresh" | "stale" = "fresh") {
  return cardWithChanges({
    kind: "observed",
    freshness,
    changedPathCount: insertions + deletions === 0 ? 0 : 2,
    stagedCount: 0,
    committedAhead: 0,
    workingTreeClean: insertions + deletions === 0,
    insertions,
    deletions,
  });
}

function chrome(overrides: Partial<React.ComponentProps<typeof WindowChromeContainer>> = {}) {
  const props: React.ComponentProps<typeof WindowChromeContainer> = {
    actions: {
      addDockTab: vi.fn(),
      loadCodeBoard: vi.fn(),
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
  it("names the open Code thread's added and removed lines and opens the changes view", async () => {
    vi.mocked(useThreadBoardCard).mockReturnValue(observed(12, 3));
    const { props } = chrome({ activeCodeThread: codeThread });

    const button = screen.getByRole("button", {
      name: "Uncommitted changes: 12 lines added, 3 removed",
    });
    expect(button).toHaveTextContent("+12−3");
    await userEvent.setup().click(button);
    expect(props.actions.addDockTab).toHaveBeenCalledWith("review");
  });

  it("shows +0 −0 for a clean checkout", () => {
    vi.mocked(useThreadBoardCard).mockReturnValue(observed(0, 0));
    chrome({ activeCodeThread: codeThread });
    expect(
      screen.getByRole("button", { name: "Uncommitted changes: 0 lines added, 0 removed" }),
    ).toHaveTextContent("+0−0");
  });

  it("shows nothing without a Code thread, a checkout reading, or a current one", () => {
    chrome();
    expect(screen.queryByRole("button", { name: /Uncommitted changes/ })).toBeNull();
  });

  it("leaves out a count the host marked stale", () => {
    vi.mocked(useThreadBoardCard).mockReturnValue(observed(12, 3, "stale"));
    chrome({ activeCodeThread: codeThread });
    expect(screen.queryByRole("button", { name: /Uncommitted changes/ })).toBeNull();
  });
});
