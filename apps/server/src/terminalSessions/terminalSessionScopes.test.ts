import { describe, expect, it } from "vitest";
import type { CodeCheckoutIdentity, CodeThread, Project } from "@octant/contracts";
import type { ManagedWorktreeReceipt } from "../code/managedWorktreeReceiptStore";
import { eligibleTerminalSessionFolders } from "./terminalSessionScopes";

const project = {
  id: "project" as never,
  name: "Project",
  pinned: false,
  rank: "0/1" as never,
  version: 1 as never,
  createdAt: "2026-11-06T00:00:00.000Z" as never,
  updatedAt: "2026-11-06T00:00:00.000Z" as never,
  codeAccessPersistence: "current-session",
  type: "code",
  lifecycle: "active",
  binding: { canonicalRoot: "/repo" },
  bindingHistory: [
    {
      revisionId: "revision" as never,
      revision: 1,
      currentBinding: { canonicalRoot: "/repo" },
      actor: { kind: "local-user", actorId: "actor" as never },
      changedAt: "2026-11-06T00:00:00.000Z" as never,
    },
  ],
} as Project;
const thread = {
  id: "thread",
  projectId: "project",
  bindingRevisionId: "revision",
  repositoryId: "repository",
} as CodeThread;
const checkout = {
  kind: "managed-worktree",
  availability: "available",
  id: "checkout",
  repositoryId: "repository",
  ownershipReceiptId: "receipt",
} as CodeCheckoutIdentity;
const receipt = {
  receiptId: "receipt",
  state: "ready",
  threadId: "thread",
  checkoutId: "checkout",
  repositoryId: "repository",
  canonicalRepositoryPath: "/repo",
  canonicalWorktreePath: "/managed/worktree",
} as ManagedWorktreeReceipt;

const scopes = (
  observed = receipt,
  threads = [thread],
  currentProject = project,
  currentCheckout = checkout,
) =>
  eligibleTerminalSessionFolders({
    project: currentProject,
    projectFolder: "/repo",
    threads,
    readCheckout: () => currentCheckout,
    loadReceipt: async () => observed,
  });

describe("terminal session source scopes", () => {
  it("admits a managed worktree only through its current Project binding and exact ready ownership receipt", async () => {
    expect(await scopes()).toEqual(["/managed/worktree"]);
    for (const changed of [
      { receiptId: "replacement" },
      { state: "creating" },
      { threadId: "foreign" },
      { checkoutId: "foreign" },
      { repositoryId: "foreign" },
      { canonicalRepositoryPath: "/foreign" },
    ] as const) {
      expect(await scopes({ ...receipt, ...changed })).toEqual([]);
    }
    expect(
      await scopes(receipt, [{ ...thread, bindingRevisionId: "old-revision" } as CodeThread]),
    ).toEqual([]);
    expect(await scopes(receipt, [{ ...thread, projectId: "foreign" } as CodeThread])).toEqual([]);
    expect(
      await scopes(receipt, [thread], { ...project, lifecycle: "archived" } as Project),
    ).toEqual([]);
    expect(
      await scopes(receipt, [thread], project, { ...checkout, availability: "unavailable" }),
    ).toEqual([]);
  });
});
