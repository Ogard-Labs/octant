import { describe, expect, it } from "vitest";
import {
  EMPTY_CODE_TURN_QUEUES,
  clearQueuedCodeTurns,
  enqueueCodeTurn,
  queuedTurnsFor,
  removeQueuedCodeTurn,
} from "./turnQueue";

const first = {
  id: "turn-1",
  prompt: "Run the tests",
  threadMentionIds: [],
  attachments: [],
  fileMentionPaths: [],
};
const second = {
  id: "turn-2",
  prompt: "Then open a PR",
  threadMentionIds: [],
  attachments: [],
  fileMentionPaths: [],
};

describe("code turn queue", () => {
  it("keeps each thread's queued follow-ups in the order they were written", () => {
    const queues = enqueueCodeTurn(
      enqueueCodeTurn(EMPTY_CODE_TURN_QUEUES, "thread-a", first),
      "thread-a",
      second,
    );
    expect(queuedTurnsFor(queues, "thread-a")).toEqual([first, second]);
    expect(queuedTurnsFor(queues, "thread-b")).toEqual([]);
  });

  it("does not let one thread's queue reach another", () => {
    const queues = enqueueCodeTurn(
      enqueueCodeTurn(EMPTY_CODE_TURN_QUEUES, "thread-a", first),
      "thread-b",
      second,
    );
    expect(queuedTurnsFor(queues, "thread-a")).toEqual([first]);
    expect(queuedTurnsFor(queues, "thread-b")).toEqual([second]);
  });

  it("removes a single cancelled follow-up and forgets an emptied thread", () => {
    const queues = enqueueCodeTurn(
      enqueueCodeTurn(EMPTY_CODE_TURN_QUEUES, "thread-a", first),
      "thread-a",
      second,
    );
    const afterFirst = removeQueuedCodeTurn(queues, "thread-a", "turn-1");
    expect(queuedTurnsFor(afterFirst, "thread-a")).toEqual([second]);
    const emptied = removeQueuedCodeTurn(afterFirst, "thread-a", "turn-2");
    expect(emptied.has("thread-a")).toBe(false);
  });

  it("clears a thread's queue and leaves an unqueued thread untouched", () => {
    const queues = enqueueCodeTurn(EMPTY_CODE_TURN_QUEUES, "thread-a", first);
    expect(queuedTurnsFor(clearQueuedCodeTurns(queues, "thread-a"), "thread-a")).toEqual([]);
    expect(clearQueuedCodeTurns(queues, "thread-b")).toBe(queues);
  });
});
