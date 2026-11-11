import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectIconContext } from "./ProjectIcon";
import { iconSourceFor } from "./projectIcon.test-support";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";

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

  it("keeps the folder glyph when the host has no icon", async () => {
    const { fetcher, source } = iconSourceFor([]);
    const { container } = rows(source, [projectId]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(container.querySelector("img.project-icon")).toBeNull();
    expect(container.querySelector("svg.lucide-folder")).not.toBeNull();
  });

  it("asks for nothing on a thread with no Project", () => {
    const { fetcher, source } = iconSourceFor([projectId]);
    const { container } = rows(source, [undefined as never]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector("svg.lucide-folder")).not.toBeNull();
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
  it("puts the Project, pull request, branch, and age on one line under the title", () => {
    const { container } = render(
      <SidebarThreadRowContent
        age={{ label: "3h", title: "3 hours ago" }}
        checkout={{ checkoutKind: "managed-worktree", label: "fix-full-access" }}
        projectName="octant"
        pullRequest={pullRequest}
        title="Approvals in side chat"
      />,
    );

    const facts = container.querySelector(".sidebar-navigation__thread-facts");
    expect(facts).toHaveTextContent("octant");
    expect(facts).toHaveTextContent("#1205");
    expect(facts).toHaveTextContent("fix-full-access");
    expect(facts).toHaveTextContent("3h");
    // The title line carries the title alone, so a long one has the row's
    // whole width before it truncates.
    expect(container.querySelector(".sidebar-navigation__thread-title")).toHaveTextContent(
      /^Approvals in side chat$/,
    );
    expect(screen.getByRole("img", { name: "Pull request #1205 · open" })).toBeInTheDocument();
  });

  it("names a worker's coordinator under its title and marks a coordinator in the icon column", () => {
    const { container, rerender } = render(
      <SidebarThreadRowContent
        coordinatorName="Backlog"
        provider={{ displayName: "Claude", driverKind: "claude" }}
        title="Fix the flaky test"
      />,
    );
    expect(container.querySelector(".sidebar-navigation__thread-facts")).toHaveTextContent(
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

  it("leaves no second line when the view shows no facts, and keeps the age beside the status", () => {
    const { container } = render(
      <SidebarThreadRowContent
        age={{ label: "2m" }}
        status={<span data-testid="status" />}
        title="Fix the editor return key"
      />,
    );

    expect(container.querySelector(".sidebar-navigation__thread-facts")).toBeNull();
    const age = screen.getByText("2m");
    expect(age.nextElementSibling).toBe(screen.getByTestId("status"));
  });

  it("leads with the provider mark when the thread has one, in either view", () => {
    const { container, rerender } = render(
      <SidebarThreadRowContent
        provider={{ displayName: "Codex CLI", driverKind: "codex-cli" } as never}
        title="Fix the editor return key"
      />,
    );
    const mark = container.querySelector(".sidebar-navigation__thread-provider");
    expect(mark).toHaveAttribute("title", "Codex CLI");
    expect(mark?.nextElementSibling).toHaveClass("sidebar-navigation__thread-copy");

    // A thread whose provider is not resolved keeps the column, empty, so its
    // title starts where its neighbours' titles do.
    rerender(<SidebarThreadRowContent title="Fix the editor return key" />);
    const slot = container.querySelector(".sidebar-navigation__thread-provider");
    expect(slot).toBeEmptyDOMElement();
    expect(slot).toHaveAttribute("aria-hidden", "true");
    expect(slot?.nextElementSibling).toHaveClass("sidebar-navigation__thread-copy");
  });
});
