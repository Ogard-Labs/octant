import type { CodeClient } from "@octant/client-runtime/code-client";
import {
  WorkRequestClientFailure,
  type WorkRequestClient,
} from "@octant/client-runtime/work-request-client";
import { describe, expect, it, vi } from "vitest";
import { answerPendingApproval } from "./answerPendingApproval";
import { codeApproval, pendingIds, workApproval } from "./pendingRequests.test-fixtures";

function clients() {
  const execute = vi.fn();
  const executeOperation = vi.fn();
  return {
    execute,
    executeOperation,
    workRequestClient: { execute } as unknown as WorkRequestClient,
    codeClient: { executeOperation } as unknown as CodeClient,
  };
}

describe("answering a listed approval", () => {
  it("resolves a Work approval with the request id and version the host listed", async () => {
    const fake = clients();
    fake.execute.mockResolvedValue({ kind: "work-request-resolved" });

    const outcome = await answerPendingApproval({
      request: workApproval(),
      decision: "denied",
      workRequestClient: fake.workRequestClient,
      codeClient: fake.codeClient,
    });

    expect(outcome).toEqual({ status: "answered" });
    expect(fake.execute).toHaveBeenCalledWith({
      kind: "resolve-work-request",
      requestId: pendingIds.workRequest,
      expectedVersion: 3,
      resolution: { kind: "approval", approved: false },
    });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it("answers a Code approval under a fresh operation id on the listed thread and checkout", async () => {
    const fake = clients();
    fake.executeOperation.mockResolvedValue({ kind: "operation-accepted" });

    const first = await answerPendingApproval({
      request: codeApproval(),
      decision: "approved",
      workRequestClient: fake.workRequestClient,
      codeClient: fake.codeClient,
    });
    await answerPendingApproval({
      request: codeApproval(),
      decision: "approved",
      workRequestClient: fake.workRequestClient,
      codeClient: fake.codeClient,
    });

    expect(first).toEqual({ status: "answered" });
    expect(fake.executeOperation).toHaveBeenCalledWith({
      kind: "answer-provider-approval",
      operationId: expect.any(String),
      threadId: pendingIds.codeThread,
      checkoutId: pendingIds.checkout,
      approvalId: pendingIds.approval,
      decision: "approved",
    });
    const [one, two] = fake.executeOperation.mock.calls.map((call) => call[0].operationId);
    expect(one).not.toBe(two);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("reports the host's refusal of a Work answer instead of dropping it", async () => {
    const fake = clients();
    fake.execute.mockRejectedValue(
      new WorkRequestClientFailure({ code: "stale", message: "That request already changed." }),
    );

    const outcome = await answerPendingApproval({
      request: workApproval(),
      decision: "approved",
      workRequestClient: fake.workRequestClient,
      codeClient: fake.codeClient,
    });

    expect(outcome).toEqual({ status: "refused", message: "That request already changed." });
  });

  it("reports a Code approval the host refuses", async () => {
    const fake = clients();
    fake.executeOperation.mockResolvedValue({
      kind: "operation-failed",
      operationId: "x",
      failure: { message: "The approval is no longer pending." },
    });

    const outcome = await answerPendingApproval({
      request: codeApproval(),
      decision: "denied",
      workRequestClient: fake.workRequestClient,
      codeClient: fake.codeClient,
    });

    expect(outcome).toEqual({ status: "refused", message: "The approval is no longer pending." });
  });

  it("reports a Code approval the turn refuses as a failed turn state, with the host's reason", async () => {
    const fake = clients();
    fake.executeOperation.mockResolvedValue({
      kind: "provider-turn-state",
      operationId: "x",
      state: "failed",
      failure: { category: "failed", message: "Plan mode cannot approve tools." },
    });

    const outcome = await answerPendingApproval({
      request: codeApproval(),
      decision: "approved",
      workRequestClient: fake.workRequestClient,
      codeClient: fake.codeClient,
    });

    expect(outcome).toEqual({ status: "refused", message: "Plan mode cannot approve tools." });
  });

  it("reports a Code approval whose turn had already ended instead of calling it approved", async () => {
    const fake = clients();
    fake.executeOperation.mockResolvedValue({
      kind: "provider-turn-state",
      operationId: "x",
      state: "interrupted",
    });

    const outcome = await answerPendingApproval({
      request: codeApproval(),
      decision: "approved",
      workRequestClient: fake.workRequestClient,
      codeClient: fake.codeClient,
    });

    expect(outcome).toEqual({
      status: "refused",
      message: "The turn that asked has ended. Send a new message to continue.",
    });
  });
});
