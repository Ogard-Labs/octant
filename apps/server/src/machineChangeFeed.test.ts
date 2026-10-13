import { describe, expect, it } from "vitest";
import { MachineChangeFeed } from "./machineChangeFeed";

describe("MachineChangeFeed", () => {
  it("coalesces committed domains into cursor-ordered invalidations", async () => {
    const feed = new MachineChangeFeed();
    const controller = new AbortController();
    const stream = feed.subscribe({ afterSequence: 0, signal: controller.signal });

    feed.publishCommitted({
      events: [
        { aggregateType: "work-turn" },
        { aggregateType: "work-thread" },
        {
          aggregateType: "code-operation",
          payload: { event: { kind: "operation-state" } },
        },
      ],
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "changed",
        sequence: 1,
        topics: ["work-navigation", "code-navigation"],
      },
    });
    controller.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("invalidates the Work and Code navigation reads only for a subagent's approval or question, asked and settled", async () => {
    const feed = new MachineChangeFeed();
    const controller = new AbortController();
    const stream = feed.subscribe({ afterSequence: 0, signal: controller.signal });
    const harness = "native-harness-session";
    const source = { runId: "00000000-0000-4000-8000-000000000090" };

    // A lead's own request, a turn event, and a settle nobody listed publish nothing.
    feed.publishCommitted({
      events: [
        {
          aggregateType: harness,
          eventName: "native-harness-approval-asked@1",
          payload: { id: "lead-approval" },
        },
        {
          aggregateType: harness,
          eventName: "native-harness-question-asked@1",
          payload: { id: "lead-question" },
        },
        {
          aggregateType: harness,
          eventName: "native-harness-approval-settled@1",
          payload: { approvalId: "lead-approval" },
        },
        {
          aggregateType: harness,
          eventName: "native-harness-question-settled@1",
          payload: { questionId: "lead-question" },
        },
        { aggregateType: harness, eventName: "native-harness-turn-settled@1" },
      ],
    });
    expect(feed.head()).toBe(0);

    feed.publishCommitted({
      events: [
        {
          aggregateType: harness,
          eventName: "native-harness-approval-asked@1",
          payload: { id: "child-approval", source },
        },
      ],
    });
    feed.publishCommitted({
      events: [
        {
          aggregateType: harness,
          eventName: "native-harness-question-asked@1",
          payload: { id: "child-question", source },
        },
      ],
    });
    feed.publishCommitted({
      events: [
        {
          aggregateType: harness,
          eventName: "native-harness-approval-settled@1",
          payload: { approvalId: "child-approval" },
        },
        {
          aggregateType: harness,
          eventName: "native-harness-question-settled@1",
          payload: { questionId: "child-question" },
        },
      ],
    });
    // The same settle again has nothing left to invalidate.
    feed.publishCommitted({
      events: [
        {
          aggregateType: harness,
          eventName: "native-harness-approval-settled@1",
          payload: { approvalId: "child-approval" },
        },
      ],
    });

    for (const sequence of [1, 2, 3]) {
      await expect(stream.next()).resolves.toMatchObject({
        value: { sequence, topics: ["work-navigation", "code-navigation"] },
      });
    }
    controller.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    expect(feed.head()).toBe(3);
  });

  it("requires a snapshot when the requested cursor fell outside replay", async () => {
    const feed = new MachineChangeFeed({ maxFrames: 1 });
    feed.publish(["chat-navigation"]);
    feed.publish(["work-navigation"]);

    const stream = feed.subscribe({ afterSequence: 0, signal: new AbortController().signal });

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "snapshot-required", sequence: 2 },
    });
  });

  it("requires a snapshot instead of overfilling a subscriber with retained replay", async () => {
    const feed = new MachineChangeFeed();
    for (let index = 0; index < 33; index += 1) feed.publish(["projects"]);

    const stream = feed.subscribe({ afterSequence: 0, signal: new AbortController().signal });

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "snapshot-required", sequence: 33 },
    });
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("requires a snapshot when a client reconnects with a cursor from an older host process", async () => {
    const feed = new MachineChangeFeed();
    const stream = feed.subscribe({ afterSequence: 42, signal: new AbortController().signal });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "snapshot-required", sequence: 0 },
    });
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("does not invalidate Code navigation for provider text deltas", async () => {
    const feed = new MachineChangeFeed();
    const controller = new AbortController();
    const stream = feed.subscribe({ afterSequence: 0, signal: controller.signal });

    feed.publishCommitted({
      events: [
        {
          aggregateType: "code-operation",
          payload: { event: { kind: "provider-content" } },
        },
      ],
    });
    feed.publish(["projects"]);

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "changed", sequence: 1, topics: ["projects"] },
    });
    controller.abort();
  });
});
