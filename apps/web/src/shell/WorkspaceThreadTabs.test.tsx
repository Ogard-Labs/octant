import { decodeChatThreadId, decodeCodeThreadId, decodeProjectId } from "@octant/contracts";
import { decodeHostId } from "@octant/contracts/host";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceThreadTabs, type WorkspaceThreadTab } from "./WorkspaceThreadTabs";

const projectId = decodeProjectId("00000000-0000-4000-8000-000000000711");
const first: WorkspaceThreadTab = {
  key: "chat:00000000-0000-4000-8000-000000000712",
  mode: "chat",
  threadId: decodeChatThreadId("00000000-0000-4000-8000-000000000712"),
  title: "First thread",
  projectId,
};
const second: WorkspaceThreadTab = {
  key: "code:00000000-0000-4000-8000-000000000713",
  mode: "code",
  threadId: decodeCodeThreadId("00000000-0000-4000-8000-000000000713"),
  title: "Second thread",
  projectId,
};

describe("WorkspaceThreadTabs", () => {
  it("names each tab by its thread, its Project, and where the thread runs", async () => {
    render(
      <WorkspaceThreadTabs
        activeTab={{ ...first, projectLabel: "Planning" }}
        contextLabel="Planning"
        fallbackTitle="First thread"
        mode="chat"
        onActivate={vi.fn()}
      />,
    );

    // The Project rides on the tab, so a strip holding two Projects names both.
    expect(screen.getByText("Planning")).toBeVisible();
    // A local thread says so without the reader hunting for a legend.
    expect(screen.getByRole("tab", { name: "First thread" })).toHaveAttribute(
      "title",
      "First thread — Planning — this machine",
    );
  });

  it("wears the pull request a Code thread delivers to, ahead of its title", () => {
    render(
      <WorkspaceThreadTabs
        activeTab={{ ...second, pullRequest: { number: 917, state: "merged" } }}
        fallbackTitle="Second thread"
        mode="code"
        onActivate={vi.fn()}
      />,
    );

    const chip = screen.getByText("PR #917");
    expect(chip).toBeVisible();
    expect(chip).toHaveAttribute("data-state", "merged");
    expect(screen.getByRole("tab", { name: /Second thread/ })).toBeVisible();
  });

  it("says a thread on a paired host runs somewhere else", async () => {
    render(
      <WorkspaceThreadTabs
        activeTab={{ ...second, hostId: decodeHostId("workstation") }}
        contextLabel="Planning"
        fallbackTitle="Second thread"
        mode="code"
        onActivate={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Second thread" })).toHaveAttribute(
      "title",
      "Second thread — Planning — a paired host",
    );
  });

  it("keeps one preview tab until the user pins it", async () => {
    const { rerender } = render(
      <WorkspaceThreadTabs
        activeTab={first}
        contextLabel="Planning"
        fallbackTitle="First thread"
        mode="chat"
        onActivate={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "First thread" })).toBeVisible();

    rerender(
      <WorkspaceThreadTabs
        activeTab={second}
        contextLabel="Planning"
        fallbackTitle="Second thread"
        mode="code"
        onActivate={vi.fn()}
      />,
    );

    expect(screen.queryByRole("tab", { name: "First thread" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Second thread" })).toBeVisible();
  });

  it("keeps pinned threads open, switches between them, and closes the active tab", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const { rerender } = render(
      <WorkspaceThreadTabs
        activeTab={first}
        contextLabel="Planning"
        fallbackTitle="First thread"
        mode="chat"
        onActivate={onActivate}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pin First thread" }));
    rerender(
      <WorkspaceThreadTabs
        activeTab={second}
        contextLabel="Planning"
        fallbackTitle="Second thread"
        mode="code"
        onActivate={onActivate}
      />,
    );

    expect(screen.getByRole("tab", { name: "First thread" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Second thread" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(screen.getByRole("tab", { name: "First thread" }));
    expect(onActivate).toHaveBeenLastCalledWith(first);

    await user.click(screen.getByRole("button", { name: "Close Second thread" }));
    expect(screen.queryByRole("tab", { name: "Second thread" })).not.toBeInTheDocument();
    expect(onActivate).toHaveBeenLastCalledWith(first);
  });

  it("hands the pane back when the only open tab is closed", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onCloseActive = vi.fn();
    render(
      <WorkspaceThreadTabs
        activeTab={first}
        contextLabel="Planning"
        fallbackTitle="First thread"
        mode="chat"
        onActivate={onActivate}
        onCloseActive={onCloseActive}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Close First thread" }));

    // Nothing is left to switch to, so the shell closes the pane; before, the
    // tab disappeared while the thread stayed on screen.
    expect(onCloseActive).toHaveBeenCalledOnce();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("switches pinned threads with the tab keyboard model", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const { rerender } = render(
      <WorkspaceThreadTabs
        activeTab={first}
        fallbackTitle="First thread"
        mode="chat"
        onActivate={onActivate}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pin First thread" }));
    rerender(
      <WorkspaceThreadTabs
        activeTab={second}
        fallbackTitle="Second thread"
        mode="code"
        onActivate={onActivate}
      />,
    );

    screen.getByRole("tab", { name: "Second thread" }).focus();
    await user.keyboard("{ArrowLeft}");

    expect(onActivate).toHaveBeenLastCalledWith(first);
  });
});
