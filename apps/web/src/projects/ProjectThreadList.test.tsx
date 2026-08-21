import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectThreadRows } from "./ProjectThreadList";

const thread = {
  threadId: "thread-one",
  title: "Controller foundation",
  provider: { displayName: "Claude", driverKind: "claude" },
} as const;

describe("ProjectThreadRows", () => {
  it("names a thread's provider and leaves its model off the row", () => {
    render(
      <ProjectThreadRows
        onSelectThread={vi.fn()}
        threads={[{ ...thread, meta: "gpt-5.6-luna" }]}
      />,
    );

    expect(screen.getByTitle("Claude")).toBeVisible();
    expect(screen.queryByText("gpt-5.6-luna")).toBeNull();
  });

  it("says a thread needs attention through a labelled dot rather than a badge", () => {
    render(
      <ProjectThreadRows
        onSelectThread={vi.fn()}
        threads={[{ ...thread, activity: "attention" }]}
      />,
    );

    expect(screen.getByRole("img", { name: "Needs attention" })).toBeVisible();
    expect(screen.queryByText("active")).toBeNull();
  });

  it("pins a thread from its own right-click menu", async () => {
    const onPinThread = vi.fn();
    render(
      <ProjectThreadRows actions={{ onPinThread }} onSelectThread={vi.fn()} threads={[thread]} />,
    );

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));

    expect(onPinThread).toHaveBeenCalledWith("thread-one", true);
  });

  it("renames a thread in place from its own right-click menu", async () => {
    const onRenameThread = vi.fn();
    render(
      <ProjectThreadRows
        onRenameThread={onRenameThread}
        onSelectThread={vi.fn()}
        threads={[thread]}
      />,
    );

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const field = screen.getByRole("textbox", { name: "Rename thread" });
    await userEvent.clear(field);
    await userEvent.type(field, "Second direction{Enter}");

    expect(onRenameThread).toHaveBeenCalledWith("thread-one", "Second direction");
  });

  it("marks an unread thread read from its right-click menu, never unread", async () => {
    const onMarkThreadRead = vi.fn();
    const onMarkThreadUnread = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onMarkThreadRead, onMarkThreadUnread }}
        onSelectThread={vi.fn()}
        threads={[{ ...thread, unread: true }]}
      />,
    );

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });

    expect(screen.queryByRole("menuitem", { name: "Mark as unread" })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Mark as read" }));

    expect(onMarkThreadRead).toHaveBeenCalledWith("thread-one");
    expect(onMarkThreadUnread).not.toHaveBeenCalled();
  });

  it("marks a read thread unread from its right-click menu, never read", async () => {
    const onMarkThreadRead = vi.fn();
    const onMarkThreadUnread = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onMarkThreadRead, onMarkThreadUnread }}
        onSelectThread={vi.fn()}
        threads={[thread]}
      />,
    );

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });

    expect(screen.queryByRole("menuitem", { name: "Mark as read" })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Mark as unread" }));

    expect(onMarkThreadUnread).toHaveBeenCalledWith("thread-one");
    expect(onMarkThreadRead).not.toHaveBeenCalled();
  });

  it("marks a thread for follow-up from its right-click menu, never completing one it lacks", async () => {
    const onCompleteFollowUp = vi.fn();
    const onMarkFollowUp = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onCompleteFollowUp, onMarkFollowUp }}
        onSelectThread={vi.fn()}
        threads={[thread]}
      />,
    );

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });

    expect(screen.queryByRole("menuitem", { name: "Complete follow-up" })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Mark for follow-up" }));

    expect(onMarkFollowUp).toHaveBeenCalledWith("thread-one");
    expect(onCompleteFollowUp).not.toHaveBeenCalled();
  });

  it("completes an open follow-up from its right-click menu, never marking a second one", async () => {
    const onCompleteFollowUp = vi.fn();
    const onMarkFollowUp = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onCompleteFollowUp, onMarkFollowUp }}
        onSelectThread={vi.fn()}
        threads={[{ ...thread, followUp: true }]}
      />,
    );

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });

    expect(screen.queryByRole("menuitem", { name: "Mark for follow-up" })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Complete follow-up" }));

    expect(onCompleteFollowUp).toHaveBeenCalledWith("thread-one");
    expect(onMarkFollowUp).not.toHaveBeenCalled();
  });

  it("exports a thread from its own right-click menu", async () => {
    const onExportThread = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onExportThread }}
        onSelectThread={vi.fn()}
        threads={[thread]}
      />,
    );

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Export…" }));

    expect(onExportThread).toHaveBeenCalledWith("thread-one", "Controller foundation");
  });

  it("offers no export when the host resolves no export client", async () => {
    render(
      <ProjectThreadRows
        actions={{ onPinThread: vi.fn() }}
        onSelectThread={vi.fn()}
        threads={[thread]}
      />,
    );

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });

    expect(await screen.findByRole("menuitem", { name: "Pin" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Export…" })).toBeNull();
  });

  it("leaves the rows without a menu when the host offers no thread actions", async () => {
    render(<ProjectThreadRows onSelectThread={vi.fn()} threads={[thread]} />);

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });

    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
