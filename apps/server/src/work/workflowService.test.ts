import { describe, expect, it, vi } from "vitest";
import { decodeWorkThreadId, decodeProjectId, type WorkflowFrame } from "@octant/contracts";
import { WorkflowProjection } from "./workflowProjection";
import { WorkflowService } from "./workflowService";
import type { WorkflowEventStorePort } from "./workflowService";
import type { WorkflowThreadSourcePort } from "./workflowService";

const ids = {
  project: decodeProjectId("22222222-2222-4222-8222-222222222222"),
  otherProject: decodeProjectId("44444444-4444-4444-8444-444444444444"),
  thread: decodeWorkThreadId("33333333-3333-4333-8333-333333333333"),
  otherThread: decodeWorkThreadId("66666666-6666-4666-8666-666666666666"),
} as const;

let clockValue = "2026-08-10T08:00:00.000Z";
function clock(): string {
  return clockValue;
}

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  const suffix = uuidCounter.toString(16).padStart(12, "0");
  return `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
}

function createEventStore(): WorkflowEventStorePort & {
  readonly appended: Array<WorkflowFrame>;
} {
  const appended: Array<WorkflowFrame> = [];
  const heads = new Map<string, number>();
  return {
    appended,
    append(input) {
      const head = heads.get(String(input.workflowId)) ?? 0;
      if (head !== input.expectedVersion) {
        throw new Error("concurrency conflict");
      }
      heads.set(String(input.workflowId), input.expectedVersion + 1);
      appended.push(input.frame);
      return input.frame;
    },
    replayAll() {
      return { status: "ok", frames: appended };
    },
  };
}

function createService(
  eventStore: WorkflowEventStorePort = createEventStore(),
  threads: WorkflowThreadSourcePort = { listFacts: () => [] },
) {
  const projection = new WorkflowProjection();
  const service = new WorkflowService({
    projection,
    eventStore,
    threads,
    uuid,
    clock,
  });
  return { service, projection, eventStore, threads };
}

describe("WorkflowService", () => {
  it("starts a new active workflow for a thread that becomes active", () => {
    const { service, projection } = createService();
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    const latest = projection.latestForThread(ids.thread);
    expect(latest?.lifecycle).toBe("active");
    expect(latest?.version).toBe(1);
    expect(latest?.projectId).toBe(ids.project);
    expect(latest?.relatedThreadId).toBe(ids.thread);
  });

  it("derives a bounded valid workflow label from any valid thread title", () => {
    const { service, projection } = createService();
    const title = `  ${"A".repeat(700)}  `;
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: title,
      lifecycle: "active",
    });

    const label = projection.latestForThread(ids.thread)?.label;
    expect(label).toHaveLength(512);
    expect(label).toMatch(/…$/);
  });

  it("does not start a duplicate workflow when the thread is already active", () => {
    const { service, projection } = createService();
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief (renamed)",
      lifecycle: "active",
    });
    const active = projection.listByProject(ids.project).filter((w) => w.lifecycle === "active");
    expect(active).toHaveLength(1);
  });

  it("does not complete the active workflow when the thread merely archives", () => {
    const { service, projection } = createService();
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    clockValue = "2026-08-10T09:00:00.000Z";
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "archived",
    });
    const latest = projection.latestForThread(ids.thread);
    expect(latest?.lifecycle).toBe("active");
    expect(latest?.version).toBe(1);
    expect(latest?.updatedAt).not.toBe(clockValue);
  });

  it("completes the active workflow only on an explicit confirmed-completion signal", () => {
    const { service, projection } = createService();
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    clockValue = "2026-08-10T09:00:00.000Z";
    service.confirmCompletion({ relatedThreadId: ids.thread });
    const latest = projection.latestForThread(ids.thread);
    expect(latest?.lifecycle).toBe("completed");
    expect(latest?.version).toBe(2);
    expect(latest?.updatedAt).toBe(clockValue);
  });

  it("does nothing when an explicit completion signal has no active workflow", () => {
    const { service, projection } = createService();
    service.confirmCompletion({ relatedThreadId: ids.thread });
    expect(projection.latestForThread(ids.thread)).toBeUndefined();
  });

  it("cancels the active workflow when the thread is deleted", () => {
    const { service, projection } = createService();
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "deleted",
    });
    expect(projection.latestForThread(ids.thread)?.lifecycle).toBe("cancelled");
  });

  it("does nothing when a thread archives with no active workflow", () => {
    const { service, projection } = createService();
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "archived",
    });
    expect(projection.latestForThread(ids.thread)).toBeUndefined();
  });

  it("continues the same active workflow when an archived thread is reactivated", () => {
    const { service, projection } = createService();
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    const firstWorkflowId = projection.latestForThread(ids.thread)?.workflowId;
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "archived",
    });
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    const latest = projection.latestForThread(ids.thread);
    expect(latest?.lifecycle).toBe("active");
    expect(latest?.version).toBe(1);
    expect(latest?.workflowId).toBe(firstWorkflowId);
  });

  it("starts a fresh workflow instance when a thread reactivates after an explicit completion", () => {
    const { service, projection } = createService();
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    const firstWorkflowId = projection.latestForThread(ids.thread)?.workflowId;
    service.confirmCompletion({ relatedThreadId: ids.thread });
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    const latest = projection.latestForThread(ids.thread);
    expect(latest?.lifecycle).toBe("active");
    expect(latest?.version).toBe(1);
    expect(latest?.workflowId).not.toBe(firstWorkflowId);
  });

  it("scopes listByProject to the exact Project", () => {
    const { service, projection } = createService();
    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    service.recordThreadLifecycle({
      projectId: ids.otherProject,
      relatedThreadId: ids.otherThread,
      label: "Other Project work",
      lifecycle: "active",
    });
    expect(projection.listByProject(ids.project)).toHaveLength(1);
  });

  it("hydrate() replays all frames from the event store into the projection", () => {
    const eventStore = createEventStore();
    const { service: seedService } = createService(eventStore);
    seedService.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    const freshProjection = new WorkflowProjection();
    const freshService = new WorkflowService({
      projection: freshProjection,
      eventStore,
      threads: { listFacts: () => [] },
      uuid,
      clock,
    });
    freshService.hydrate();
    expect(freshProjection.latestForThread(ids.thread)?.lifecycle).toBe("active");
  });

  it("hydrate() rebuilds a lost workflow start from the ordered thread history", () => {
    const durableStore = createEventStore();
    let failAppend = true;
    const eventStore: WorkflowEventStorePort = {
      append(input) {
        if (failAppend) {
          failAppend = false;
          throw new Error("workflow journal unavailable");
        }
        return durableStore.append(input);
      },
      replayAll: () => durableStore.replayAll(),
    };
    const projection = new WorkflowProjection();
    const service = new WorkflowService({
      projection,
      eventStore,
      uuid,
      clock,
      threads: {
        listFacts: () => [
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "active",
          },
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "archived",
          },
        ],
      },
    });

    service.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    service.hydrate();

    expect(projection.latestForThread(ids.thread)?.lifecycle).toBe("active");
  });

  it("hydrate() rebuilds a lost cancellation from the ordered thread history", () => {
    const eventStore = createEventStore();
    const { service: seedService } = createService(eventStore);
    seedService.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    const durableStore = eventStore;
    let failAppend = true;
    const recoveringStore: WorkflowEventStorePort = {
      append(input) {
        if (failAppend) {
          failAppend = false;
          throw new Error("workflow journal unavailable");
        }
        return durableStore.append(input);
      },
      replayAll: () => durableStore.replayAll(),
    };
    const projection = new WorkflowProjection();
    const service = new WorkflowService({
      projection,
      eventStore: recoveringStore,
      threads: {
        listFacts: () => [
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "active",
          },
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "deleted",
          },
        ],
      },
      uuid,
      clock,
    });

    service.hydrate();
    service.hydrate();

    expect(projection.latestForThread(ids.thread)?.lifecycle).toBe("cancelled");
  });

  it("hydrate() does not reopen a completed workflow from its unchanged active thread snapshot", () => {
    const eventStore = createEventStore();
    const { service: seedService } = createService(eventStore);
    seedService.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    seedService.confirmCompletion({ relatedThreadId: ids.thread });
    const projection = new WorkflowProjection();
    const service = new WorkflowService({
      projection,
      eventStore,
      threads: {
        listFacts: () => [
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "active",
          },
        ],
      },
      uuid,
      clock,
    });

    service.hydrate();

    expect(projection.latestForThread(ids.thread)?.lifecycle).toBe("completed");
    expect(eventStore.appended).toHaveLength(2);
  });

  it("hydrate() is idempotent for a deleted thread with a cancelled workflow", () => {
    const eventStore = createEventStore();
    const { service: seedService } = createService(eventStore);
    seedService.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    const projection = new WorkflowProjection();
    const service = new WorkflowService({
      projection,
      eventStore,
      threads: {
        listFacts: () => [
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "active",
          },
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "deleted",
          },
        ],
      },
      uuid,
      clock,
    });

    service.hydrate();
    service.hydrate();

    expect(projection.latestForThread(ids.thread)?.lifecycle).toBe("cancelled");
    expect(eventStore.appended).toHaveLength(2);
  });

  it("hydrate() applies each completion fact to its historical workflow instance", () => {
    const eventStore = createEventStore();
    const { service: seedService } = createService(eventStore);
    seedService.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    const firstWorkflowId = eventStore.appended[0]?.workflow.workflowId;
    seedService.confirmCompletion({ relatedThreadId: ids.thread });
    seedService.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    const secondWorkflowId = eventStore.appended[2]?.workflow.workflowId;
    const projection = new WorkflowProjection();
    const service = new WorkflowService({
      projection,
      eventStore,
      threads: {
        listFacts: () => [
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "active",
          },
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "completed",
          },
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "archived",
          },
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "active",
          },
        ],
      },
      uuid,
      clock,
    });

    service.hydrate();

    expect(projection.lookup(firstWorkflowId!)?.lifecycle).toBe("completed");
    expect(projection.lookup(secondWorkflowId!)?.lifecycle).toBe("active");
    expect(eventStore.appended).toHaveLength(3);
  });

  it("hydrate() does not recreate a deleted historical workflow period", () => {
    const eventStore = createEventStore();
    const { service: seedService } = createService(eventStore);
    seedService.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    seedService.confirmCompletion({ relatedThreadId: ids.thread });
    seedService.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "archived",
    });
    seedService.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
    });
    seedService.recordThreadLifecycle({
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "deleted",
    });
    const projection = new WorkflowProjection();
    const service = new WorkflowService({
      projection,
      eventStore,
      threads: {
        listFacts: () => [
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "active",
          },
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "completed",
          },
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "archived",
          },
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "active",
          },
          {
            projectId: ids.project,
            relatedThreadId: ids.thread,
            label: "Draft the launch brief",
            lifecycle: "deleted",
          },
        ],
      },
      uuid,
      clock,
    });
    const frameCount = eventStore.appended.length;

    service.hydrate();
    service.hydrate();

    expect(projection.latestForThread(ids.thread)?.lifecycle).toBe("cancelled");
    expect(eventStore.appended).toHaveLength(frameCount);
  });

  it("hydrate() throws when the event store reports snapshot-required", () => {
    const eventStore: WorkflowEventStorePort = {
      append: vi.fn(),
      replayAll: () => ({
        status: "snapshot-required",
        reason: "invalid-frame",
      }),
    };
    const { service } = createService(eventStore);
    expect(() => service.hydrate()).toThrow();
  });

  it("never throws out of recordThreadLifecycle when the event store append fails", () => {
    const eventStore: WorkflowEventStorePort = {
      append: () => {
        throw new Error("journal unavailable");
      },
      replayAll: () => ({ status: "ok", frames: [] }),
    };
    const { service, projection } = createService(eventStore);
    expect(() =>
      service.recordThreadLifecycle({
        projectId: ids.project,
        relatedThreadId: ids.thread,
        label: "Draft the launch brief",
        lifecycle: "active",
      }),
    ).not.toThrow();
    expect(projection.latestForThread(ids.thread)).toBeUndefined();
  });
});
