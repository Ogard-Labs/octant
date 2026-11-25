import { describe, expect, it, vi } from "vitest";
import type { EventEnvelope, ThreadDeliveryMark } from "@octant/contracts";
import { SideTaskReportFailureWake } from "./sideTaskReportFailureWake";

const thread = "00000000-0000-4000-8000-0000000000aa";
const turn = "00000000-0000-4000-8000-0000000000bb";
const now = "2026-11-25T12:00:00.000Z";
const report = {
  kind: "side-task-report",
  reportIds: ["00000000-0000-4000-8000-0000000000cc"],
} as unknown as ThreadDeliveryMark;
const managed = {
  kind: "agent-result",
  runId: "00000000-0000-4000-8000-0000000000dd",
} as unknown as ThreadDeliveryMark;

const chat = (outcome: string) => ({
  eventName: "chat.attempt-updated@1",
  payload: {
    kind: "attempt-updated",
    attempt: {
      id: "00000000-0000-4000-8000-0000000000ee",
      turnId: turn,
      threadId: thread,
      providerInstanceId: "00000000-0000-4000-8000-0000000000e2",
      modelId: "model-1",
      providerSessionId: "00000000-0000-4000-8000-0000000000ef",
      contextManifestId: "00000000-0000-4000-8000-0000000000e1",
      outcome,
      responseRefs: [],
      citationIds: [],
      createdAt: now,
      updatedAt: now,
    },
  },
});
// A report turn's start, which the wake reads before the attempt runs.
const chatReportCreated = {
  eventName: "chat.turn-created@1",
  payload: {
    kind: "turn-created",
    turn: {
      id: turn,
      delivery: { kind: "side-task-report" },
      attempts: [{ id: "00000000-0000-4000-8000-0000000000ee" }],
    },
  },
};
const codeReportStarted = () =>
  code({ kind: "conversation-turn-started", delivery: { kind: "side-task-report" } });
const work = (status: string, extra: object = {}) => ({
  eventName: "work.turn-updated@1",
  payload: {
    kind: "turn-updated",
    requestId: turn,
    threadId: thread,
    turnId: turn,
    status,
    updatedAt: now,
    ...(status === "failed"
      ? { failure: { category: "failed", message: "The provider stopped." } }
      : {}),
    ...extra,
  },
});
const code = (event: object) => ({
  eventName: "code.operation-event-recorded@1",
  payload: { threadId: thread, operationId: turn, cursor: 9, occurredAt: now, event },
});
const failedResult = {
  kind: "operation-result",
  result: {
    kind: "operation-failed",
    operationId: turn,
    failure: { category: "unavailable", message: "The provider could not start." },
  },
};

function started(event: object): object {
  const { eventName } = event as { readonly eventName: string };
  if (eventName === "chat.attempt-updated@1") return chatReportCreated;
  if (eventName === "code.operation-event-recorded@1") return codeReportStarted();
  return work("running");
}

async function woken(event: object, mark: ThreadDeliveryMark | undefined) {
  const wakes: string[] = [];
  const onError = vi.fn();
  const service = new SideTaskReportFailureWake({
    chatTurnMark: () => mark,
    workTurnMark: () => mark,
    codeTurnMark: () => mark,
    wakeChat: () => wakes.push("chat"),
    wakeWork: () => wakes.push("work"),
    wakeCode: () => wakes.push("code"),
    onError,
  });
  // The turn started in this host before it ended.
  service.onCommittedEvents([started(event) as EventEnvelope, event as EventEnvelope]);
  // Never inside the append that reported the failure.
  expect(wakes).toEqual([]);
  await Promise.resolve();
  expect(onError.mock.calls).toEqual([]);
  return wakes;
}

