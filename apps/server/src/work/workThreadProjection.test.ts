import {
  type AggregateVersion,
  type UtcTimestamp,
  decodeWorkThread,
  decodeWorkThreadId,
  decodeProjectId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  WorkThreadProjection,
  hydrateWorkThreadProjectionFromJournal,
} from "./workThreadProjection";

const now = "2026-07-26T20:00:00.000Z" as UtcTimestamp;
const ids = {
  project: decodeProjectId("71000000-0000-4000-8000-000000000001"),
  otherProject: decodeProjectId("71000000-0000-4000-8000-000000000002"),
  thread: decodeWorkThreadId("71000000-0000-4000-8000-000000000003"),
  otherThread: decodeWorkThreadId("71000000-0000-4000-8000-000000000004"),
  provider: "71000000-0000-4000-8000-000000000005",
} as const;

describe("WorkThreadProjection", () => {
  it("applies created and updated events and reads active snapshots by project", () => {
    const projection = new WorkThreadProjection();
    const created = thread();
    const updated = thread({
      title: "Reviewed brief",
      lifecycle: "archived",
      providerHandoff: {
        previousProviderInstanceId: ids.provider as never,
        previousModelId: "model-a" as never,
        nextProviderInstanceId: ids.provider as never,
        nextModelId: "model-b" as never,
        changedAt: now,
      },
      version: 2 as AggregateVersion,
      updatedAt: "2026-07-26T20:05:00.000Z" as UtcTimestamp,
    });

    projection.apply({ kind: "thread-created", thread: created });
    projection.apply({ kind: "thread-updated", thread: updated });
    projection.apply({
      kind: "thread-created",
      thread: thread({
        id: ids.otherThread,
        projectId: ids.otherProject,
        title: "Other project",
        updatedAt: "2026-07-26T20:06:00.000Z" as UtcTimestamp,
      }),
    });

    expect(projection.read(ids.thread)).toEqual(updated);
    expect(projection.listByProject(ids.project)).toEqual([updated]);
    expect(projection.list()).toEqual([expect.objectContaining({ id: ids.otherThread }), updated]);
  });

  it("hydrates only strict Work thread journal events", () => {
    const projection = new WorkThreadProjection();

    hydrateWorkThreadProjectionFromJournal({
      replay: () => [
        {
          globalSequence: 1,
          aggregateType: "work-thread",
          eventName: "work.thread-created@1",
          eventVersion: 1,
          payload: { kind: "thread-created", thread: thread() },
        },
        {
          globalSequence: 2,
          aggregateType: "chat-thread",
          eventName: "chat.thread-created@1",
          eventVersion: 1,
          payload: {},
        },
        {
          globalSequence: 3,
          aggregateType: "work-thread",
          eventName: "work.thread-updated@1",
          eventVersion: 1,
          payload: {
            kind: "thread-updated",
            thread: thread({
              title: "Hydrated update",
              version: 2 as AggregateVersion,
              updatedAt: now,
            }),
          },
        },
      ],
      projection,
    });

    expect(projection.read(ids.thread)).toEqual(
      thread({
        title: "Hydrated update",
        version: 2 as AggregateVersion,
        updatedAt: now,
      }),
    );
  });

  it("hydrates thread events from a host whose unrelated journal history exceeds the scan cap", () => {
    const projection = new WorkThreadProjection();
    let askedAggregate: string | undefined;
    const status = hydrateWorkThreadProjectionFromJournal({
      replay: (cursor) => {
        askedAggregate = cursor.aggregateType;
        if (cursor.afterSequence > 0) return [];
        return [
          {
            globalSequence: 200_001,
            aggregateType: "work-thread",
            eventName: "work.thread-created@1",
            eventVersion: 1,
            payload: { kind: "thread-created", thread: thread() },
          },
        ];
      },
      projection,
      maxScan: 1,
    });
    expect(askedAggregate).toBe("work-thread");
    expect(status).toBe("ok");
    expect(projection.read(ids.thread)?.title).toBe("Draft brief");
  });

  it("fails closed when the Work thread history itself exceeds the scan cap", () => {
    const projection = new WorkThreadProjection();
    const status = hydrateWorkThreadProjectionFromJournal({
      replay: (cursor) =>
        Array.from({ length: 2 }, (_unused, index) => ({
          globalSequence: cursor.afterSequence + index + 1,
          aggregateType: "work-thread",
          eventName: "work.thread-created@1",
          eventVersion: 1,
          payload: {
            kind: "thread-created",
            thread: thread({
              id: decodeWorkThreadId(
                `71000000-0000-4000-8000-${(index + 10).toString(16).padStart(12, "0")}`,
              ),
            }),
          },
        })),
      projection,
      maxScan: 1,
    });
    expect(status).toBe("snapshot-required");
  });

  it("retains lifecycle facts in application order for workflow reconciliation", () => {
    const projection = new WorkThreadProjection();
    const created = thread();
    const archived = thread({
      lifecycle: "archived",
      version: 2 as AggregateVersion,
      updatedAt: "2026-07-26T20:05:00.000Z" as UtcTimestamp,
    });
    const deleted = thread({
      lifecycle: "deleted",
      version: 3 as AggregateVersion,
      updatedAt: "2026-07-26T20:06:00.000Z" as UtcTimestamp,
    });

    projection.apply({ kind: "thread-created", thread: created });
    projection.apply({ kind: "thread-updated", thread: archived });
    projection.apply({ kind: "thread-updated", thread: deleted });

    expect(projection.listLifecycleFacts()).toEqual([
      {
        projectId: ids.project,
        relatedThreadId: ids.thread,
        label: "Draft brief",
        lifecycle: "active",
      },
      {
        projectId: ids.project,
        relatedThreadId: ids.thread,
        label: "Draft brief",
        lifecycle: "archived",
      },
      {
        projectId: ids.project,
        relatedThreadId: ids.thread,
        label: "Draft brief",
        lifecycle: "deleted",
      },
    ]);
  });
});

function thread(overrides: Partial<ReturnType<typeof decodeWorkThread>> = {}) {
  return decodeWorkThread({
    id: ids.thread,
    projectId: ids.project,
    title: "Draft brief",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}
