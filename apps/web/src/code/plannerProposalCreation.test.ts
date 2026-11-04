import {
  decodeCodeThread,
  type CodePlannerThreadCreation,
  type CodePlannerView,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPlannerProposalTask } from "./plannerProposalCreation";

const now = "2026-11-02T00:00:00.000Z";
const thread = decodeCodeThread({
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "10000000-0000-4000-8000-000000000002",
  bindingRevisionId: "10000000-0000-4000-8000-000000000003",
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: "10000000-0000-4000-8000-000000000004",
  title: "Fix the parser",
  lifecycle: "active",
  providerInstanceId: "10000000-0000-4000-8000-000000000005",
  modelId: "model",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "fix/parser",
    remoteName: "origin",
    proposedBaseRepository: "example/project",
    proposedBaseBranch: "main",
    outcomeKind: "local-implementation",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const review = {
  proposal: {
    id: "10000000-0000-4000-8000-000000000006",
    projectId: thread.projectId,
    plannerThreadId: "10000000-0000-4000-8000-000000000007",
    title: thread.title,
    intent: "Fix exactly the described parser issue.",
    proposedAt: now,
    status: "pending",
  },
  proposalVersion: 3,
} as CodePlannerView["proposals"][number];
const creation: CodePlannerThreadCreation = { kind: "create-code-thread", thread };
function attemptStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("creating the task a person approved from a planner proposal", () => {
  it("releases a retained identity only after a newer authoritative noncreation result for explicit retry", async () => {
    const storage = attemptStorage();
    const executePlannerProposal = vi.fn(async () => {
      throw new Error("Lost reply");
    });
    const read = vi.fn(async () => {
      throw new Error("HTTP404");
    });
    await createPlannerProposalTask(
      { executePlannerProposal, thread: read },
      review,
      creation,
      storage,
    );
    const replacement = {
      kind: "create-code-thread" as const,
      thread: decodeCodeThread({ ...thread, id: "10000000-0000-4000-8000-000000000011" }),
    };
    const newerPending = { ...review, proposalVersion: 4 as never };
    await createPlannerProposalTask(
      { executePlannerProposal, thread: read },
      newerPending,
      replacement,
      { ...storage },
    );
    expect(executePlannerProposal).toHaveBeenCalledTimes(1);
    const failed = {
      ...review,
      proposal: {
        ...review.proposal,
        creationAttempt: {
          threadId: thread.id,
          status: "failed" as const,
          admittedAt: thread.createdAt,
          message: "Provider unavailable before creation.",
        },
      },
    };
    await createPlannerProposalTask(
      { executePlannerProposal, thread: read },
      failed,
      replacement,
      storage,
    );
    expect(executePlannerProposal).toHaveBeenCalledTimes(1);
    const retry = vi.fn(async () => ({
      status: "confirmed" as const,
      proposal: {
        ...review.proposal,
        status: "confirmed" as const,
        resolvedAt: thread.createdAt,
        createdThreadId: replacement.thread.id,
      },
      creation: { kind: "thread-created" as const, thread: replacement.thread },
    }));
    expect(
      await createPlannerProposalTask(
        { executePlannerProposal: retry, thread: read },
        { ...failed, proposalVersion: 5 as never },
        replacement,
        storage,
      ),
    ).toMatchObject({ status: "confirmed" });
    expect(retry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedVersion: 5, creation: replacement }),
    );
  });

  it("dispatches no approval when its identity cannot be retained and read back", async () => {
    const executePlannerProposal = vi.fn();
    const read = vi.fn();
    expect(
      await createPlannerProposalTask({ executePlannerProposal, thread: read }, review, creation, {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      }),
    ).toMatchObject({
      status: "unconfirmed",
      message: expect.stringContaining("no request was sent"),
    });
    expect(executePlannerProposal).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("returns only a confirmed ordinary creation for the first-message path", async () => {
    const executePlannerProposal = vi.fn(async () => ({
      status: "confirmed" as const,
      proposal: {
        ...review.proposal,
        status: "confirmed" as const,
        resolvedAt: thread.createdAt,
        createdThreadId: thread.id,
      },
      creation: { kind: "thread-created" as const, thread },
    }));
    const read = vi.fn();
    expect(
      await createPlannerProposalTask(
        { executePlannerProposal, thread: read },
        review,
        creation,
        attemptStorage(),
      ),
    ).toMatchObject({ status: "confirmed", creation: { kind: "thread-created", thread } });
    expect(executePlannerProposal).toHaveBeenCalledExactlyOnceWith({
      kind: "confirm-planner-work-proposal",
      proposalId: review.proposal.id,
      expectedVersion: 3,
      creation,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["lost reply", "concurrent decline"])(
    "inspects the submitted task without retrying after %s",
    async (reason) => {
      const executePlannerProposal = vi.fn(async () => {
        if (reason === "lost reply") throw new Error("Connection lost");
        return {
          status: "refused" as const,
          reason: "proposal-changed" as const,
          message: "The proposal changed while the thread was being created.",
        };
      });
      const read = vi.fn(async () => ({ thread }) as never);
      expect(
        await createPlannerProposalTask(
          { executePlannerProposal, thread: read },
          review,
          creation,
          attemptStorage(),
        ),
      ).toMatchObject({
        status: "unconfirmed",
        existingThread: thread,
        message: expect.stringContaining("No first message was sent"),
      });
      expect(executePlannerProposal).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledExactlyOnceWith(thread.id);
    },
  );

  it("bounds a missing approval reply and preserves the submitted ID for inspection", async () => {
    vi.useFakeTimers();
    const executePlannerProposal = vi.fn(() => new Promise<never>(() => {}));
    const read = vi.fn(async () => {
      throw new Error("Unavailable");
    });
    try {
      const result = createPlannerProposalTask(
        { executePlannerProposal, thread: read },
        review,
        creation,
        attemptStorage(),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({
        status: "unconfirmed",
        message: expect.stringContaining(String(thread.id)),
      });
      expect(executePlannerProposal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a proposal from another Project before any creation request", async () => {
    const executePlannerProposal = vi.fn();
    const read = vi.fn();
    expect(
      await createPlannerProposalTask(
        { executePlannerProposal, thread: read },
        {
          ...review,
          proposal: {
            ...review.proposal,
            projectId: "10000000-0000-4000-8000-000000000008" as never,
          },
        },
        creation,
        attemptStorage(),
      ),
    ).toMatchObject({ status: "unconfirmed" });
    expect(executePlannerProposal).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