describe("a report's turn that fails", () => {
  it.each([
    ["chat", chat("failed")],
    ["chat", chat("interrupted")],
    ["work", work("failed")],
    ["code", code({ kind: "operation-state", state: "failed" })],
    ["code", code(failedResult)],
    ["code", code({ kind: "operation-state", state: "interrupted" })],
  ])("ends the %s parent's snooze", async (mode, event) => {
    await expect(woken(event, report)).resolves.toEqual([mode]);
  });

  it.each([
    ["a completed Chat turn", chat("completed")],
    ["a Chat turn the person stopped", chat("cancelled")],
    [
      "a Chat Stop the provider never confirmed",
      {
        ...chat("interrupted"),
        payload: {
          ...chat("interrupted").payload,
          attempt: {
            ...chat("interrupted").payload.attempt,
            failure: { code: "stop-unconfirmed" },
          },
        },
      },
    ],
    ["a completed Work turn", work("completed")],
    ["a Work turn the person stopped", work("cancelled")],
    ["a failed Work turn a fork carried", work("failed", { carried: true })],
    ["a completed Code turn", code({ kind: "operation-state", state: "completed" })],
  ])("leaves the snooze alone after %s", async (_name, event) => {
    await expect(woken(event, report)).resolves.toEqual([]);
  });

  it("ends the snooze when a Chat report turn parked on a question is interrupted", async () => {
    const wakes: string[] = [];
    const service = new SideTaskReportFailureWake({
      chatTurnMark: () => report,
      workTurnMark: () => report,
      codeTurnMark: () => report,
      wakeChat: () => wakes.push("chat"),
      wakeWork: () => wakes.push("work"),
      wakeCode: () => wakes.push("code"),
    });
    service.onCommittedEvents([
      chatReportCreated,
      chat("streaming"),
      chat("waiting"),
      chat("interrupted"),
    ] as EventEnvelope[]);
    await Promise.resolve();
    expect(wakes).toEqual(["chat"]);
  });

  it("counts a Chat report's retry as started here, and forgets the turn once it completes", async () => {
    const wakes: string[] = [];
    const service = new SideTaskReportFailureWake({
      chatTurnMark: () => report,
      workTurnMark: () => report,
      codeTurnMark: () => report,
      wakeChat: () => wakes.push("chat"),
      wakeWork: () => wakes.push("work"),
      wakeCode: () => wakes.push("code"),
    });
    const retry = (outcome: string) => {
      const event = chat(outcome);
      return {
        ...event,
        payload: {
          ...event.payload,
          attempt: { ...event.payload.attempt, id: "00000000-0000-4000-8000-0000000000f9" },
        },
      };
    };
    service.onCommittedEvents([
      chatReportCreated,
      chat("failed"),
      retry("queued"),
      retry("interrupted"),
    ] as EventEnvelope[]);
    await Promise.resolve();
    expect(wakes).toEqual(["chat", "chat"]);

    // A completed turn starts no retry, so a later attempt is not one of its own.
    service.onCommittedEvents([
      chatReportCreated,
      chat("completed"),
      retry("queued"),
      retry("interrupted"),
    ] as EventEnvelope[]);
    await Promise.resolve();
    expect(wakes).toEqual(["chat", "chat"]);
  });

  it("leaves a turn a restart cut off to restart recovery, in Chat and Code", async () => {
    const wakes: string[] = [];
    const service = new SideTaskReportFailureWake({
      chatTurnMark: () => report,
      workTurnMark: () => report,
      codeTurnMark: () => report,
      wakeChat: () => wakes.push("chat"),
      wakeWork: () => wakes.push("work"),
      wakeCode: () => wakes.push("code"),
    });
    // Recovery settles a turn the previous host started, after this listens.
    // A person's turn that started here is no report either.
    service.onCommittedEvents([
      chat("streaming") as EventEnvelope,
      code({ kind: "conversation-turn-started" }) as EventEnvelope,
    ]);
    service.onCommittedEvents([
      chat("interrupted") as EventEnvelope,
      code({ kind: "operation-state", state: "interrupted" }) as EventEnvelope,
    ]);
    await Promise.resolve();
    expect(wakes).toEqual([]);
  });

  it("leaves the snooze alone after a Code turn the person stopped", async () => {
    const wakes: string[] = [];
    const service = new SideTaskReportFailureWake({
      chatTurnMark: () => report,
      workTurnMark: () => report,
      codeTurnMark: () => report,
      wakeChat: () => wakes.push("chat"),
      wakeWork: () => wakes.push("work"),
      wakeCode: () => wakes.push("code"),
    });
    const start = codeReportStarted() as EventEnvelope;
    service.onCommittedEvents([
      start,
      code({ kind: "conversation-turn-stop-requested" }) as EventEnvelope,
      code({ kind: "operation-state", state: "interrupted" }) as EventEnvelope,
    ]);
    await Promise.resolve();
    expect(wakes).toEqual([]);
    // The Stop belonged to that turn alone; a later provider exit still wakes it.
    service.onCommittedEvents([
      start,
      code({ kind: "operation-state", state: "interrupted" }) as EventEnvelope,
    ]);
    await Promise.resolve();
    expect(wakes).toEqual(["code"]);
  });

  it.each([
    ["a person's", undefined],
    ["a subagent result's", managed],
  ])("leaves the snooze alone when %s turn fails", async (_name, mark) => {
    for (const event of [chat("failed"), work("failed"), code(failedResult)]) {
      await expect(woken(event, mark)).resolves.toEqual([]);
    }
  });
});
