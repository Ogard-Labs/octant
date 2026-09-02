import { decodeWorkThreadId, decodeWorkTurnRequestId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { WorkTurnLiveStore } from "./workTurnLiveStore";

const threadId = decodeWorkThreadId("10000000-0000-4000-8000-000000000101");
const requestId = decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

describe("WorkTurnLiveStore", () => {
  it("publishes cursor-ordered response deltas without polling", async () => {
    const store = new WorkTurnLiveStore();
    const controller = new AbortController();
    const stream = store.subscribe({ threadId, afterSequence: 0, signal: controller.signal });

    store.appendResponse(threadId, requestId, "first");
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "response-delta", sequence: 1, threadId, requestId, text: "first" },
    });

    store.appendResponse(threadId, requestId, " second");
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "response-delta", sequence: 2, text: " second" },
    });

    controller.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("requires a fresh snapshot when a cursor falls behind the bounded replay", async () => {
    const store = new WorkTurnLiveStore({ maxFramesPerThread: 2 });
    store.appendResponse(threadId, requestId, "one");
    store.appendResponse(threadId, requestId, "two");
    store.appendResponse(threadId, requestId, "three");

    const stream = store.subscribe({
      threadId,
      afterSequence: 0,
      signal: new AbortController().signal,
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "snapshot-required", sequence: 3, threadId },
    });
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("requires a snapshot instead of overfilling a subscriber with retained replay", async () => {
    const store = new WorkTurnLiveStore();
    for (let index = 0; index < 33; index += 1) {
      store.appendResponse(threadId, requestId, String(index));
    }

    const stream = store.subscribe({
      threadId,
      afterSequence: 0,
      signal: new AbortController().signal,
    });

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "snapshot-required", sequence: 33, threadId },
    });
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("requires a fresh snapshot when a cursor belongs to an older host process", async () => {
    const store = new WorkTurnLiveStore();
    const stream = store.subscribe({
      threadId,
      afterSequence: 42,
      signal: new AbortController().signal,
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "snapshot-required", sequence: 0, threadId },
    });
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });
});
