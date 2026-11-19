import { describe, expect, it, vi } from "vitest";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts";
import { observeCodeBranchState, switchCodeBranch } from "./switchCodeBranch";

const scope = {
  checkoutId: "checkout-1" as CodeCheckoutId,
  threadId: "thread-1" as CodeThreadId,
};

const request = {
  branch: "feature/target",
  dirty: "refuse" as const,
  expectedStateToken: "a".repeat(64),
};

const completed = {
  kind: "git-mutation-state",
  mutation: "switch-branch",
  state: "completed",
  headBranch: "feature/target",
};

function host(result: unknown = completed) {
  const executeOperation = vi.fn(async (_command: unknown) => result);
  return { client: { executeOperation } as unknown as CodeClient, executeOperation };
}

const uuids = () => () => "00000000-0000-4000-8000-000000000001";

describe("switchCodeBranch approval routing", () => {
  it("asks approval for the exact command it then executes under a gated posture", async () => {
    const { client, executeOperation } = host();
    const approved: unknown[] = [];
    const outcome = await switchCodeBranch(client, uuids(), scope, request, {
      executionPolicy: "approval-gated",
      requestApproval: async (command) => {
        approved.push(command);
        return "approval-1" as never;
      },
    });

    expect(outcome).toEqual({ status: "ok", branch: "feature/target" });
    expect(approved).toHaveLength(1);
    expect(executeOperation).toHaveBeenCalledTimes(1);
    // The grant names this operation id and state token: the executed command
    // must be the very one the person approved, field for field.
    expect(executeOperation.mock.calls[0]?.[0]).toBe(approved[0]);
    expect(executeOperation.mock.calls[0]?.[0]).toMatchObject({
      kind: "switch-git-branch",
      branch: "feature/target",
      expectedStateToken: request.expectedStateToken,
    });
  });

  it("sends no operation when the approval is declined under a gated posture", async () => {
    const { client, executeOperation } = host();
    const outcome = await switchCodeBranch(client, uuids(), scope, request, {
      executionPolicy: "auto-accept-edits",
      requestApproval: async () => undefined,
    });

    expect(outcome).toEqual({ status: "refused", message: "The branch switch was not approved." });
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("answers refused, and sends no operation, when the approval request itself fails", async () => {
    const { client, executeOperation } = host();
    const outcome = await switchCodeBranch(client, uuids(), scope, request, {
      executionPolicy: "approval-gated",
      requestApproval: async () => {
        throw new Error("the window went away");
      },
    });

    expect(outcome).toEqual({ status: "refused", message: "The branch switch was not approved." });
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("runs without asking under full access", async () => {
    const { client, executeOperation } = host();
    const requestApproval = vi.fn(async () => "approval-1" as never);
    const outcome = await switchCodeBranch(client, uuids(), scope, request, {
      executionPolicy: "full-access",
      requestApproval,
    });

    expect(outcome).toEqual({ status: "ok", branch: "feature/target" });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(executeOperation).toHaveBeenCalledTimes(1);
  });

  it("refuses in Plan mode without asking or sending", async () => {
    const { client, executeOperation } = host();
    const requestApproval = vi.fn(async () => "approval-1" as never);
    const outcome = await switchCodeBranch(client, uuids(), scope, request, {
      executionPolicy: "plan",
      requestApproval,
    });

    expect(outcome).toEqual({
      status: "refused",
      message: "Plan mode is read-only; switching is unavailable.",
    });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(executeOperation).not.toHaveBeenCalled();
  });
});

describe("observeCodeBranchState", () => {
  it("returns the token and the status entries the consent screen shows", async () => {
    const { client, executeOperation } = host({
      kind: "git-observed",
      stateToken: "b".repeat(64),
      status: [
        { path: "src/index.ts", index: "M", worktree: " " },
        { path: "notes.txt", index: "?", worktree: "?" },
      ],
    });
    const outcome = await observeCodeBranchState(client, uuids(), scope);
    expect(outcome).toEqual({
      status: "ok",
      preview: {
        stateToken: "b".repeat(64),
        entries: [
          { path: "src/index.ts", index: "M", worktree: " " },
          { path: "notes.txt", index: "?", worktree: "?" },
        ],
      },
    });
    // The preview asks for the full untracked listing so the token it
    // consents against notices a file nested in an untracked directory.
    expect(executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "observe-git", untrackedFiles: "all" }),
    );
  });
});
