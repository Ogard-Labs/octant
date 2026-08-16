import {
  decodeChatThreadId,
  decodeThreadWorkItemId,
  type ThreadFollowUp,
  type ThreadWorkItem,
} from "@octant/contracts/chat";
import type { AggregateVersion } from "@octant/contracts/events";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadWorkShelf } from "./ThreadWorkShelf";

const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000611");
const itemId = decodeThreadWorkItemId("00000000-0000-4000-8000-000000000612");
const completedItemId = decodeThreadWorkItemId("00000000-0000-4000-8000-000000000613");
const timestamp = "2026-07-20T09:00:00.000Z" as ThreadWorkItem["createdAt"];
const version = 4 as AggregateVersion;

const currentItems: ReadonlyArray<ThreadWorkItem> = [
  {
    id: itemId,
    threadId,
    title: "Confirm the design",
    detail: "Waiting for a product decision",
    status: "blocked",
    position: 0,
    origin: "user",
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    id: decodeThreadWorkItemId("00000000-0000-4000-8000-000000000614"),
    threadId,
    title: "Draft the release note",
    status: "in-progress",
    position: 1,
    origin: "agent",
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];

const completedItem: ThreadWorkItem = {
  id: completedItemId,
  threadId,
  title: "Collect requirements",
  status: "completed",
  position: 2,
  origin: "user",
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const openFollowUp: ThreadFollowUp = {
  threadId,
  state: "open",
  origin: "manual",
  reason: "Review the draft before delivery",
  triggerSequence: 8,
  acknowledgedThroughSequence: 0,
  createdAt: timestamp,
};

function renderShelf(overrides: Partial<React.ComponentProps<typeof ThreadWorkShelf>> = {}) {
  return render(
    <ThreadWorkShelf
      aggregateVersion={version}
      followUpVersion={9 as AggregateVersion}
      followUp={openFollowUp}
      items={[...currentItems, completedItem]}
      {...overrides}
    />,
  );
}

describe("ThreadWorkShelf", () => {
  it("always shows unfinished and blocked counts with a non-color follow-up marker", () => {
    renderShelf();

    expect(screen.getByRole("button", { name: "Work list: 2 remaining, 1 blocked" })).toBeVisible();
    expect(screen.getByText("Work list · 2 remaining · 1 blocked")).toBeVisible();
    expect(screen.getByRole("status", { name: "Follow-up required" })).toHaveTextContent(
      "Follow-up required: Review the draft before delivery",
    );
  });

  it("expands with the keyboard, exposes current states, and keeps history collapsed", async () => {
    const user = userEvent.setup();
    renderShelf();

    const toggle = screen.getByRole("button", { name: "Work list: 2 remaining, 1 blocked" });
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("list", { name: "Current work" })).toBeVisible();
    expect(screen.getByText("Blocked")).toBeVisible();
    expect(screen.getByText("In progress")).toBeVisible();
    expect(screen.getByText("Waiting for a product decision")).toBeVisible();
    expect(screen.getByRole("button", { name: "Completed history, 1 item" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("Collect requirements")).not.toBeInTheDocument();
  });

  it("sends edit and complete commands only through explicit callbacks using caller aggregate data", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onComplete = vi.fn();
    renderShelf({ onEdit, onComplete });

    await user.click(screen.getByRole("button", { name: "Work list: 2 remaining, 1 blocked" }));
    await user.click(screen.getByRole("button", { name: "Edit Confirm the design" }));
    const title = screen.getByLabelText("Title for Confirm the design");
    await user.clear(title);
    await user.type(title, "Confirm revised design");
    await user.click(screen.getByRole("button", { name: "Save Confirm the design" }));

    expect(onEdit).toHaveBeenCalledWith({
      kind: "edit-chat-work-item",
      threadId,
      expectedVersion: version,
      itemId,
      title: "Confirm revised design",
      detail: "Waiting for a product decision",
    });

    await user.click(screen.getByRole("button", { name: "Complete Draft the release note" }));
    expect(onComplete).toHaveBeenCalledWith({
      kind: "complete-chat-work-item",
      threadId,
      expectedVersion: version,
      itemId: currentItems[1]!.id,
    });
  });

  it("completes follow-up explicitly with the authoritative follow-up aggregate version", async () => {
    const user = userEvent.setup();
    const onCompleteFollowUp = vi.fn();
    renderShelf({ onCompleteFollowUp });

    await user.click(screen.getByRole("button", { name: "Complete follow-up" }));
    expect(onCompleteFollowUp).toHaveBeenCalledWith({
      kind: "complete-chat-follow-up",
      threadId,
      expectedVersion: 9,
      acknowledgedThroughSequence: 8,
    });
  });

  it("keeps the shelf as counts in narrow mode until explicitly expanded", async () => {
    const user = userEvent.setup();
    renderShelf({ narrow: true });

    expect(screen.getByText("2 remaining · 1 blocked")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Current work" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Work list: 2 remaining, 1 blocked" }));
    expect(screen.getByRole("list", { name: "Current work" })).toBeVisible();
  });
});
