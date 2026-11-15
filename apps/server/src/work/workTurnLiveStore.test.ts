import {
  WORK_TURN_CAPABILITIES,
  decodeWorkThreadId,
  decodeWorkTurnRequestId,
  decodeWorkTurnState,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { SETTLED_REPLAY_RETENTION_MS, WorkTurnLiveStore } from "./workTurnLiveStore";

const threadId = decodeWorkThreadId("10000000-0000-4000-8000-000000000101");
const requestId = decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

function settledTurn() {
  const now = "2026-08-11T12:00:00.000Z";
  return decodeWorkTurnState({
    requestId,
    threadId,
    turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    authority: {
      hostId: "local",
      projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      bindingRevisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      workingDirectory: ".",
      confinementPosture: "project-root-confined",
      providerInstanceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      modelId: "gpt-5",
    },
    providerSessionId: "11111111-1111-4111-8111-111111111111",
    prompt: "Continue",
    capabilities: WORK_TURN_CAPABILITIES,
    acceptedAt: now,
    status: "completed",
    transcript: [{ role: "user", text: "Continue" }],
    version: 2,
    updatedAt: now,
  });
}

describe("WorkTurnLiveStore", () => {
  it("replays a settled turn to a late view, then releases its frames once nobody reads them", async () => {
    vi.useFakeTimers();
    try {
      const store = new WorkTurnLiveStore();
      store.appendResponse(threadId, requestId, "answer");
      store.settle(threadId, settledTurn());

      const late = store.subscribe({
        threadId,
        afterSequence: 0,
        signal: new AbortController().signal,
      });
      await expect(late.next()).resolves.toMatchObject({ value: { kind: "response-delta" } });
      await expect(late.next()).resolves.toMatchObject({ value: { kind: "turn-settled" } });
      await late.return(undefined);

      vi.advanceTimersByTime(SETTLED_REPLAY_RETENTION_MS);

      // The frames are gone but the sequence is not: an older cursor is sent
      // to the snapshot, and the current head keeps following the thread.
      expect(store.head(threadId)).toBe(2);
      const older = store.subscribe({
        threadId,
        afterSequence: 0,
        signal: new AbortController().signal,
      });
      await expect(older.next()).resolves.toMatchObject({
        value: { kind: "snapshot-required", sequence: 2 },
      });
      const current = store.subscribe({
        threadId,
        afterSequence: 2,
        signal: new AbortController().signal,
      });
      const next = current.next();
      store.appendResponse(threadId, requestId, "again");
      await expect(next).resolves.toMatchObject({
        value: { kind: "response-delta", sequence: 3, text: "again" },
      });
      await current.return(undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects replay bounds that could loop forever or grow without limit", () => {
    for (const maxFramesPerThread of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new WorkTurnLiveStore({ maxFramesPerThread })).toThrow(
        "Work turn replay frame bound must be a positive safe integer.",
      );
    }
  });

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

  it("publishes the provider's restated task list in cursor order with the deltas", async () => {
    const store = new WorkTurnLiveStore();
    const controller = new AbortController();
    const stream = store.subscribe({ threadId, afterSequence: 0, signal: controller.signal });

    store.appendResponse(threadId, requestId, "first");
    store.appendTasks(threadId, requestId, [
      { taskId: "task-1", state: "running", summary: "Watch CI" },
    ]);
    store.appendTasks(threadId, requestId, [
      { taskId: "task-1", state: "completed", summary: "Watch CI" },
    ]);

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "response-delta", sequence: 1, text: "first" },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "turn-tasks", sequence: 2, requestId, tasks: [{ taskId: "task-1" }] },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "turn-tasks", sequence: 3, tasks: [{ taskId: "task-1" }] },
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
