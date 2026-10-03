import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  decodeThreadMessageQueueCommand,
  decodeThreadMessageQueueSnapshot,
} from "@octant/contracts";
import { ThreadMessageQueue } from "./ThreadMessageQueue";
import { useThreadMessageQueue } from "./useThreadMessageQueue";
import { queueTestHost } from "./queueTestHost.test-fixture";

const threadId = "11111111-1111-4111-8111-111111111111";
describe("compact message queue controls", () => {
  it("keeps messages collapsed, then exposes keyboard-operable edits, ordering, removal and pause", async () => {
    const user = userEvent.setup();
    const host = queueTestHost();
    for (const [index, prompt] of ["First", "Second"].entries())
      host.apply(
        decodeThreadMessageQueueCommand({
          kind: "enqueue",
          scope: { mode: "chat", threadId },
          requestId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          expectedVersion: index,
          payload: { mode: "chat", prompt },
        }),
      );
    function Harness() {
      return (
        <ThreadMessageQueue
          queue={useThreadMessageQueue({ mode: "chat", threadId, client: host })}
        />
      );
    }
    render(<Harness />);
    const toggle = await screen.findByRole("button", { name: "2 queued" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("First")).not.toBeVisible();
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("First")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Move queued message 2 up" }));
    await waitFor(() => expect(host.execute).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Edit queued message 1" }));
    const editor = screen.getByRole("textbox", { name: "Edit queued message 1" });
    await user.clear(editor);
    await user.type(editor, "Changed");
    await user.click(screen.getByRole("button", { name: "Save message" }));
    expect(await screen.findByText("Changed")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove queued message 2" }));
    expect(await screen.findByRole("button", { name: "1 queued" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pause queue" }));
    expect(await screen.findByRole("button", { name: "Resume queue" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Resume queue" }));
    expect(await screen.findByRole("button", { name: "Pause queue" })).toBeVisible();
    expect(host.execute.mock.calls.map(([command]) => command.kind)).toEqual([
      "reorder",
      "edit",
      "remove",
      "pause",
      "resume",
    ]);
  });

  it("reorders queued messages without moving an accepted item", async () => {
    const host = queueTestHost();
    const user = userEvent.setup();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const snapshot = decodeThreadMessageQueueSnapshot({
      scope: { mode: "chat", threadId },
      version: 3,
      paused: false,
      items: ids.map((messageId, index) => ({
        messageId,
        status: index === 0 ? "accepted" : "queued",
        revision: 0,
        createdAt: "2026-10-03T10:00:00.000Z",
        payload: { mode: "chat", prompt: `Message ${index}` },
      })),
    });
    host.publish(snapshot);
    function Harness() {
      return (
        <ThreadMessageQueue
          queue={useThreadMessageQueue({ mode: "chat", threadId, client: host })}
        />
      );
    }
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "2 queued · 1 active" }));
    expect(screen.getByRole("button", { name: "Edit queued message 1" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move queued message 3 up" }));
    expect(host.execute.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ kind: "reorder", messageIds: [ids[0], ids[2], ids[1]] }),
    );
  });

  it("keeps unsaved text without overwriting a concurrent edit", async () => {
    const host = queueTestHost();
    const user = userEvent.setup();
    const initial = decodeThreadMessageQueueCommand({
      kind: "enqueue",
      scope: { mode: "chat", threadId },
      requestId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      expectedVersion: 0,
      payload: { mode: "chat", prompt: "Original" },
    });
    if (initial.kind !== "enqueue") throw new Error("Expected enqueue");
    host.apply(initial);
    function Harness() {
      return (
        <ThreadMessageQueue
          queue={useThreadMessageQueue({ mode: "chat", threadId, client: host })}
        />
      );
    }
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "1 queued" }));
    await user.click(screen.getByRole("button", { name: "Edit queued message 1" }));
    await user.type(screen.getByRole("textbox", { name: "Edit queued message 1" }), " locally");
    host.apply(
      decodeThreadMessageQueueCommand({
        kind: "edit",
        scope: initial.scope,
        expectedVersion: 1,
        requestId: crypto.randomUUID(),
        messageId: initial.messageId,
        prompt: "Changed elsewhere",
      }),
    );
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(await screen.findByText(/queue changed while you were editing/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Edit queued message 1" })).toHaveValue(
      "Original locally",
    );
    expect(screen.getByRole("button", { name: "Save message" })).toBeDisabled();
    expect(host.execute).not.toHaveBeenCalled();
  });

  it("keeps a restart hold visible while the messages are collapsed", async () => {
    const host = queueTestHost();
    host.read.mockImplementation(async (scope) => ({
      ...host.snapshot(scope),
      holdReason: "host-restart",
    }));
    function Harness() {
      return (
        <ThreadMessageQueue
          queue={useThreadMessageQueue({ mode: "code", threadId, client: host })}
        />
      );
    }
    render(<Harness />);
    expect(await screen.findByText(/The host restarted/)).toBeVisible();
    expect(screen.getByRole("button", { name: "0 queued" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
