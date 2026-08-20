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

  it("leaves the rows without a menu when the host offers no thread actions", async () => {
    render(<ProjectThreadRows onSelectThread={vi.fn()} threads={[thread]} />);

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });

    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
