import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";

const pullRequest = {
  identity: { number: 1205 },
  state: "open",
} as never;

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
