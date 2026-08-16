import { describe, expect, it } from "vitest";
import {
  decodeLinkedThreadAggregate,
  decodeLinkedThreadTargetResult,
  LINKED_THREAD_AGGREGATE_EVENT_NAMES,
} from "./linkedThreadAggregation";

const ids = {
  aggregate: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  request: "33333333-3333-4333-8333-333333333333",
  receipt: "55555555-5555-4555-8555-555555555555",
  preview: "66666666-6666-4666-8666-666666666666",
  sourceThread: "11111111-1111-4111-8111-111111111111",
  threadA: "22222222-2222-4222-8222-222222222222",
  threadB: "33333333-3333-4333-8333-333333333334",
};

const aggregate = {
  aggregateId: ids.aggregate,
  requestId: ids.request,
  receiptId: ids.receipt,
  previewId: ids.preview,
  sourceThreadId: ids.sourceThread,
  skillName: "review-in-parallel",
  requestedCount: 2,
  status: "partial",
  results: [
    {
      targetIndex: 1,
      label: "Reviewer 1",
      status: "created",
      threadId: ids.threadA,
      resultRefId: "result:1",
    },
    {
      targetIndex: 2,
      label: "Reviewer 2",
      status: "rejected",
      reason: "Provider capacity unavailable.",
    },
  ],
  createdAt: "2026-08-02T12:00:00.000Z",
  updatedAt: "2026-08-02T12:00:05.000Z",
};

describe("linked-thread aggregation contracts", () => {
  it("decodes a partial aggregate with per-thread result refs", () => {
    const decoded = decodeLinkedThreadAggregate(aggregate);
    expect(decoded.status).toBe("partial");
    expect(decoded.results).toHaveLength(2);
    expect(decoded.skillName).toBe("review-in-parallel");
  });

  it("rejects aggregates whose result count exceeds the requested count", () => {
    expect(() =>
      decodeLinkedThreadAggregate({
        ...aggregate,
        results: [
          ...aggregate.results,
          { targetIndex: 3, label: "Reviewer 3", status: "failed", reason: "overflow" },
        ],
        requestedCount: 2,
      }),
    ).toThrow();
  });

  it("rejects duplicate target indices", () => {
    expect(() =>
      decodeLinkedThreadAggregate({
        ...aggregate,
        results: [
          { targetIndex: 1, label: "Reviewer 1", status: "created", threadId: ids.threadA },
          { targetIndex: 1, label: "Reviewer 1 duplicate", status: "failed", reason: "dup" },
        ],
      }),
    ).toThrow();
  });

  it("requires a reason for rejected and failed per-thread results", () => {
    expect(() =>
      decodeLinkedThreadTargetResult({ targetIndex: 1, label: "Reviewer 1", status: "rejected" }),
    ).toThrow();
  });

  it("requires a thread id for created per-thread results", () => {
    expect(() =>
      decodeLinkedThreadTargetResult({ targetIndex: 1, label: "Reviewer 1", status: "created" }),
    ).toThrow();
  });

  it("exports versioned linked-thread aggregate event names", () => {
    expect(LINKED_THREAD_AGGREGATE_EVENT_NAMES).toEqual(["linked.thread-aggregate-recorded@1"]);
  });
});
