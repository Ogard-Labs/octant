import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import { describe, expect, it, vi } from "vitest";
import { stopRunningRow, type StopRowClients } from "./stopRunningRow";
import type { WorkingNowRow } from "./workingNow";

const UUID_A = "00000000-0000-4000-8000-0000000000a1";
const UUID_B = "00000000-0000-4000-8000-0000000000b2";
const UUID_C = "00000000-0000-4000-8000-0000000000c3";
const UUID_D = "00000000-0000-4000-8000-0000000000d4";

function row(overrides: Partial<WorkingNowRow>): WorkingNowRow {
  return { key: "row", mode: "chat", threadId: UUID_A, title: "Task", ...overrides };
}

const none: StopRowClients = {
  chatClient: undefined,
  codeClient: undefined,
  workTurnClient: undefined,
  agentRunClient: undefined,
};

describe("stopping a running row from the start screen", () => {
  it("interrupts the Chat attempt that is streaming, with the thread's current version", async () => {
    const execute = vi.fn(async () => ({}));
    const chatClient = {
      thread: vi.fn(async () => ({
        thread: { id: UUID_A, version: 7 },
        turns: [
          { id: UUID_B, attempts: [{ id: UUID_C, turnId: UUID_B, outcome: "completed" }] },
          { id: UUID_D, attempts: [{ id: UUID_C, turnId: UUID_D, outcome: "streaming" }] },
        ],
      })),
      execute,
    } as unknown as ChatClient;

    const outcome = await stopRunningRow({ ...none, chatClient }, row({ mode: "chat" }));

    expect(outcome).toEqual({ kind: "stopped" });
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      kind: "interrupt-chat-turn",
      threadId: UUID_A,
      expectedVersion: 7,
      turnId: UUID_D,
      attemptId: UUID_C,
    });
  });

  it("cancels nothing when the Chat turn finished before the person confirmed", async () => {
    const execute = vi.fn();
    const chatClient = {
      thread: vi.fn(async () => ({
        thread: { id: UUID_A, version: 7 },
        turns: [{ id: UUID_B, attempts: [{ id: UUID_C, turnId: UUID_B, outcome: "completed" }] }],
      })),
      execute,
    } as unknown as ChatClient;

    expect(await stopRunningRow({ ...none, chatClient }, row({ mode: "chat" }))).toEqual({
      kind: "nothing-running",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels the Work turn that is running on the thread", async () => {
    const cancelFirstTurn = vi.fn(async () => ({}));
    const workTurnClient = {
      transcript: vi.fn(async () => ({
        turns: [
          { requestId: UUID_B, threadId: UUID_A, turnId: UUID_B, status: "completed" },
          { requestId: UUID_C, threadId: UUID_A, turnId: UUID_D, status: "running" },
        ],
      })),
      cancelFirstTurn,
    } as unknown as WorkTurnClient;

    const outcome = await stopRunningRow({ ...none, workTurnClient }, row({ mode: "work" }));

    expect(outcome).toEqual({ kind: "stopped" });
    expect(cancelFirstTurn).toHaveBeenCalledExactlyOnceWith({
      kind: "cancel-work-turn",
      requestId: UUID_C,
      threadId: UUID_A,
      turnId: UUID_D,
    });
  });

  it("cancels the Code thread's provider turn in its checkout", async () => {
    const executeOperation = vi.fn(async () => ({
      kind: "provider-turn-state",
      operationId: UUID_C,
      state: "interrupted",
    }));
    const codeClient = {
      thread: vi.fn(async () => ({ thread: { id: UUID_A }, checkout: { id: UUID_B } })),
      executeOperation,
    } as unknown as CodeClient;

    expect(await stopRunningRow({ ...none, codeClient }, row({ mode: "code" }))).toEqual({
      kind: "stopped",
    });
    expect(executeOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "cancel-provider-turn",
        threadId: UUID_A,
        checkoutId: UUID_B,
      }),
    );
  });

  it("reports a Code turn that finished before the person confirmed as already finished", async () => {
    // The host answers a cancel with no turn of its own to stop as a failed
    // turn state with no reason, and stops nothing.
    const codeClient = {
      thread: vi.fn(async () => ({ thread: { id: UUID_A }, checkout: { id: UUID_B } })),
      executeOperation: vi.fn(async () => ({
        kind: "provider-turn-state",
        operationId: UUID_C,
        state: "failed",
      })),
    } as unknown as CodeClient;

    expect(await stopRunningRow({ ...none, codeClient }, row({ mode: "code" }))).toEqual({
      kind: "nothing-running",
    });
  });

  it("shows a host refusal of a Code stop in the host's words", async () => {
    const codeClient = {
      thread: vi.fn(async () => ({ thread: { id: UUID_A }, checkout: { id: UUID_B } })),
      executeOperation: vi.fn(async () => ({
        kind: "operation-failed",
        operationId: UUID_C,
        failure: { category: "unauthorized", message: "This window cannot use that checkout." },
      })),
    } as unknown as CodeClient;

    expect(await stopRunningRow({ ...none, codeClient }, row({ mode: "code" }))).toEqual({
      kind: "refused",
      message: "This window cannot use that checkout.",
    });
  });

  it("cancels an agent run row by its run, not by its resting thread", async () => {
    const cancel = vi.fn(async () => ({ results: [{ kind: "run-updated" }] }));
    const agentRunClient = { cancel } as unknown as AgentRunClient;

    const outcome = await stopRunningRow(
      { ...none, agentRunClient },
      row({ mode: "code", runId: UUID_B }),
    );

    expect(outcome).toEqual({ kind: "stopped" });
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ runId: UUID_B, scope: "self" });
  });

  it("refuses in words, never silently, when the window has no way to stop that mode", async () => {
    const outcome = await stopRunningRow(none, row({ mode: "work" }));
    expect(outcome).toEqual({ kind: "refused", message: "This window cannot stop that work." });
  });

  it("turns a failed read into a refusal the row can show", async () => {
    const chatClient = {
      thread: vi.fn(async () => {
        throw new Error("offline");
      }),
    } as unknown as ChatClient;
    const outcome = await stopRunningRow({ ...none, chatClient }, row({ mode: "chat" }));
    expect(outcome).toEqual({
      kind: "refused",
      message: "The turn could not be stopped. Try again.",
    });
  });
});
