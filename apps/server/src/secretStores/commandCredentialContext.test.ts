import { Schema } from "effect";
import {
  decodeCodeThread,
  decodeCodeCheckoutIdentity,
  decodeCodeFileId,
  Project,
} from "@octant/contracts";
import { describe, it, expect, vi } from "vitest";
import { commandCredentialContext } from "./commandCredentialContext";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-11-03T00:00:00.000Z";
const thread = decodeCodeThread({
  id: id(1),
  projectId: id(2),
  bindingRevisionId: id(3),
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: id(4),
  title: "Fixture",
  lifecycle: "active",
  providerInstanceId: id(5),
  modelId: "model",
  executionPolicy: "full-access",
  permissionPersistence: "project-default",
  deliveryTarget: {
    branchIntent: "feature/fixture",
    remoteName: "origin",
    proposedBaseRepository: "octant/fixture",
    proposedBaseBranch: "main",
    outcomeKind: "opened-pr",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const project = (root = "/fixture") =>
  Schema.decodeUnknownSync(Project)({
    id: thread.projectId,
    type: "code",
    name: "Fixture",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: root },
    bindingHistory: [
      {
        revisionId: thread.bindingRevisionId,
        revision: 1,
        currentBinding: { canonicalRoot: root },
        actor: { kind: "local-user", actorId: id(6) },
        changedAt: now,
      },
    ],
    codeAccessPersistence: "project-default",
  });
function fixture() {
  let live = true;
  let currentProject = project();
  let receipt = true;
  let narrowed = false;
  const checkout = decodeCodeCheckoutIdentity({
    id: thread.checkoutId,
    repositoryId: thread.repositoryId,
    kind: "managed-worktree",
    availability: "available",
    head: { kind: "none" },
    ownershipReceiptId: id(7),
    observedAt: now,
  });
  const read = vi.fn(async () => thread);
  const resolve = vi.fn(async () =>
    receipt
      ? {
          rootPath: "/fixture",
          rootIdentity: { device: "1", inode: "2" },
          fileId: decodeCodeFileId(id(8)),
        }
      : undefined,
  );
  const context = commandCredentialContext({
    persistence: {
      readCodeThread: () => thread,
      readCodeCheckout: () => checkout,
      readProject: () => currentProject,
    },
    read,
    roots: { resolve },
    session: { effectiveThread: (_w, t) => t },
    runtime: {
      threadWithActiveTurnPosture: (t) => (narrowed ? { ...t, executionPolicy: "plan" } : t),
    },
    providerRevision: () => 1,
    windowCurrent: () => live,
    canAccess: () => true,
  });
  return {
    context,
    read,
    resolve,
    closeWindow: () => {
      live = false;
    },
    rebind: () => {
      currentProject = project("/different");
    },
    removeReceipt: () => {
      receipt = false;
    },
    narrow: () => {
      narrowed = true;
    },
  };
}
describe("current Code credential command authority", () => {
  it("refuses host/routine/remote scopes that are not registered local windows even when Project access says yes", async () => {
    const f = fixture();
    f.closeWindow();
    expect(await f.context(id(9), String(thread.id))).toBeUndefined();
    expect(f.read).not.toHaveBeenCalled();
  });
  it("rechecks Project rebind and active turn narrowing instead of trusting a stored Full access thread", async () => {
    const f = fixture();
    const context = await f.context(id(9), String(thread.id));
    expect(context?.current()).toBe(true);
    f.rebind();
    expect(context?.current()).toBe(false);
    const g = fixture();
    const second = await g.context(id(9), String(thread.id));
    g.narrow();
    expect(second?.current()).toBe(false);
  });
  it("revalidates the owning root seam when a managed checkout receipt is revoked", async () => {
    const f = fixture();
    const context = await f.context(id(9), String(thread.id));
    expect(context?.current()).toBe(true);
    f.removeReceipt();
    expect(await context?.revalidate()).toBe(false);
    expect(f.resolve).toHaveBeenCalledTimes(2);
  });
});
