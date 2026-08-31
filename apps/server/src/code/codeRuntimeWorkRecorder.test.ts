import {
  CodeGitOperationId,
  CodeTerminalId,
  EventActor,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeCodeTerminalId,
  decodeCodeCheckoutId,
} from "@octant/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  CodeRuntimeWorkRecorder,
  codeRuntimeWorkPlan,
  codeRuntimeWorkStarted,
} from "./codeRuntimeWorkRecorder";

const threadId = decodeCodeThreadId("90000000-0000-4000-8000-000000000001");
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "system",
  actorId: "90000000-0000-4000-8000-000000000002",
});
const clock = () => "2026-08-31T10:00:00.000Z";
const decodeGitOperationId = Schema.decodeUnknownSync(CodeGitOperationId);
const uuid = (() => {
  let next = 10;
  return () => `90000000-0000-4000-8000-${(++next).toString().padStart(12, "0")}`;
})();

function recorder(append: () => void = () => undefined) {
  return new CodeRuntimeWorkRecorder({
    journal: { append },
    uuid,
    clock,
    actor,
  });
}

function eventInput(id: CodeTerminalId) {
  return { id, threadId, kind: "terminal" as const };
}

describe("CodeRuntimeWorkRecorder", () => {
  it("returns a typed failure when a runtime work id cannot be decoded", () => {
    const append = vi.fn();
    const runtime = recorder(append);

    // @ts-expect-error The runtime boundary must still refuse malformed ids.
    const outcome = runtime.open(eventInput("not-a-uuid"));

    expect(outcome).toEqual({ status: "failed", kind: "invalid-runtime-work" });
    expect(append).not.toHaveBeenCalled();
  });

  it("reports journal failures without claiming ownership of the work", () => {
    const append = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const runtime = recorder(append);
    const id = decodeCodeTerminalId("90000000-0000-4000-8000-000000000003");

    const outcome = runtime.open(eventInput(id));

    expect(outcome).toEqual({ status: "failed", kind: "journal-unavailable" });
    expect(runtime.owns(id)).toBe(false);
  });

  it("distinguishes unchanged records from work owned by another recorder", () => {
    const runtime = recorder();
    const id = decodeCodeTerminalId("90000000-0000-4000-8000-000000000004");

    expect(runtime.open(eventInput(id))).toEqual({ status: "recorded" });
    expect(runtime.open(eventInput(id))).toEqual({ status: "unchanged" });
    expect(runtime.settle({ ...eventInput(id), state: "completed" })).toEqual({
      status: "recorded",
    });
    expect(runtime.settle({ ...eventInput(id), state: "completed" })).toEqual({
      status: "not-owned",
    });
  });
});

describe("codeRuntimeWorkPlan", () => {
  it("classifies starts, observations, and network reach from one command seam", () => {
    const terminal = decodeCodeTerminalId("90000000-0000-4000-8000-000000000005");
    const scope = {
      threadId,
      checkoutId: decodeCodeCheckoutId("90000000-0000-4000-8000-000000000006"),
    };

    expect(
      codeRuntimeWorkPlan({
        kind: "start-terminal",
        ...scope,
        operationId: decodeCodeOperationId("90000000-0000-4000-8000-000000000008"),
        terminalId: terminal,
        columns: 80,
        rows: 24,
        credentialRefs: [],
      }),
    ).toMatchObject({ id: terminal, kind: "terminal", starts: true, reachesNetwork: false });
    expect(
      codeRuntimeWorkPlan({
        kind: "attach-terminal",
        ...scope,
        operationId: decodeCodeOperationId("90000000-0000-4000-8000-000000000009"),
        terminalId: terminal,
      }),
    ).toMatchObject({ id: terminal, kind: "terminal", starts: false, reachesNetwork: false });
    expect(
      codeRuntimeWorkStarted({
        kind: "observe-git",
        ...scope,
        operationId: decodeCodeOperationId("90000000-0000-4000-8000-000000000010"),
        gitOperationId: decodeGitOperationId("90000000-0000-4000-8000-000000000011"),
        maxDiffBytes: 1_024,
      }),
    ).toBeUndefined();
  });
});
