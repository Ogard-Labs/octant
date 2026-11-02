import { describe, expect, it } from "vitest";
import {
  decodeCodeThread,
  decodeContextSubjectRef,
  decodeWorkThread,
  decodeWindowId,
  type Project,
  type WorkAccess,
} from "@octant/contracts";
import { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import { WorkThreadProjection } from "../work/workThreadProjection";
import { createTaskAccessSubjectReader } from "./taskAccessSubject";

const windowId = decodeWindowId("82000000-0000-4000-8000-000000000001");
const now = "2026-11-02T21:00:00.000Z";
const work = decodeWorkThread({
  id: "82000000-0000-4000-8000-000000000002",
  projectId: "82000000-0000-4000-8000-000000000020",
  title: "Draft",
  lifecycle: "active",
  providerInstanceId: "82000000-0000-4000-8000-000000000010",
  modelId: "model",
  access: "full-access",
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const code = decodeCodeThread({
  id: "82000000-0000-4000-8000-000000000003",
  projectId: work.projectId,
  bindingRevisionId: "82000000-0000-4000-8000-000000000040",
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: "82000000-0000-4000-8000-000000000041",
  title: "Code",
  lifecycle: "active",
  providerInstanceId: work.providerInstanceId,
  modelId: "model",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/read",
    remoteName: "origin",
    proposedBaseRepository: "owner/repo",
    proposedBaseBranch: "main",
    outcomeKind: "opened-pr",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const subjectOf = (mode: "work" | "code") =>
  decodeContextSubjectRef({
    aggregateType: `${mode}-thread`,
    aggregateId: mode === "work" ? work.id : code.id,
  });

function fixture() {
  const projection = new WorkThreadProjection();
  projection.apply({ kind: "thread-created", thread: work });
  const session = new CodeSessionAuthorityStore();
  let running: WorkAccess | undefined;
  let active = true;
  let allowed = true;
  let plan = false;
  const read = createTaskAccessSubjectReader({
    code: () => code,
    work: (id) => projection.read(id),
    project: (id) =>
      id === work.projectId
        ? ({
            id,
            type: "work",
            lifecycle: active ? "active" : "archived",
            defaultPermissionMode: "auto",
          } as unknown as Project)
        : undefined,
    codeSettings: () => ({ defaultExecutionPolicy: "approval-gated" }),
    workSettings: () => ({ defaultAccess: "ask-first" }),
    canAccessCodeProject: () => allowed,
    session,
    activeCode: (thread) => (plan ? { ...thread, executionPolicy: "plan" } : thread),
    runningWork: () => running,
    tainted: () => true,
  });
  return {
    read: (mode: "work" | "code") => read(subjectOf(mode), windowId),
    projection,
    session,
    setRunning: (value: WorkAccess | undefined) => {
      running = value;
    },
    retireProject: () => {
      active = false;
    },
    revokeCode: () => {
      allowed = false;
    },
    plan: () => {
      plan = true;
    },
  };
}

describe("task access reads its owning live sources", () => {
  it("reads a real Work projection and running routine/turn ceiling instead of stored Full access", () => {
    const f = fixture();
    f.setRunning("ask-first");
    expect(f.read("work")).toMatchObject({
      selected: { executionPolicy: "full-access" },
      effective: { executionPolicy: "approval-gated", autoApprove: false },
      default: { mode: "auto", scope: "project" },
      standing: "active",
    });
    f.setRunning(undefined);
    expect(f.read("work")?.effective?.executionPolicy).toBe("full-access");
  });
  it("re-reads a moved or inactive Work Project instead of reusing its prior binding", () => {
    const f = fixture();
    expect(f.read("work")).toBeDefined();
    f.retireProject();
    expect(f.read("work")).toBeUndefined();
    const other = fixture();
    other.projection.apply({
      kind: "thread-updated",
      thread: decodeWorkThread({
        ...work,
        projectId: "82000000-0000-4000-8000-000000000021",
        version: 2,
      }),
    });
    expect(other.read("work")).toBeUndefined();
  });
  it("reports Done and archived Work standing from the actual projection", () => {
    const f = fixture();
    f.projection.apply({
      kind: "thread-updated",
      thread: decodeWorkThread({ ...work, completionConfirmed: true, version: 2 }),
    });
    expect(f.read("work")?.standing).toBe("completed");
    f.projection.apply({
      kind: "thread-updated",
      thread: decodeWorkThread({ ...work, lifecycle: "archived", version: 3 }),
    });
    expect(f.read("work")?.standing).toBe("inactive");
  });
  it("uses real Code session authority and then the running Plan overlay; neither is a new grant", () => {
    const f = fixture();
    f.session.grantFullAccess(windowId, code.id);
    expect(f.read("code")?.effective?.executionPolicy).toBe("full-access");
    f.plan();
    expect(f.read("code")?.effective?.executionPolicy).toBe("plan");
    f.session.revokeWindow(windowId);
    expect(f.read("code")?.selected.executionPolicy).toBe("approval-gated");
  });
  it("refuses Code facts when the existing current Project predicate refuses", () => {
    const f = fixture();
    f.revokeCode();
    expect(f.read("code")).toBeUndefined();
  });
});
