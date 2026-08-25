import { decodeCodeThread, decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { CodeSessionAuthorityStore } from "./codeSessionAuthorityStore";

const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const otherWindowId = decodeWindowId("10000000-0000-4000-8000-000000000002");
const thread = decodeCodeThread({
  id: "20000000-0000-4000-8000-000000000001",
  projectId: "30000000-0000-4000-8000-000000000001",
  bindingRevisionId: "40000000-0000-4000-8000-000000000001",
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: "50000000-0000-4000-8000-000000000001",
  title: "Session authority",
  lifecycle: "active",
  providerInstanceId: "60000000-0000-4000-8000-000000000001",
  modelId: "model",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/session",
    remoteName: "origin",
    proposedBaseRepository: "owner/repository",
    proposedBaseBranch: "development",
    outcomeKind: "opened-pr",
    confirmedAt: "2026-07-21T20:00:00.000Z",
  },
  version: 1,
  createdAt: "2026-07-21T20:00:00.000Z",
  updatedAt: "2026-07-21T20:00:00.000Z",
});

describe("CodeSessionAuthorityStore", () => {
  it("keeps current-session Full access in memory and clears it on window revocation", () => {
    const store = new CodeSessionAuthorityStore();
    store.grantFullAccess(windowId, thread.id);
    expect(store.effectiveThread(windowId, thread).executionPolicy).toBe("full-access");

    store.revokeWindow(windowId);
    expect(store.effectiveThread(windowId, thread).executionPolicy).toBe("approval-gated");
  });

  it("clears a Full access grant from every window that holds it, not just one", () => {
    const store = new CodeSessionAuthorityStore();
    store.grantFullAccess(windowId, thread.id);
    store.grantFullAccess(otherWindowId, thread.id);

    store.revokeThreadEverywhere(thread.id);

    expect(store.effectiveThread(windowId, thread).executionPolicy).toBe("approval-gated");
    expect(store.effectiveThread(otherWindowId, thread).executionPolicy).toBe("approval-gated");
  });
});
