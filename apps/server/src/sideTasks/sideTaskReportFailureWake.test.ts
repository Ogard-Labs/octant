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
  service.onCommittedEvents([event as EventEnvelope]);
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
    ["a Code turn the person stopped", code({ kind: "operation-state", state: "interrupted" })],
  ])("leaves the snooze alone after %s", async (_name, event) => {
    await expect(woken(event, report)).resolves.toEqual([]);
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
