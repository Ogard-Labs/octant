import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeThreadWakeup, type ThreadWakeup } from "@octant/contracts";
import { ThreadWakeups } from "./ThreadWakeups";
import type { ThreadWakeupClient } from "./threadWakeupClient";

const threadId = "22222222-2222-4222-8222-222222222222";

function wakeup(id: string, status: "pending" | "missed", prompt: string): ThreadWakeup {
  return decodeThreadWakeup({
    id,
    mode: "code",
    threadId,
    providerToolName: "ScheduleWakeup",
    prompt,
    schedule: { kind: "delay" },
    humanSchedule: "Once at 2026-11-14T12:05:00.000Z",
    createdAt: "2026-11-14T12:00:00.000Z",
    nextFireAt: "2026-11-14T12:05:00.000Z",
    status,
  });
}

describe("thread wake-ups", () => {
  it("shows each wake-up's time with Cancel, and lets the person run or cancel a missed one", async () => {
    const user = userEvent.setup();
    let waiting = [
      wakeup("22222222-2222-4222-8222-000000000001", "pending", "Check the build."),
      wakeup("22222222-2222-4222-8222-000000000002", "missed", "Resume the migration."),
    ];
    const execute = vi.fn<ThreadWakeupClient["execute"]>(async (command) => {
      const target = waiting.find((item) => String(item.id) === String(command.wakeupId));
      waiting = waiting.filter((item) => item !== target);
      if (target === undefined) return { kind: "thread-wakeup-refused", message: "Gone." };
      return { kind: "thread-wakeup-updated", wakeup: { ...target, status: "ended" } };
    });
    const client: ThreadWakeupClient = { list: async () => waiting, execute };
    render(<ThreadWakeups mode="code" threadId={threadId} client={client} />);

    expect(await screen.findByText("Check the build.")).toBeTruthy();
    expect(screen.getByText(/^Wakes /)).toBeTruthy();
    expect(screen.getByText(/^Missed .* · Octant was not running$/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Run now" }));
    expect(execute).toHaveBeenCalledWith({
      kind: "run-missed-thread-wakeup",
      wakeupId: "22222222-2222-4222-8222-000000000002",
    });
    await waitFor(() => expect(screen.queryByText("Resume the migration.")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Cancel the wake-up: Check the build." }));
    expect(execute).toHaveBeenLastCalledWith({
      kind: "cancel-thread-wakeup",
      wakeupId: "22222222-2222-4222-8222-000000000001",
    });
    await waitFor(() => expect(screen.queryByLabelText("Scheduled wake-ups")).toBeNull());
  });

  it("shows nothing while the thread has no wake-ups", async () => {
    const list = vi.fn(async () => []);
    const { container } = render(
      <ThreadWakeups mode="work" threadId={threadId} client={{ list, execute: vi.fn() }} />,
    );
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
