import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CirclePause } from "../ui/icons";
import { ProjectIconContext } from "./ProjectIcon";
import { iconSourceFor } from "./projectIcon.test-support";
import {
  middleTruncate,
  SidebarThreadRowContent,
  sidebarThreadRowLabel,
} from "./SidebarThreadRowContent";

const pullRequest = {
  identity: { number: 1205 },
  state: "open",
} as never;

describe("SidebarThreadRowContent Project icon", () => {
  const projectId = "20000000-0000-4000-8000-0000000000aa";

  function rows(source: ReturnType<typeof iconSourceFor>["source"], ids: ReadonlyArray<string>) {
    return render(
      <ProjectIconContext.Provider value={source}>
        {ids.map((id, index) => (
          <div key={index}>
            <SidebarThreadRowContent
              projectId={id}
              projectName="Harbor"
              title={`Thread ${String(index)}`}
            />
          </div>
        ))}
      </ProjectIconContext.Provider>,
    );
  }

  it("draws the Project's image in the chip when the host has an icon", async () => {
    const { source } = iconSourceFor([projectId]);
    const { container } = rows(source, [projectId]);
    await waitFor(() => expect(container.querySelector("img.project-icon")).not.toBeNull());
  });

  it("keeps the Project's two initials when the host has no icon", async () => {
    const { fetcher, source } = iconSourceFor([]);
    const { container } = rows(source, [projectId]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(container.querySelector("img.project-icon")).toBeNull();
    expect(container.querySelector(".project-mark")).toHaveTextContent("HA");
  });

  it("asks for nothing on a thread with no Project", () => {
    const { fetcher, source } = iconSourceFor([projectId]);
    const { container } = rows(source, [undefined as never]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector("svg.octant-icon-folder")).not.toBeNull();
  });

  it("makes one icon request for many thread rows in the same Project", async () => {
    const { fetcher, source } = iconSourceFor([projectId]);
    const { container } = rows(
      source,
      Array.from({ length: 25 }, () => projectId),
    );
    await waitFor(() => expect(container.querySelectorAll("img.project-icon")).toHaveLength(25));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("SidebarThreadRowContent", () => {
  it("puts the title first with its age at the end, and the Project, branch and pull request on a quiet line beneath", () => {
    const { container } = render(
      <SidebarThreadRowContent
        age={{ label: "3h", title: "3 hours ago" }}
        checkout={{ checkoutKind: "managed-worktree", label: "fix-full-access" }}
        projectName="octant"
        pullRequest={pullRequest}
        title="Approvals in side chat"
      />,
    );

    const lines = container.querySelector(".sidebar-navigation__thread-copy")?.children;
    expect(lines?.[0]).toHaveClass("sidebar-navigation__thread-main");
    expect(lines?.[1]).toHaveClass("sidebar-navigation__thread-context");
    expect(lines).toHaveLength(2);
    expect(container.querySelector(".sidebar-navigation__thread-title")).toHaveTextContent(
      /^Approvals in side chat$/,
    );
    expect(container.querySelector(".sidebar-navigation__thread-main")).toHaveTextContent(
      /^Approvals in side chat3h$/,
    );
    const quiet = container.querySelector(".sidebar-navigation__thread-context");
    expect(quiet).toHaveTextContent("octant");
    expect(quiet).toHaveTextContent("fix-full-access");
    expect(quiet).toHaveTextContent("#1205");
    expect(quiet).not.toHaveTextContent("3h");
  });

  it("shows a running or waiting thread's state as its mark and age, and keeps the word for its tooltip", () => {
    const { container, rerender } = render(
      <SidebarThreadRowContent
        age={{ label: "3h" }}
        projectName="octant"
        state={{ status: "working", text: "Working 14m", age: "14m" }}
        title="Fix the editor return key"
      />,
    );
    const state = () => container.querySelector(".sidebar-navigation__thread-state");
    expect(state()?.parentElement).toHaveClass("sidebar-navigation__thread-main");
    expect(state()).toHaveTextContent(/^14m$/);
    expect(state()).toHaveAttribute("title", "Working 14m");
    expect(state()).toHaveAttribute("data-activity", "working");
    expect(state()?.querySelector(".octant-spinner, [data-slot='spinner']")).not.toBeNull();
    expect(container).not.toHaveTextContent("3h");

    rerender(
      <SidebarThreadRowContent
        projectName="octant"
        state={{ status: "attention", text: "Needs you", age: "5m", icon: CirclePause }}
        title="Fix the editor return key"
      />,
    );
    expect(state()).toHaveTextContent(/^5m$/);
    expect(state()).toHaveAttribute("title", "Needs you");
    expect(state()?.querySelector("svg")).not.toBeNull();

    rerender(
      <SidebarThreadRowContent
        projectName="octant"
        state={{ status: "woke", text: "Snooze ended", icon: CirclePause }}
        title="Fix the editor return key"
      />,
    );
    expect(state()).toHaveTextContent(/^$/);
    expect(state()).toHaveAttribute("title", "Snooze ended");
  });

  it("opens no second line for a row that names no place and carries no marks", () => {
    const { container } = render(
      <SidebarThreadRowContent age={{ label: "2m" }} title="Fix the editor return key" />,
    );
    expect(container.querySelector(".sidebar-navigation__thread-context")).toBeNull();
    expect(container.querySelector(".sidebar-navigation__thread-main")).toHaveTextContent("2m");
    expect(container.querySelector(".sidebar-navigation__thread-detail")).toBeNull();
  });

  it("puts the provider at the end of the quiet line, or of the title line when the row has none", () => {
    const provider = { displayName: "Codex", driverKind: "codex-cli" } as never;
    const { container, rerender } = render(
      <SidebarThreadRowContent provider={provider} title="Fix the editor return key" />,
    );
    expect(container.querySelector(".sidebar-navigation__thread-context")).toBeNull();
    expect(
      container.querySelector(
        ".sidebar-navigation__thread-main > .sidebar-navigation__thread-provider",
      ),
    ).toHaveAttribute("title", "Codex");

    rerender(
      <SidebarThreadRowContent
        checkout={{ checkoutKind: "managed-worktree", label: "fix-return" }}
        provider={provider}
        pullRequest={pullRequest}
        title="Fix the editor return key"
      />,
    );
    expect(
      container.querySelector(
        ".sidebar-navigation__thread-context > .sidebar-navigation__thread-provider:last-child",
      ),
    ).toHaveAttribute("title", "Codex");
    expect(
      container.querySelector(
        ".sidebar-navigation__thread-main .sidebar-navigation__thread-provider",
      ),
    ).toBeNull();
    expect(container.querySelector(".sidebar-navigation__thread-detail")).toBeNull();
  });

  it("says what a running turn is doing on its own line, and on which server", () => {
    const { container, rerender } = render(
      <SidebarThreadRowContent
        activity="Running bench.ts"
        host="studio-linux"
        projectName="octant"
        state={{ status: "working", text: "Working 9m", age: "9m" }}
        title="Journal replay benchmark"
      />,
    );
    const lines = container.querySelector(".sidebar-navigation__thread-copy")?.children;
    expect(lines).toHaveLength(3);
    expect(lines?.[2]).toHaveClass("sidebar-navigation__thread-detail");
    expect(lines?.[2]).toHaveTextContent(/^Running bench\.tsstudio-linux$/);
    expect(screen.getByTitle("On studio-linux")).toBeInTheDocument();

    rerender(
      <SidebarThreadRowContent
        activity="Editing composerThreadDraft.ts"
        projectName="octant"
        state={{ status: "working", text: "Working 4m", age: "4m" }}
        title="Composer draft restore"
      />,
    );
    expect(container.querySelector(".sidebar-navigation__thread-detail")).toHaveTextContent(
      /^Editing composerThreadDraft\.ts$/,
    );
    expect(container.querySelector(".sidebar-navigation__thread-host")).toBeNull();
  });

  it("names a worker's coordinator on a third line and marks a coordinator in place of its provider", () => {
    const { container, rerender } = render(
      <SidebarThreadRowContent
        coordinatorName="Backlog"
        projectName="octant"
        provider={{ displayName: "Claude", driverKind: "claude" }}
        title="Fix the flaky test"
      />,
    );
    const lines = container.querySelector(".sidebar-navigation__thread-copy")?.children;
    expect(lines?.[2]).toHaveClass("sidebar-navigation__thread-detail");
    expect(lines?.[2]).toHaveTextContent("Backlog");
    expect(lines?.[1]).not.toHaveTextContent("Backlog");

    rerender(
      <SidebarThreadRowContent
        coordinator
        provider={{ displayName: "Claude", driverKind: "claude" }}
        title="Backlog"
      />,
    );
    expect(screen.getByRole("img", { name: "Coordinator" })).toBeInTheDocument();
    expect(container.querySelector(".sidebar-navigation__thread-provider")).toHaveAttribute(
      "title",
      "Coordinator",
    );
  });

  it("marks new activity with a named dot beside the time", () => {
    render(<SidebarThreadRowContent age={{ label: "5m" }} title="Fix it" unread />);
    expect(screen.getByRole("img", { name: "New activity" })).toBeInTheDocument();
    expect(screen.getByText("5m")).toBeInTheDocument();
  });
});

describe("SidebarThreadRowContent counted marks", () => {
  it("reads a row with 22 pull requests as one mark counted +21 in the open colour", () => {
    render(
      <SidebarThreadRowContent morePullRequests={21} pullRequest={pullRequest} title="Phone app" />,
    );
    const mark = screen.getByRole("img", {
      name: "pull request #1205 open and 21 more pull requests",
    });
    expect(mark).toHaveAttribute("data-pr-state", "open");
    expect(mark).toHaveTextContent(/^#1205\+21$/);
    expect(mark).toHaveAttribute("title", "Pull request #1205 · open and 21 more pull requests");
  });

  it("shows a thread's touched issues as a count, and the key of the issue it belongs to", () => {
    const { rerender } = render(<SidebarThreadRowContent issueCount={25} title="Phone app" />);
    expect(screen.getByRole("img", { name: "25 issues" })).toHaveTextContent(/^25$/);
    expect(screen.getByRole("img", { name: "25 issues" })).toHaveAttribute(
      "title",
      "Wrote to 25 issues",
    );

    rerender(
      <SidebarThreadRowContent
        issueCount={3}
        issueKey={{ reference: "OCT-1001", name: "Linear issue OCT-1001, Phone app, In Progress" }}
        title="Phone app"
      />,
    );
    const key = screen.getByRole("img", { name: "issue OCT-1001" });
    expect(key).toHaveTextContent(/^OCT-1001$/);
    expect(key).toHaveAttribute("title", "Linear issue OCT-1001, Phone app, In Progress");
    expect(screen.getByRole("img", { name: "and 3 issues" })).toHaveAttribute(
      "title",
      "Wrote to 3 issues besides OCT-1001",
    );
  });

  it("shows how many layers a stacked pull request's stack has", () => {
    render(
      <SidebarThreadRowContent
        pullRequest={pullRequest}
        stack={{ position: 2, size: 3, parent: 1204 }}
        title="Stacked"
      />,
    );
    const stack = screen.getByRole("img", { name: "in a stack of 3" });
    expect(stack).toHaveTextContent(/^3$/);
    expect(stack).toHaveAttribute("title", "Layer 2 of 3 of a stack, on #1204");
  });

  it("opens no second line for a thread with no pull requests, stack or issues", () => {
    const { container } = render(<SidebarThreadRowContent issueCount={0} title="Quiet" />);
    expect(container.querySelector(".sidebar-navigation__thread-context")).toBeNull();
    expect(container.querySelector(".sidebar-navigation__thread-detail")).toBeNull();
  });
});

describe("sidebarThreadRowLabel", () => {
  it("reads the title, the Project, the branch, the pull request and then the state", () => {
    expect(
      sidebarThreadRowLabel({
        title: "Fix the editor return key",
        projectName: "octant",
        branch: "fix-return",
        pullRequest,
        state: "Working 14m",
        age: "3h",
      }),
    ).toBe("Fix the editor return key, octant, fix-return, pull request #1205 open, Working 14m");
  });

  it("names every counted mark in the row's one name, after the pull request", () => {
    expect(
      sidebarThreadRowLabel({
        title: "Phone app",
        pullRequest,
        morePullRequests: 21,
        stack: { position: 1, size: 2 },
        issueKey: { reference: "OCT-1001" },
        issueCount: 24,
        age: "3h",
      }),
    ).toBe(
      "Phone app, pull request #1205 open and 21 more pull requests, in a stack of 2, issue OCT-1001, and 24 issues, 3h",
    );
  });

  it("reads a working row's activity and then its server after the state", () => {
    expect(
      sidebarThreadRowLabel({
        title: "Journal replay benchmark",
        projectName: "octant",
        host: "studio-linux",
        state: "Working",
        activity: "Running bench.ts",
      }),
    ).toBe("Journal replay benchmark, octant, Working, Running bench.ts, on studio-linux");
  });

  it("falls back to the time when the thread has no state, and leaves out what a view hides", () => {
    expect(sidebarThreadRowLabel({ title: "Fix it", age: "2d" })).toBe("Fix it, 2d");
    expect(sidebarThreadRowLabel({ title: "Fix it" })).toBe("Fix it");
  });
});

describe("middleTruncate", () => {
  it("keeps a branch's start and end and folds the middle away", () => {
    expect(middleTruncate("fix-it")).toBe("fix-it");
    const folded = middleTruncate("feature/a-very-long-branch-name-with-detail-end");
    expect([...folded]).toHaveLength(22);
    expect(folded.startsWith("feature/a-")).toBe(true);
    expect(folded.endsWith("detail-end")).toBe(true);
    expect(folded).toContain("…");
  });
});
