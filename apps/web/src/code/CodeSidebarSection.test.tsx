import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeSidebarSection } from "./CodeSidebarSection";

describe("CodeSidebarSection", () => {
  it("renders authoritative lifecycle and access state and selects a thread", () => {
    const onSelectThread = vi.fn();
    render(
      <CodeSidebarSection
        activeThreadId="thread-active"
        onSelectThread={onSelectThread}
        threads={[
          {
            executionPolicy: "approval-gated",
            lifecycle: "active",
            projectId: "project-one" as never,
            threadId: "thread-active" as never,
            title: "Controller foundation",
          },
          {
            executionPolicy: "plan",
            lifecycle: "waiting",
            projectId: "project-one" as never,
            threadId: "thread-waiting" as never,
            title: "Review architecture",
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /Controller foundation/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Approval gated")).toBeVisible();
    expect(screen.getByText("Waiting")).toBeVisible();
    expect(screen.getByText("Plan · read-only")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Review architecture/ }));
    expect(onSelectThread).toHaveBeenCalledWith("thread-waiting");
  });

  it("shows an honest empty state instead of fabricating threads", () => {
    render(<CodeSidebarSection onSelectThread={vi.fn()} threads={[]} />);
    expect(screen.getByText("No Code threads in this Project.")).toBeVisible();
  });

  it("marks follow-up as a labelled signal, not by color alone, and can filter to it", () => {
    render(
      <CodeSidebarSection
        onSelectThread={vi.fn()}
        threads={[
          {
            executionPolicy: "approval-gated",
            lifecycle: "active",
            projectId: "project-one" as never,
            threadId: "thread-follow" as never,
            title: "Needs approval",
            followUp: true,
          },
          {
            executionPolicy: "plan",
            lifecycle: "active",
            projectId: "project-one" as never,
            threadId: "thread-plain" as never,
            title: "Just browsing",
            followUp: false,
          },
        ]}
      />,
    );

    const followThread = screen.getByRole("button", { name: /Needs approval/ });
    expect(followThread).toHaveAttribute("data-follow-up", "true");
    expect(followThread).toHaveTextContent("Follow-up");
    expect(screen.getByRole("button", { name: /Just browsing/ })).toHaveAttribute(
      "data-follow-up",
      "false",
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Follow-up only/ }));
    expect(screen.getByRole("button", { name: /Needs approval/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Just browsing/ })).not.toBeInTheDocument();
  });
});
