import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeSidebarSection } from "./CodeSidebarSection";

const baseThread = {
  executionPolicy: "approval-gated",
  lifecycle: "active",
  projectId: "project-one" as never,
  threadId: "thread-one" as never,
  title: "Controller foundation",
} as const;

describe("CodeSidebarSection", () => {
  it("says a thread has new activity in words rather than by a mark alone", () => {
    render(
      <CodeSidebarSection onSelectThread={vi.fn()} threads={[{ ...baseThread, unread: true }]} />,
    );

    expect(screen.getByText("New activity")).toBeVisible();
  });

  it("pins and unpins a thread through the host", () => {
    const onPinThread = vi.fn();
    const { rerender } = render(
      <CodeSidebarSection
        onPinThread={onPinThread}
        onSelectThread={vi.fn()}
        threads={[baseThread]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pin Controller foundation" }));
    expect(onPinThread).toHaveBeenCalledWith("thread-one", true);

    rerender(
      <CodeSidebarSection
        onPinThread={onPinThread}
        onSelectThread={vi.fn()}
        threads={[{ ...baseThread, pinned: true }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Unpin Controller foundation" }));
    expect(onPinThread).toHaveBeenLastCalledWith("thread-one", false);
  });

  it("renames a thread from the keyboard and abandons a blank title", async () => {
    const user = userEvent.setup();
    const onRenameThread = vi.fn();
    render(
      <CodeSidebarSection
        onRenameThread={onRenameThread}
        onSelectThread={vi.fn()}
        threads={[baseThread]}
      />,
    );

    screen.getByRole("button", { name: /Controller foundation/ }).focus();
    await user.keyboard("{F2}");
    const field = await screen.findByRole("textbox", { name: "Rename Code thread" });
    await user.clear(field);
    await user.type(field, "Importer rewrite{Enter}");
    expect(onRenameThread).toHaveBeenCalledWith("thread-one", "Importer rewrite");

    screen.getByRole("button", { name: /Controller foundation/ }).focus();
    await user.keyboard("{F2}");
    const second = await screen.findByRole("textbox", { name: "Rename Code thread" });
    await user.clear(second);
    await user.keyboard("{Enter}");
    expect(onRenameThread).toHaveBeenCalledTimes(1);
  });

  it("offers no rename or pin when the host cannot accept one", () => {
    render(<CodeSidebarSection onSelectThread={vi.fn()} threads={[baseThread]} />);

    expect(screen.queryByRole("button", { name: /^Pin / })).toBeNull();
  });

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
