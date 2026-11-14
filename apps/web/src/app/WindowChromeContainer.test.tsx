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
  activeCodeThreadId: "00000000-0000-4000-8000-000000000001",
  activeProjectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
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
    const { props } = chrome(codeThread);

    const button = screen.getByRole("button", {
      name: "Uncommitted changes: 12 lines added, 3 removed",
    });
    expect(button).toHaveTextContent("+12−3");
    await userEvent.setup().click(button);
    expect(props.actions.addDockTab).toHaveBeenCalledWith("review");
  });

  it("shows +0 −0 for a clean checkout", () => {
    vi.mocked(useThreadBoardCard).mockReturnValue(observed(0, 0));
    chrome(codeThread);
    expect(
      screen.getByRole("button", { name: "Uncommitted changes: 0 lines added, 0 removed" }),
    ).toHaveTextContent("+0−0");
  });

  it("shows nothing outside Code", () => {
    chrome();
    expect(screen.queryByRole("button", { name: /Uncommitted changes/ })).toBeNull();
  });

  it("keeps the dash for a thread whose checkout cannot be observed, so the band does not drop out when the board answers", () => {
    vi.mocked(useThreadBoardCard).mockReturnValue({
      changedFiles: { kind: "unavailable" },
    } as unknown as CodeBoardCard);
    chrome(codeThread);
    const button = screen.getByRole("button", { name: "Uncommitted changes: not read" });
    expect(button).toHaveTextContent("—");
    expect(button).toHaveAttribute("title", "No changes could be read");
  });

  it("holds its place with a dash until the thread's checkout has been read", () => {
    chrome(codeThread);
    const button = screen.getByRole("button", { name: "Uncommitted changes: not read" });
    expect(button).toHaveTextContent("—");
    expect(button).toHaveAttribute("title", "Updating…");
  });

  it("keeps a stale count on screen in meta ink with Updating… as its tooltip", () => {
    vi.mocked(useThreadBoardCard).mockReturnValue(observed(12, 3, "stale"));
    chrome(codeThread);
    const button = screen.getByRole("button", {
      name: "Uncommitted changes: 12 lines added, 3 removed",
    });
    expect(button).toHaveTextContent("+12−3");
    expect(button).toHaveAttribute("title", "Updating…");
    expect(button).toHaveAttribute("data-updating", "true");
  });

  it("marks a zero count so it is drawn in meta ink rather than green or red", () => {
    vi.mocked(useThreadBoardCard).mockReturnValue(observed(5, 0));
    chrome(codeThread);
    const button = screen.getByRole("button", { name: /Uncommitted changes/ });
    expect(button.querySelector(".window-chrome__changes-added")).not.toHaveAttribute("data-zero");
    expect(button.querySelector(".window-chrome__changes-removed")).toHaveAttribute(
      "data-zero",
      "true",
    );
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
