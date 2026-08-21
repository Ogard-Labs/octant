import { describe, expect, it } from "vitest";
import {
  EMPTY_QUEUED_SEND,
  discardQueuedSend,
  disarmQueuedSend,
  enqueueQueuedSend,
  queuedHoldReason,
  queuedSendStatusMessage,
  settleQueuedSend,
} from "./queuedSend";

describe("queued send", () => {
  it("parks one follow-up while a turn is running and ignores a second enqueue", () => {
    const queued = enqueueQueuedSend(EMPTY_QUEUED_SEND, "thread-a", "running");
    expect(queued).toEqual({ status: "queued", threadKey: "thread-a" });
    expect(enqueueQueuedSend(queued, "thread-a", "running")).toBe(queued);
    expect(enqueueQueuedSend(EMPTY_QUEUED_SEND, "thread-a", "idle")).toBe(EMPTY_QUEUED_SEND);
  });

  it("sends once on completion and then forgets the intent", () => {
    const queued = enqueueQueuedSend(EMPTY_QUEUED_SEND, "thread-a", "running");
    expect(settleQueuedSend(queued, "thread-a", "running")).toEqual({
      next: queued,
      fire: false,
    });
    expect(settleQueuedSend(queued, "thread-a", "completed")).toEqual({
      next: EMPTY_QUEUED_SEND,
      fire: true,
    });
  });

  it("holds the message with a reason when the turn is cancelled, failed, or refused", () => {
    const queued = enqueueQueuedSend(EMPTY_QUEUED_SEND, "thread-a", "running");
    expect(settleQueuedSend(queued, "thread-a", "cancelled")).toEqual({
      next: {
        status: "held",
        threadKey: "thread-a",
        reason: queuedHoldReason("cancelled"),
      },
      fire: false,
    });
    expect(settleQueuedSend(queued, "thread-a", "failed").fire).toBe(false);
    expect(settleQueuedSend(queued, "thread-a", "refused").next).toMatchObject({
      status: "held",
      reason: queuedHoldReason("refused"),
    });
    expect(settleQueuedSend(queued, "thread-a", "completed").fire).toBe(true);
  });

  it("holds the message when the turn ends as waiting", () => {
    const queued = enqueueQueuedSend(EMPTY_QUEUED_SEND, "thread-a", "running");
    expect(settleQueuedSend(queued, "thread-a", "waiting")).toEqual({
      next: {
        status: "held",
        threadKey: "thread-a",
        reason: queuedHoldReason("waiting"),
      },
      fire: false,
    });
  });

  it("does not fire after the user discards it or leaves the thread", () => {
    const queued = enqueueQueuedSend(EMPTY_QUEUED_SEND, "thread-a", "running");
    expect(settleQueuedSend(discardQueuedSend(), "thread-a", "completed").fire).toBe(false);
    expect(disarmQueuedSend(queued, "thread-b")).toEqual(EMPTY_QUEUED_SEND);
    expect(settleQueuedSend(queued, "thread-b", "completed")).toEqual({
      next: EMPTY_QUEUED_SEND,
      fire: false,
    });
    expect(settleQueuedSend(queued, undefined, "completed").fire).toBe(false);
  });

  it("says the composer is queued, and the hold reason when it must not send", () => {
    const queued = enqueueQueuedSend(EMPTY_QUEUED_SEND, "thread-a", "running");
    expect(queuedSendStatusMessage(queued)).toBe(
      "This message is queued and will send when the response finishes.",
    );
    const held = settleQueuedSend(queued, "thread-a", "failed").next;
    expect(queuedSendStatusMessage(held)).toBe(queuedHoldReason("failed"));
    expect(queuedSendStatusMessage(EMPTY_QUEUED_SEND)).toBeUndefined();
  });
});
