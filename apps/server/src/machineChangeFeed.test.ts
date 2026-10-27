import { describe, expect, it } from "vitest";
import {
  NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
  NATIVE_HARNESS_SESSION_EVENT_NAMES,
  THREAD_RETENTION_EVENT_NAMES,
} from "@octant/contracts";
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

  it("tells a subscriber when an image job is queued or finishes", async () => {
    const feed = new MachineChangeFeed();
    const controller = new AbortController();
    const stream = feed.subscribe({ afterSequence: 0, signal: controller.signal });

    feed.publishCommitted({ events: [{ aggregateType: "image-job" }] });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "changed", sequence: 1, topics: ["image-jobs"] },
    });
    controller.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("wakes held Chat streams when a Chat session's compaction ends, and for nothing else on the ledger", async () => {
    const feed = new MachineChangeFeed();
    const controller = new AbortController();
    const stream = feed.subscribe({ afterSequence: 0, signal: controller.signal });
    const chat = { aggregateType: "chat-thread", aggregateId: "thread-1" };
    const work = { aggregateType: "work-thread", aggregateId: "thread-2" };

    feed.publishCommitted({
      events: [
        { aggregateType: "context-ledger", eventName: "context.plan-created@1", payload: {} },
        {
          aggregateType: "context-ledger",
          eventName: "context.compaction-requested@1",
          payload: { subject: chat },
        },
        {
          aggregateType: "context-ledger",
          eventName: "context.compaction-failed@1",
          payload: { subject: work },
        },
      ],
    });
    feed.publishCommitted({
      events: [
        {
          aggregateType: "context-ledger",
          eventName: "context.compaction-completed@1",
          payload: { receipt: { subject: chat } },
        },
      ],
    });
    feed.publishCommitted({
      events: [
        {
          aggregateType: "context-ledger",
          eventName: "context.compaction-failed@1",
          payload: { subject: chat },
        },
      ],
    });

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "changed", topics: ["chat-navigation"] },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "changed", topics: ["chat-navigation"] },
    });
    controller.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("invalidates the navigation reads for every harness approval and question, asked and settled", async () => {
    const feed = new MachineChangeFeed();
    const controller = new AbortController();
    const stream = feed.subscribe({ afterSequence: 0, signal: controller.signal });
    const harness = "native-harness-session";
    const source = { runId: "00000000-0000-4000-8000-000000000090" };

    // A turn event alone publishes nothing.
    feed.publishCommitted({
      events: [{ aggregateType: harness, eventName: "native-harness-turn-settled@1" }],
    });
    expect(feed.head()).toBe(0);

    // The lead's own approval, and its settle, move every mode's sidebar and board.
    feed.publishCommitted({
      events: [
        {
          aggregateType: harness,
          eventName: "native-harness-approval-asked@1",
          payload: { id: "lead-approval" },
        },
      ],
    });
    feed.publishCommitted({
      events: [
        {
          aggregateType: harness,
          eventName: "native-harness-approval-settled@1",
          payload: { approvalId: "lead-approval" },
        },
      ],
    });
    // An approval a restart left behind is settled by a resume that never saw the ask.
    feed.publishCommitted({
      events: [
        {
          aggregateType: harness,
          eventName: "native-harness-approval-settled@1",
          payload: { approvalId: "left-by-restart" },
        },
      ],
    });
    for (const sequence of [1, 2, 3]) {
      await expect(stream.next()).resolves.toMatchObject({
        value: {
          sequence,
          topics: ["chat-navigation", "work-navigation", "code-navigation"],
        },
      });
    }

    // A question, the lead's own or a subagent's, parks a Work or Code thread
    // on the person, so its ask and its settle move those sidebars and boards.
    // A Chat lead's question is journaled on the Chat attempt instead.
    feed.publishCommitted({
      events: [
        {
          aggregateType: harness,
          eventName: "native-harness-question-asked@1",
          payload: { id: "lead-question" },
        },
      ],
    });
    feed.publishCommitted({
      events: [
        {
          aggregateType: harness,
          eventName: "native-harness-question-settled@1",
          payload: { questionId: "lead-question" },
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
          eventName: "native-harness-question-settled@1",
          payload: { questionId: "child-question" },
        },
      ],
    });
    for (const sequence of [4, 5, 6, 7]) {
      await expect(stream.next()).resolves.toMatchObject({
        value: { sequence, topics: ["work-navigation", "code-navigation"] },
      });
    }
    controller.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    expect(feed.head()).toBe(7);
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

  it("maps each durable auxiliary aggregate to its own metadata topic", async () => {
    const feed = new MachineChangeFeed();
    const controller = new AbortController();
    const stream = feed.subscribe({ afterSequence: 0, signal: controller.signal });

    feed.publishCommitted({
      events: [
        { aggregateType: "browser-capture" },
        { aggregateType: "thread-side-tasks" },
        { aggregateType: "thread-follow-up-suggestions" },
        { aggregateType: "thread-message-queue" },
      ],
    });

    await expect(stream.next()).resolves.toMatchObject({
      value: {
        kind: "changed",
        sequence: 1,
        topics: ["browser-captures", "thread-follow-ups", "thread-message-queue"],
      },
    });
    controller.abort();
  });

  it("maps a harness's suggested and activated follow-ups but not its ordinary deltas", async () => {
    const feed = new MachineChangeFeed();
    const controller = new AbortController();
    const stream = feed.subscribe({ afterSequence: 0, signal: controller.signal });

    feed.publishCommitted({
      events: [
        {
          aggregateType: NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
          eventName: NATIVE_HARNESS_SESSION_EVENT_NAMES.followUpsSuggested,
        },
        {
          aggregateType: NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
          eventName: NATIVE_HARNESS_SESSION_EVENT_NAMES.followUpActivated,
        },
        {
          aggregateType: NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
          eventName: "native-harness-response-delta@1",
        },
      ],
    });
    feed.publish(["projects"]);

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "changed", sequence: 1, topics: ["thread-follow-ups"] },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "changed", sequence: 2, topics: ["projects"] },
    });
    controller.abort();
  });

  it("invalidates the durable auxiliary lists when a thread is deleted or purged", async () => {
    const feed = new MachineChangeFeed();
    const controller = new AbortController();
    const stream = feed.subscribe({ afterSequence: 0, signal: controller.signal });

    feed.publishCommitted({
      events: [{ aggregateType: "chat-thread", eventName: "chat.deleted@1" }],
    });
    feed.publishCommitted({
      events: [
        {
          aggregateType: "thread-retention",
          eventName: THREAD_RETENTION_EVENT_NAMES.threadPurged,
        },
      ],
    });

    await expect(stream.next()).resolves.toMatchObject({
      value: {
        kind: "changed",
        sequence: 1,
        topics: [
          "chat-navigation",
          "browser-captures",
          "thread-follow-ups",
          "thread-message-queue",
        ],
      },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        kind: "changed",
        sequence: 2,
        topics: ["browser-captures", "thread-follow-ups", "thread-message-queue"],
      },
    });
    controller.abort();
  });

  it("decodes every published topic under strict framing", async () => {
    const feed = new MachineChangeFeed();
    const controller = new AbortController();
    const stream = feed.subscribe({ afterSequence: 0, signal: controller.signal });

    feed.publish([
      "chat-navigation",
      "work-navigation",
      "code-navigation",
      "projects",
      "extensions",
      "computer-use",
      "image-jobs",
      "browser-captures",
      "tool-approvals",
      "thread-follow-ups",
      "thread-message-queue",
    ]);

    await expect(stream.next()).resolves.toMatchObject({
      value: {
        kind: "changed",
        sequence: 1,
        topics: [
          "chat-navigation",
          "work-navigation",
          "code-navigation",
          "projects",
          "extensions",
          "computer-use",
          "image-jobs",
          "browser-captures",
          "tool-approvals",
          "thread-follow-ups",
          "thread-message-queue",
        ],
      },
    });
    controller.abort();
  });
});
