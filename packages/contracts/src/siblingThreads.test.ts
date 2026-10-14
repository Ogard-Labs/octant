import { describe, expect, it } from "vitest";
import { decodeProviderToolDefinition } from "./providers";
import {
  MAX_SIBLING_THREAD_LIST_ROWS,
  MAX_SIBLING_THREAD_WAIT_MS,
  SIBLING_THREADS_TOOL_DEFINITION,
  SIBLING_THREADS_TOOL_NAME,
  decodeSiblingThreadObserved,
  decodeSiblingThreadReference,
  decodeSiblingThreadsToolInput,
  decodeSiblingThreadsToolResult,
} from "./siblingThreads";

const reference = "c0000000-0000-4000-8000-000000000002@a0000000-0000-4000-8000-000000000001";
const row = {
  reference,
  title: "Fix the flaky upload test",
  state: "working",
  stateChangedAt: "2026-10-13T07:00:00.000Z",
};

describe("the sibling threads contract", () => {
  it("offers a provider tool definition the provider contract accepts", () => {
    expect(SIBLING_THREADS_TOOL_NAME).toBe("octant_threads");
    expect(decodeProviderToolDefinition(SIBLING_THREADS_TOOL_DEFINITION)).toEqual(
      SIBLING_THREADS_TOOL_DEFINITION,
    );
  });

  it("decodes the three actions and refuses anything else", () => {
    expect(decodeSiblingThreadsToolInput({ action: "list" })).toEqual({ action: "list" });
    expect(decodeSiblingThreadsToolInput({ action: "read", reference })).toEqual({
      action: "read",
      reference,
    });
    expect(decodeSiblingThreadsToolInput({ action: "wait", reference, timeoutMs: 1_000 })).toEqual({
      action: "wait",
      reference,
      timeoutMs: 1_000,
    });
    expect(() => decodeSiblingThreadsToolInput({ action: "message", reference })).toThrow();
    expect(() => decodeSiblingThreadsToolInput({ action: "list", projectId: "x" })).toThrow();
    expect(() => decodeSiblingThreadsToolInput({ action: "read" })).toThrow();
    expect(() =>
      decodeSiblingThreadsToolInput({
        action: "wait",
        reference,
        timeoutMs: MAX_SIBLING_THREAD_WAIT_MS + 1,
      }),
    ).toThrow();
  });

  it("accepts only a thread id and a Project id as a reference", () => {
    expect(decodeSiblingThreadReference(reference)).toBe(reference);
    for (const candidate of [
      "c0000000-0000-4000-8000-000000000002",
      `${reference}@a0000000-0000-4000-8000-000000000001`,
      "../etc/passwd@a0000000-0000-4000-8000-000000000001",
      `file:${reference}`,
    ]) {
      expect(() => decodeSiblingThreadReference(candidate)).toThrow();
    }
  });

  it("bounds a list to its row cap and a wait to a state without content", () => {
    expect(
      decodeSiblingThreadsToolResult({ status: "listed", threads: [row], truncated: false }),
    ).toMatchObject({ status: "listed" });
    expect(() =>
      decodeSiblingThreadsToolResult({
        status: "listed",
        threads: Array.from({ length: MAX_SIBLING_THREAD_LIST_ROWS + 1 }, () => row),
        truncated: true,
      }),
    ).toThrow();
    expect(
      decodeSiblingThreadsToolResult({ status: "waited", reference, state: "waiting-for-person" }),
    ).toMatchObject({ state: "waiting-for-person" });
    expect(() =>
      decodeSiblingThreadsToolResult({
        status: "waited",
        reference,
        state: "idle",
        transcript: [],
      }),
    ).toThrow();
    expect(
      decodeSiblingThreadsToolResult({
        status: "refused",
        reason: "rate-limited",
        message: "This turn has already read 8 threads.",
      }),
    ).toMatchObject({ reason: "rate-limited" });
  });

  it("journals an answered read with its size and never its text", () => {
    const observed = {
      kind: "sibling-observed",
      threadId: "c0000000-0000-4000-8000-000000000001",
      targetThreadId: "c0000000-0000-4000-8000-000000000002",
      action: "read",
      correlationId: "d0000000-0000-4000-8000-000000000001",
      returnedBytes: 1_024,
      occurredAt: "2026-10-14T07:00:00.000Z",
    };
    expect(decodeSiblingThreadObserved(observed)).toEqual(observed);
    expect(() =>
      decodeSiblingThreadObserved({ ...observed, transcript: [{ role: "user", text: "x" }] }),
    ).toThrow();
    expect(() => decodeSiblingThreadObserved({ ...observed, action: "list" })).toThrow();
  });
});
