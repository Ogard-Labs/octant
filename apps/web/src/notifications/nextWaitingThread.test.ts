import { describe, expect, it } from "vitest";
import type { ThreadAttentionSignal } from "./threadAttention";
import { nextWaitingThread } from "./nextWaitingThread";

function signal(
  threadId: string,
  reason: ThreadAttentionSignal["reason"],
  title = threadId,
): ThreadAttentionSignal {
  return { threadId, reason, title, source: "code" };
}

describe("nextWaitingThread", () => {
  it("returns nothing when no thread waits on the person", () => {
    expect(nextWaitingThread([], undefined)).toBeUndefined();
    expect(nextWaitingThread([signal("a", "follow-up-due")], undefined)).toBeUndefined();
  });

  it("starts with approvals, then questions, then finished turns", () => {
    const signals = [
      signal("finished", "turn-finished"),
      signal("question", "question-asked"),
      signal("approval", "approval-required"),
    ];
    const order: string[] = [];
    let current: string | undefined;
    for (let step = 0; step < 3; step += 1) {
      const next = nextWaitingThread(signals, current);
      order.push(next?.threadId ?? "none");
      current = next?.threadId;
    }
    expect(order).toEqual(["approval", "question", "finished"]);
  });

  it("wraps from the last waiting thread back to the first", () => {
    const signals = [signal("a", "approval-required"), signal("b", "turn-finished")];
    expect(nextWaitingThread(signals, "b")?.threadId).toBe("a");
  });

  it("lists a thread once, at its strongest reason", () => {
    const signals = [signal("a", "turn-finished"), signal("a", "approval-required")];
    expect(nextWaitingThread(signals, undefined)?.reason).toBe("approval-required");
    expect(nextWaitingThread(signals, "a")?.threadId).toBe("a");
  });

  it("starts at the first when the open thread is not waiting", () => {
    const signals = [signal("a", "question-asked"), signal("b", "question-asked")];
    expect(nextWaitingThread(signals, "elsewhere")?.threadId).toBe("a");
  });
});
