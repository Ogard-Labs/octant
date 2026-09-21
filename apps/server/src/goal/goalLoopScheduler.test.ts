import { describe, expect, it, vi } from "vitest";
import { GoalLoopScheduler } from "./goalLoopScheduler";

describe("GoalLoopScheduler", () => {
  it("takes the next round without the previous one recursing into it", async () => {
    const advance = vi.fn(async () => undefined);
    const scheduler = new GoalLoopScheduler({ advance });

    scheduler.schedule("thread-1");
    scheduler.schedule("thread-1");

    await vi.waitFor(() => expect(advance).toHaveBeenCalledOnce());
    expect(advance).toHaveBeenCalledWith("thread-1");
  });

  it("keeps circulating for a thread that pauses between rounds rather than queueing a backlog", async () => {
    const seen: string[] = [];
    let running = false;
    const advance = vi.fn(async (threadId: string) => {
      expect(running).toBe(false);
      running = true;
      seen.push(threadId);
      running = false;
    });
    const scheduler = new GoalLoopScheduler({ advance });

    scheduler.schedule("thread-1");
    await vi.waitFor(() => expect(seen).toEqual(["thread-1"]));

    scheduler.schedule("thread-1");
    await vi.waitFor(() => expect(seen).toEqual(["thread-1", "thread-1"]));
  });

  it("keeps a failed advance from killing circulation for later rounds", async () => {
    const advance = vi
      .fn<(threadId: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("round blew up"))
      .mockResolvedValue(undefined);
    const scheduler = new GoalLoopScheduler({ advance });

    scheduler.schedule("thread-1");
    await vi.waitFor(() => expect(advance).toHaveBeenCalledOnce());

    scheduler.schedule("thread-1");
    await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(2));
  });

  it("runs the queued round after the current round finished cleaning up", async () => {
    // A service may schedule the next round from inside its own try block,
    // before a finally clears the in-flight marker. The microtask queue
    // guarantees the cleanup runs first; this test holds that contract.
    const order: string[] = [];
    let inFlight = true;
    const advance = vi.fn(async () => {
      order.push(`advance(inFlight=${inFlight})`);
    });
    const scheduler = new GoalLoopScheduler({ advance });

    // Simulate the service calling schedule() before its finally block.
    scheduler.schedule("thread-1");
    order.push("cleanup");
    inFlight = false;

    await vi.waitFor(() => expect(advance).toHaveBeenCalledOnce());
    expect(order).toEqual(["cleanup", "advance(inFlight=false)"]);
  });
});
