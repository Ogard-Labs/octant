import { describe, expect, it } from "vitest";
import { decodeWorkflow, decodeWorkflowFrame, decodeWorkflowId } from "./workflows";

const ids = {
  workflow: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  thread: "33333333-3333-4333-8333-333333333333",
} as const;

const startedAt = "2026-08-10T08:00:00.000Z";
const updatedAt = "2026-08-10T08:05:00.000Z";

const activeWorkflow = {
  workflowId: ids.workflow,
  projectId: ids.project,
  relatedThreadId: ids.thread,
  label: "Draft the launch brief",
  lifecycle: "active",
  startedAt,
  updatedAt: startedAt,
  version: 1,
} as const;

const completedWorkflow = {
  ...activeWorkflow,
  lifecycle: "completed",
  updatedAt,
  version: 2,
} as const;

describe("WorkflowId", () => {
  it("decodes a valid branded UUID", () => {
    expect(decodeWorkflowId(ids.workflow)).toEqual(ids.workflow);
  });

  it("rejects a non-UUID", () => {
    expect(() => decodeWorkflowId("not-a-uuid")).toThrow();
  });
});

describe("Workflow", () => {
  it("decodes a valid active workflow at version 1", () => {
    expect(decodeWorkflow(activeWorkflow)).toEqual(activeWorkflow);
  });

  it("decodes a valid completed workflow at a later version", () => {
    expect(decodeWorkflow(completedWorkflow)).toEqual(completedWorkflow);
  });

  it("decodes a valid cancelled workflow", () => {
    const cancelled = { ...activeWorkflow, lifecycle: "cancelled", updatedAt, version: 2 } as const;
    expect(decodeWorkflow(cancelled)).toEqual(cancelled);
  });

  it("rejects an active workflow whose version is not 1", () => {
    expect(() => decodeWorkflow({ ...activeWorkflow, version: 2 })).toThrow();
  });

  it("rejects a completed workflow at version 1", () => {
    expect(() =>
      decodeWorkflow({ ...activeWorkflow, lifecycle: "completed", version: 1 }),
    ).toThrow();
  });

  it("rejects an unknown lifecycle value", () => {
    expect(() => decodeWorkflow({ ...activeWorkflow, lifecycle: "in-review" })).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() => decodeWorkflow({ ...activeWorkflow, worktreePath: "/tmp" })).toThrow();
  });
});

describe("WorkflowFrame", () => {
  it("decodes a started frame", () => {
    const frame = { kind: "started", workflow: activeWorkflow } as const;
    expect(decodeWorkflowFrame(frame)).toEqual(frame);
  });

  it("decodes a completed frame", () => {
    const frame = { kind: "completed", workflow: completedWorkflow } as const;
    expect(decodeWorkflowFrame(frame)).toEqual(frame);
  });

  it("decodes a cancelled frame", () => {
    const cancelled = { ...activeWorkflow, lifecycle: "cancelled", updatedAt, version: 2 } as const;
    const frame = { kind: "cancelled", workflow: cancelled } as const;
    expect(decodeWorkflowFrame(frame)).toEqual(frame);
  });

  it("rejects a started frame whose workflow is not active", () => {
    expect(() => decodeWorkflowFrame({ kind: "started", workflow: completedWorkflow })).toThrow();
  });

  it("rejects a completed frame whose workflow lifecycle is active", () => {
    expect(() => decodeWorkflowFrame({ kind: "completed", workflow: activeWorkflow })).toThrow();
  });

  it("rejects a cancelled frame whose workflow lifecycle is completed", () => {
    expect(() => decodeWorkflowFrame({ kind: "cancelled", workflow: completedWorkflow })).toThrow();
  });
});
