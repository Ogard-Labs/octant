import { describe, expect, it } from "vitest";
import {
  decodeWorkThreadId,
  decodeWorkflowFrame,
  decodeWorkflowId,
  decodeProjectId,
  type WorkThreadId,
  type WorkflowFrame,
  type WorkflowId,
} from "@octant/contracts";
import { WorkflowProjection } from "./workflowProjection";

const ids = {
  workflow: decodeWorkflowId("11111111-1111-4111-8111-111111111111"),
  otherWorkflow: decodeWorkflowId("99999999-9999-4999-8999-999999999999"),
  project: decodeProjectId("22222222-2222-4222-8222-222222222222"),
  otherProject: decodeProjectId("44444444-4444-4444-8444-444444444444"),
  thread: decodeWorkThreadId("33333333-3333-4333-8333-333333333333"),
  otherThread: decodeWorkThreadId("66666666-6666-4666-8666-666666666666"),
} as const;

const startedAt = "2026-08-10T08:00:00.000Z";
const updatedAt = "2026-08-10T08:05:00.000Z";

function timestampForIndex(index: number): string {
  const totalMinutes = 480 + index;
  return `2026-08-10T${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}:00.000Z`;
}

function completionTimestamp(totalMinutes: number): string {
  return `2026-08-10T${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}:00.000Z`;
}

function started(
  workflowId = ids.workflow,
  projectId = ids.project,
  relatedThreadId = ids.thread,
): WorkflowFrame {
  return decodeWorkflowFrame({
    kind: "started",
    workflow: {
      workflowId,
      projectId,
      relatedThreadId,
      label: "Draft the launch brief",
      lifecycle: "active",
      startedAt,
      updatedAt: startedAt,
      version: 1,
    },
  });
}

function startedAtFrame(
  workflowId: WorkflowId,
  relatedThreadId: WorkThreadId,
  at: string,
): WorkflowFrame {
  return decodeWorkflowFrame({
    kind: "started",
    workflow: {
      workflowId,
      projectId: ids.project,
      relatedThreadId,
      label: "Draft the launch brief",
      lifecycle: "active",
      startedAt: at,
      updatedAt: at,
      version: 1,
    },
  });
}

function completed(workflowId = ids.workflow, version = 2, at = updatedAt): WorkflowFrame {
  return decodeWorkflowFrame({
    kind: "completed",
    workflow: {
      workflowId,
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "completed",
      startedAt,
      updatedAt: at,
      version,
    },
  });
}

describe("WorkflowProjection", () => {
  it("applies a started frame and makes it lookupable", () => {
    const projection = new WorkflowProjection();
    projection.apply(started());
    const workflow = projection.lookup(ids.workflow);
    expect(workflow?.lifecycle).toBe("active");
  });

  it("applies a completed frame and advances the lifecycle", () => {
    const projection = new WorkflowProjection();
    projection.apply(started());
    projection.apply(completed());
    const workflow = projection.lookup(ids.workflow);
    expect(workflow?.lifecycle).toBe("completed");
    expect(workflow?.version).toBe(2);
  });

  it("is idempotent: replaying the same frame twice does not change state", () => {
    const projection = new WorkflowProjection();
    projection.apply(started());
    projection.apply(started());
    expect(projection.snapshot().size).toBe(1);
    expect(projection.lookup(ids.workflow)?.version).toBe(1);
  });

  it("ignores a stale frame whose version is not strictly newer than the current head", () => {
    const projection = new WorkflowProjection();
    projection.apply(started());
    projection.apply(completed());
    // A duplicate delivery of the started frame must never roll a terminal
    // workflow back to active.
    projection.apply(started());
    expect(projection.lookup(ids.workflow)?.lifecycle).toBe("completed");
  });

  it("lists workflows for a Project only, most recently updated first", () => {
    const projection = new WorkflowProjection();
    projection.apply(started(ids.workflow, ids.project, ids.thread));
    projection.apply(started(ids.otherWorkflow, ids.otherProject, ids.otherThread));
    const list = projection.listByProject(ids.project);
    expect(list).toHaveLength(1);
    expect(list[0]?.workflowId).toBe(ids.workflow);
  });

  it("filters out terminal workflows before applying the Overview slice limit", () => {
    const projection = new WorkflowProjection();
    // 70 active workflows for the Project; the 10 most recently updated are
    // then completed. The Overview only consumes active workflows, so the
    // completed records must never displace older active workflows from the
    // bounded slice.
    const workflowIds: Array<WorkflowId> = [];
    for (let i = 0; i < 70; i += 1) {
      const suffix = i.toString(16).padStart(12, "0");
      const workflowId = decodeWorkflowId(`aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`);
      workflowIds.push(workflowId);
      projection.apply(startedAtFrame(workflowId, ids.thread, timestampForIndex(i)));
    }
    const completionBase = 600;
    for (let i = 60; i < 70; i += 1) {
      projection.apply(completed(workflowIds[i], i - 58, completionTimestamp(completionBase + i)));
    }

    const list = projection.listByProject(ids.project);
    expect(list).toHaveLength(60);
    expect(list.every((workflow) => workflow.lifecycle === "active")).toBe(true);
    // The oldest active workflow survives the 64-entry slice even though
    // 10 completed records were journaled most recently.
    expect(list.some((workflow) => workflow.workflowId === workflowIds[0])).toBe(true);
    // Completed records never appear in the Overview-facing list.
    expect(list.some((workflow) => workflow.workflowId === workflowIds[65])).toBe(false);
  });

  it("returns the latest workflow entry for a related thread", () => {
    const projection = new WorkflowProjection();
    projection.apply(started());
    projection.apply(completed());
    const latest = projection.latestForThread(ids.thread);
    expect(latest?.lifecycle).toBe("completed");
    expect(latest?.version).toBe(2);
  });

  it("uses journal application order instead of timestamps for thread history", () => {
    const projection = new WorkflowProjection();
    const first = startedAtFrame(ids.workflow, ids.thread, "2026-08-10T10:00:00.000Z");
    const second = startedAtFrame(ids.otherWorkflow, ids.thread, "2026-08-10T09:00:00.000Z");
    projection.apply(first);
    projection.apply(second);

    expect(projection.latestForThread(ids.thread)?.workflowId).toBe(ids.otherWorkflow);
  });

  it("returns undefined from latestForThread when no workflow exists for the thread", () => {
    const projection = new WorkflowProjection();
    expect(projection.latestForThread(ids.thread)).toBeUndefined();
  });

  it("snapshot returns an independent copy", () => {
    const projection = new WorkflowProjection();
    projection.apply(started());
    const snapshot = projection.snapshot();
    projection.apply(completed());
    expect(snapshot.get(ids.workflow)?.lifecycle).toBe("active");
    expect(projection.lookup(ids.workflow)?.lifecycle).toBe("completed");
  });
});
