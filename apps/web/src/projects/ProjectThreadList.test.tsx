import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectThreadRows } from "./ProjectThreadList";

const thread = {
  threadId: "thread-one",
  title: "Controller foundation",
  provider: { displayName: "Claude", driverKind: "claude" },
} as const;

describe("ProjectThreadRows", () => {
  it("keeps a long thread list bounded to the visible window", async () => {
    const threads = Array.from({ length: 80 }, (_, index) => ({
      threadId: `thread-${String(index)}`,
      title: `Thread ${String(index)}`,
    }));
    const container = document.createElement("div");
    container.style.height = "160px";
    container.style.overflowY = "auto";
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 160 });
    Object.defineProperty(container, "offsetHeight", { configurable: true, value: 160 });
    Object.defineProperty(container, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 320, 160),
    });
    document.body.append(container);
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    try {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get() {
          return this.hasAttribute("data-index")
            ? 32
            : (offsetHeightDescriptor?.get?.call(this) ?? 0);
        },
      });
      render(<ProjectThreadRows onSelectThread={vi.fn()} threads={threads} />, { container });

      await waitFor(() => {
        const rows = screen.getAllByRole("button");
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(threads.length);
      });
    } finally {
      if (offsetHeightDescriptor === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
      } else {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
      }
      container.remove();
    }
  });

  it("names a thread's provider and leaves its model off the row", () => {
    render(
      <ProjectThreadRows
        onSelectThread={vi.fn()}
        threads={[{ ...thread, meta: "gpt-5.6-luna" }]}
      />,
    );

    expect(screen.getByTitle("Claude")).toBeVisible();
    expect(screen.queryByText("gpt-5.6-luna")).toBeNull();
    const row = screen.getByRole("button", { name: /Controller foundation/ });
    const provider = row.querySelector(".sidebar-navigation__thread-provider");
    const title = row.querySelector(".sidebar-navigation__thread-copy");
    expect(provider?.nextElementSibling).toBe(title);
  });

  it("keeps activity at the left edge of the thread title", () => {
    render(
      <ProjectThreadRows onSelectThread={vi.fn()} threads={[{ ...thread, activity: "working" }]} />,
    );

    const row = screen.getByRole("button", { name: /Controller foundation/ });
    const activity = row.querySelector(".sidebar-navigation__thread-status");
    const provider = row.querySelector(".sidebar-navigation__thread-provider");
    const title = row.querySelector(".sidebar-navigation__thread-copy");
    expect(activity).toHaveAttribute("data-activity", "working");
    expect(activity?.compareDocumentPosition(provider ?? row)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(provider?.compareDocumentPosition(title ?? row)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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

  it("exposes context-menu semantics on the thread row trigger", async () => {
    render(
      <ProjectThreadRows
        actions={{ onPinThread: vi.fn() }}
        onSelectThread={vi.fn()}
        threads={[thread]}
      />,
    );

    const row = screen.getByRole("button", { name: /Controller foundation/ });
    expect(row).toHaveAttribute("aria-haspopup", "menu");
    expect(row).toHaveAttribute("aria-expanded", "false");

    await userEvent.pointer({ target: row, keys: "[MouseRight]" });
    expect(row).toHaveAttribute("aria-expanded", "true");
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

  it("places a thread in a new split pane from its own right-click menu", async () => {
    const onPinInPane = vi.fn();
    render(
      <ProjectThreadRows actions={{ onPinInPane }} onSelectThread={vi.fn()} threads={[thread]} />,
    );

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pin in pane" }));

    expect(onPinInPane).toHaveBeenCalledWith("thread-one");
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
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

  it("exposes a pin action in the thread row's trailing gutter without selecting the thread", async () => {
    const onPinThread = vi.fn();
    const onSelectThread = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onPinThread }}
        onSelectThread={onSelectThread}
        threads={[thread]}
      />,
    );

    const pin = screen.getByRole("button", { name: "Pin thread" });
    expect(pin).toBeInTheDocument();
    await userEvent.click(pin);

    expect(onPinThread).toHaveBeenCalledWith("thread-one", true);
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("exposes an unpin action when the thread is already pinned", async () => {
    const onPinThread = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onPinThread }}
        onSelectThread={vi.fn()}
        threads={[{ ...thread, pinned: true }]}
      />,
    );

    const unpin = screen.getByRole("button", { name: "Unpin thread" });
    await userEvent.click(unpin);

    expect(onPinThread).toHaveBeenCalledWith("thread-one", false);
  });

  it("exposes an archive action in the thread row's trailing gutter without selecting the thread", async () => {
    const onArchiveThread = vi.fn();
    const onSelectThread = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onArchiveThread }}
        onSelectThread={onSelectThread}
        threads={[thread]}
      />,
    );

    const archive = screen.getByRole("button", { name: "Archive thread" });
    await userEvent.click(archive);

    expect(onArchiveThread).toHaveBeenCalledWith("thread-one");
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("keeps the inline action gutter after the thread title so the row does not jump", () => {
    render(
      <ProjectThreadRows
        actions={{ onPinThread: vi.fn(), onArchiveThread: vi.fn() }}
        onSelectThread={vi.fn()}
        threads={[thread]}
      />,
    );

    const row = screen.getByRole("button", { name: /Controller foundation/ });
    const gutter = row.parentElement;
    expect(gutter).toHaveClass("sidebar-navigation__thread-row");
    expect(row.compareDocumentPosition(screen.getByRole("button", { name: "Pin thread" }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows a delayed info card with thread facts on hover", async () => {
    const user = userEvent.setup();
    render(
      <ProjectThreadRows
        onSelectThread={vi.fn()}
        projectNameForThread={() => "Core Project"}
        threads={[{ ...thread, pinned: true, unread: true }]}
      />,
    );

    const row = screen.getByRole("button", { name: /Controller foundation/ });
    await user.hover(row);

    const card = await screen.findByRole("tooltip");
    expect(card).toHaveTextContent("Controller foundation");
    expect(card).toHaveTextContent("Core Project");
    expect(card).toHaveTextContent("Pinned");
    expect(card).toHaveTextContent("Unread");
  });

  it("lets keyboard users reach and activate the pin action", async () => {
    const onPinThread = vi.fn();
    render(
      <ProjectThreadRows actions={{ onPinThread }} onSelectThread={vi.fn()} threads={[thread]} />,
    );

    const pin = screen.getByRole("button", { name: "Pin thread" });
    pin.focus();
    await userEvent.keyboard("{Enter}");

    expect(onPinThread).toHaveBeenCalledWith("thread-one", true);
  });

  it("exposes an overflow action that carries the same pin and archive actions", async () => {
    const onPinThread = vi.fn();
    const onArchiveThread = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onPinThread, onArchiveThread }}
        onSelectThread={vi.fn()}
        threads={[thread]}
      />,
    );

    const overflow = screen.getByRole("button", { name: "Thread actions" });
    expect(overflow).toBeInTheDocument();
    await userEvent.click(overflow);

    await userEvent.click(await screen.findByRole("menuitem", { name: "Pin thread" }));
    expect(onPinThread).toHaveBeenCalledWith("thread-one", true);

    await userEvent.click(overflow);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive thread" }));
    expect(onArchiveThread).toHaveBeenCalledWith("thread-one");
  });

  it("keeps pin and archive reachable from the right-click menu as secondary actions", async () => {
    const onPinThread = vi.fn();
    const onArchiveThread = vi.fn();
    render(
      <ProjectThreadRows
        actions={{ onPinThread, onArchiveThread }}
        onSelectThread={vi.fn()}
        threads={[thread]}
      />,
    );

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });

    await userEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    expect(onPinThread).toHaveBeenCalledWith("thread-one", true);

    await userEvent.pointer({
      target: screen.getByRole("button", { name: /Controller foundation/ }),
      keys: "[MouseRight]",
    });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(onArchiveThread).toHaveBeenCalledWith("thread-one");
  });

  it("omits an unparseable updated timestamp from the hover info card", async () => {
    const user = userEvent.setup();
    render(
      <ProjectThreadRows
        onSelectThread={vi.fn()}
        projectNameForThread={() => "Core Project"}
        threads={[{ ...thread, updatedAt: "not-a-date" }]}
      />,
    );

    const row = screen.getByRole("button", { name: /Controller foundation/ });
    await user.hover(row);

    const card = await screen.findByRole("tooltip");
    expect(card).not.toHaveTextContent("Updated");
    expect(card).not.toHaveTextContent("Invalid Date");
  });
});
