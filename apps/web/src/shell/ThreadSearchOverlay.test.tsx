import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadSearchOverlay } from "./ThreadSearchOverlay";
import type { ThreadSearchThread } from "./threadSearchViewModel";

const componentStyles = readFileSync(resolve(process.cwd(), "src/styles/components.css"), "utf8");

const projects = [{ id: "p1", name: "Octant" }];

function thread(overrides: Partial<ThreadSearchThread> & { threadId: string }): ThreadSearchThread {
  return { mode: "chat", title: "Untitled", lifecycle: "active", ...overrides };
}

const threads: ReadonlyArray<ThreadSearchThread> = [
  thread({ threadId: "t1", title: "Release checklist", projectId: "p1" }),
  thread({ threadId: "t2", title: "Release notes" }),
  thread({ threadId: "t3", title: "Release archive", lifecycle: "archived" }),
  thread({ threadId: "t4", mode: "code", title: "Release branch" }),
];

function renderOverlay(overrides: Partial<Parameters<typeof ThreadSearchOverlay>[0]> = {}) {
  const onClose = vi.fn();
  const onOpenThread = vi.fn();
  render(
    <ThreadSearchOverlay
      mode="chat"
      onClose={onClose}
      onOpenThread={onOpenThread}
      projects={projects}
      threads={threads}
      {...overrides}
    />,
  );
  return { onClose, onOpenThread };
}

describe("ThreadSearchOverlay", () => {
  it("opens focused on one search field that names its current-mode scope", async () => {
    renderOverlay();

    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Search Chat threads" })).toBeVisible();
    expect(
      screen.getByText("Searches Chat thread titles, messages, and archived history."),
    ).toBeVisible();
    expect(screen.getByRole("group", { name: "Threads" })).toBeVisible();
    expect(screen.getByText("Release checklist")).toBeVisible();
    expect(componentStyles).toMatch(
      /\.thread-search\s*\{[^}]*width:\s*min\(520px, calc\(100vw - 32px\)\);[^}]*max-height:/s,
    );
  });

  it("offers existing shell actions as compact quick actions", async () => {
    const user = userEvent.setup();
    const onNewThread = vi.fn();
    const onNewProject = vi.fn();
    const onOpenSettings = vi.fn();
    const { onClose } = renderOverlay({ onNewThread, onNewProject, onOpenSettings });

    expect(screen.getByRole("group", { name: "Quick actions" })).toBeVisible();
    expect(componentStyles).toMatch(
      /\.thread-search__quick-actions \.thread-search__quick-action\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*flex-start;/s,
    );
    await user.click(screen.getByRole("button", { name: "New thread" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onNewThread).toHaveBeenCalledOnce();

    expect(screen.getByRole("button", { name: "New Project" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
  });

  it("lists current-mode hits with their folder label and keeps other modes out", async () => {
    const user = userEvent.setup();
    renderOverlay();

    await user.type(screen.getByRole("combobox"), "release");

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Release checklistOctant",
      "Release notesUnfiled",
      "Release archiveUnfiledArchived",
    ]);
    expect(screen.queryByText("Release branch")).toBeNull();
  });

  it("groups archived hits after live ones and marks them in words", async () => {
    const user = userEvent.setup();
    renderOverlay();

    await user.type(screen.getByRole("combobox"), "release");

    expect(screen.getByRole("group", { name: "Threads" })).toBeVisible();
    const archived = screen.getByRole("group", { name: "Archived" });
    expect(archived).toHaveTextContent("Archived");
    expect(screen.getByText("3 matching threads.")).toBeVisible();
  });

  it("moves the active option with the arrow keys and opens it with Enter", async () => {
    const user = userEvent.setup();
    const { onOpenThread } = renderOverlay();

    const field = screen.getByRole("combobox");
    await user.type(field, "release");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(field).toHaveAttribute("aria-activedescendant", "thread-search-option-2");
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Enter}");
    expect(onOpenThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t3", archived: true, folderLabel: "Unfiled" }),
    );
  });

  it("wraps arrow navigation and honours Home and End", async () => {
    const user = userEvent.setup();
    renderOverlay();

    const field = screen.getByRole("combobox");
    await user.type(field, "release");
    await user.keyboard("{ArrowUp}");
    expect(field).toHaveAttribute("aria-activedescendant", "thread-search-option-2");
    await user.keyboard("{Home}");
    expect(field).toHaveAttribute("aria-activedescendant", "thread-search-option-0");
    await user.keyboard("{End}");
    expect(field).toHaveAttribute("aria-activedescendant", "thread-search-option-2");
  });

  it("opens a clicked hit", async () => {
    const user = userEvent.setup();
    const { onOpenThread } = renderOverlay();

    await user.type(screen.getByRole("combobox"), "checklist");
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);

    expect(onOpenThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t1", projectId: "p1" }),
    );
  });

  it("dismisses on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = renderOverlay();

    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says so plainly when nothing matches", async () => {
    const user = userEvent.setup();
    renderOverlay();

    await user.type(screen.getByRole("combobox"), "nothing here");

    expect(screen.getByText("No matching threads.")).toBeVisible();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("never reports a refused archived listing as no matching threads", async () => {
    const user = userEvent.setup();
    renderOverlay({ archivedListing: "unavailable" });

    await user.type(screen.getByRole("combobox"), "nothing here");

    expect(
      screen.getByText("No matching live threads; archived threads are unavailable."),
    ).toBeVisible();
    expect(screen.queryByText("No matching threads.")).toBeNull();
  });

  it("never reports a refused message search as a complete empty match", async () => {
    const user = userEvent.setup();
    renderOverlay({ contentListing: "unavailable" });

    await user.type(screen.getByRole("combobox"), "nothing here");

    expect(screen.getByText("No matching threads; message search is unavailable.")).toBeVisible();
    expect(screen.queryByText("No matching threads.")).toBeNull();
  });

  it("never reports a refused host thread list as a complete empty match", async () => {
    const user = userEvent.setup();
    renderOverlay({ listing: "unavailable", threads: [] });

    await user.type(screen.getByRole("combobox"), "nothing here");

    expect(
      screen.getByText("No matching threads; the host thread list is unavailable."),
    ).toBeVisible();
    expect(screen.queryByText("No matching threads.")).toBeNull();
  });

  it("waits for the host thread list before reporting a complete empty match", async () => {
    const user = userEvent.setup();
    renderOverlay({ listing: "loading", threads: [] });

    await user.type(screen.getByRole("combobox"), "nothing here");

    expect(
      screen.getByText("No matching threads yet; more results are still loading."),
    ).toBeVisible();
    expect(screen.queryByText("No matching threads.")).toBeNull();
  });

  it("warns in words when the host thread list is not fully loaded", () => {
    renderOverlay({ listing: "loading" });

    expect(
      screen.getByText("Threads are still loading, so these results may be incomplete."),
    ).toBeVisible();
  });

  it("warns in words when the host thread list is unavailable", () => {
    renderOverlay({ listing: "unavailable", threads: [] });

    expect(
      screen.getByText("The host thread list is unavailable, so Search has nothing to match."),
    ).toBeVisible();
  });
});
