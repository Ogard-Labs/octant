import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
  it("puts the Project and branch on a quiet top line, the title alone on the next, and the pull request on the last", () => {
    const { container } = render(
      <SidebarThreadRowContent
        age={{ label: "3h", title: "3 hours ago" }}
        checkout={{ checkoutKind: "managed-worktree", label: "fix-full-access" }}
        projectName="octant"
        pullRequest={pullRequest}
        title="Approvals in side chat"
      />,
    );

    const context = container.querySelector(".sidebar-navigation__thread-context");
    expect(context).toHaveTextContent("octant");
    expect(context).toHaveTextContent("fix-full-access");
    // The time ends the top line; the title line carries the title alone, so a
    // long one has the row's whole width before it truncates.
    expect(context).toHaveTextContent("3h");
    expect(container.querySelector(".sidebar-navigation__thread-title")).toHaveTextContent(
      /^Approvals in side chat$/,
    );
    expect(container.querySelector(".sidebar-navigation__thread-main")).toHaveTextContent(
      /^Approvals in side chat$/,
    );
    expect(container.querySelector(".sidebar-navigation__thread-detail")).toHaveTextContent(
      "#1205 open",
    );
  });

  it("says a running or waiting thread's state in words in place of the time", () => {
    const { container, rerender } = render(
      <SidebarThreadRowContent
        age={{ label: "3h" }}
        projectName="octant"
        state={{ status: "working", text: "Working 14m" }}
        title="Fix the editor return key"
      />,
    );
    const context = container.querySelector(".sidebar-navigation__thread-context");
    expect(context).toHaveTextContent("Working 14m");
    expect(context).not.toHaveTextContent("3h");
    expect(container.querySelector(".sidebar-navigation__thread-state")).toHaveAttribute(
      "data-activity",
      "working",
    );

    rerender(
      <SidebarThreadRowContent
        projectName="octant"
        state={{ status: "attention", text: "Needs you" }}
        title="Fix the editor return key"
      />,
    );
    expect(container.querySelector(".sidebar-navigation__thread-state")).toHaveTextContent(
      "Needs you",
    );
  });

  it("carries the time on the title line when the row names no place", () => {
    const { container } = render(
      <SidebarThreadRowContent age={{ label: "2m" }} title="Fix the editor return key" />,
    );
    expect(container.querySelector(".sidebar-navigation__thread-context")).toBeNull();
    expect(container.querySelector(".sidebar-navigation__thread-main")).toHaveTextContent("2m");
    expect(container.querySelector(".sidebar-navigation__thread-detail")).toBeNull();
  });

  it("opens a third line only when there is something for it, and puts the provider at the end of the last line", () => {
    const provider = { displayName: "Codex", driverKind: "codex-cli" } as never;
    const { container, rerender } = render(
      <SidebarThreadRowContent provider={provider} title="Fix the editor return key" />,
    );
    expect(container.querySelector(".sidebar-navigation__thread-detail")).toBeNull();
    expect(
      container.querySelector(
        ".sidebar-navigation__thread-main > .sidebar-navigation__thread-provider",
      ),
    ).toHaveAttribute("title", "Codex");

    rerender(
      <SidebarThreadRowContent
        provider={provider}
        pullRequest={pullRequest}
        title="Fix the editor return key"
      />,
    );
    expect(
      container.querySelector(
        ".sidebar-navigation__thread-detail > .sidebar-navigation__thread-provider",
      ),
    ).toHaveAttribute("title", "Codex");
    expect(
      container.querySelector(
        ".sidebar-navigation__thread-main .sidebar-navigation__thread-provider",
      ),
    ).toBeNull();
  });

  it("names a worker's coordinator under its title and marks a coordinator in place of its provider", () => {
    const { container, rerender } = render(
      <SidebarThreadRowContent
        coordinatorName="Backlog"
        provider={{ displayName: "Claude", driverKind: "claude" }}
        title="Fix the flaky test"
      />,
    );
    expect(container.querySelector(".sidebar-navigation__thread-detail")).toHaveTextContent(
      "Backlog",
    );

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
