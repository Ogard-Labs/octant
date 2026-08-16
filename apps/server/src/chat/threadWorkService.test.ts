import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeChatThreadId,
  decodeThreadWorkItemId,
  type AggregateVersion,
  type ChatThread,
  type ChatThreadId,
  type ThreadWorkItemId,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { defaultShellSettings } from "@octant/domain";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import type { PersistenceService } from "../persistence/persistenceService";
import { ThreadWorkService, type ThreadFollowUpTriggerObservation } from "./threadWorkService";

type FollowUpAppendInput = {
  readonly aggregate: { readonly aggregateType: string };
  readonly expectedVersion: number;
  readonly events: ReadonlyArray<{ readonly causationId?: unknown }>;
};

const directories: Array<string> = [];
const now = "2026-07-19T12:00:00.000Z";
const ids = {
  actor: "82000000-0000-4000-8000-000000000001",
  correlation: "82000000-0000-4000-8000-000000000002",
  provider: "82000000-0000-4000-8000-000000000003",
  thread: "82000000-0000-4000-8000-000000000010",
  workItemA: "82000000-0000-4000-8000-000000000050",
  workItemB: "82000000-0000-4000-8000-000000000051",
  triggerEvent: "82000000-0000-4000-8000-000000000060",
  replayTrigger: "82000000-0000-4000-8000-000000000061",
  newTrigger: "82000000-0000-4000-8000-000000000062",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-thread-work-service-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: decodeChatThreadId(ids.thread),
    title: "Work list thread",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be calm.",
    version: 1 as AggregateVersion,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ChatThread;
}

function fixture(options?: {
  readonly chatEnabled?: boolean;
  readonly lifecycle?: ChatThread["lifecycle"];
}): {
  persistence: PersistenceService;
  service: ThreadWorkService;
} {
  const connection = openConnection();
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const persistence = {
    connection,
    journal,
    projections: runtime.projections,
    readShellSettings: () =>
      options?.chatEnabled === undefined
        ? undefined
        : {
            settings: { ...defaultShellSettings(), chatEnabled: options.chatEnabled },
            aggregateVersion: 1,
          },
    readWindowWorkspace: () => undefined,
    readWindowWorkspaces: () => [],
    readProject: () => undefined,
    readProjects: () => [],
    searchProjects: () => [],
    readMemoryEntry: () => undefined,
    readProjectMemory: () => ({ active: [], history: [] }),
    readProviderInstance: () => undefined,
    readProviderInstances: () => [],
    readProviderDefaults: () => ({
      defaultProviderInstanceId: ids.provider,
      version: 1 as AggregateVersion,
      updatedAt: now,
    }),
    readChatSettings: () => undefined,
    readChatThread: (threadId: ChatThreadId) =>
      String(threadId) === ids.thread
        ? thread({ lifecycle: options?.lifecycle ?? "active" })
        : undefined,
    readChatThreads: () => [thread({ lifecycle: options?.lifecycle ?? "active" })],
    readChatThreadView: () => undefined,
    readChatContent: () => undefined,
    searchChatThreads: () => [],
    readPendingChatPurges: () => [],
    status: () => ({ state: "current", integrity: "ok" }),
  } as unknown as PersistenceService;
  journal.append({
    aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
    expectedVersion: 0,
    events: [
      {
        eventId: crypto.randomUUID(),
        eventName: "chat.thread-created@1",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: { kind: "thread-created", thread: thread() },
      },
    ],
  });
  return {
    persistence,
    service: new ThreadWorkService({
      persistence,
      uuid: () => crypto.randomUUID(),
      clock: () => now,
    }),
  };
}

function itemId(value: keyof typeof ids): ThreadWorkItemId {
  return decodeThreadWorkItemId(ids[value] as (typeof ids)["workItemA"]);
}

describe("ThreadWorkService", () => {
  it("rejects work mutations while Chat mode is disabled", async () => {
    const { service, persistence } = fixture({ chatEnabled: false });
    const before = persistence.connection
      .prepare("SELECT COUNT(*) AS count FROM event_journal")
      .get() as { readonly count: number };

    await expect(
      service.execute({
        kind: "add-chat-work-item",
        threadId: decodeChatThreadId(ids.thread),
        expectedVersion: 0 as AggregateVersion,
        itemId: itemId("workItemA"),
        title: "Blocked",
        status: "pending",
        position: 0,
        origin: "user",
      }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(
      persistence.connection.prepare("SELECT COUNT(*) AS count FROM event_journal").get(),
    ).toEqual(before);
  });

  it.each(["archived", "deleting"] as const)(
    "rejects work and follow-up mutations on a %s thread",
    async (lifecycle) => {
      const { service, persistence } = fixture({ lifecycle });
      const threadId = decodeChatThreadId(ids.thread);
      const before = persistence.connection
        .prepare("SELECT COUNT(*) AS count FROM event_journal")
        .get() as { readonly count: number };

      await expect(
        service.execute({
          kind: "add-chat-work-item",
          threadId,
          expectedVersion: 0 as AggregateVersion,
          itemId: itemId("workItemA"),
          title: "Blocked",
          status: "pending",
          position: 0,
          origin: "user",
        }),
      ).rejects.toMatchObject({ failure: { category: "invalid" } });
      await expect(
        service.execute({
          kind: "open-chat-follow-up",
          threadId,
          expectedVersion: 0 as AggregateVersion,
          triggerSequence: 1,
          reason: "Blocked",
          origin: "manual",
        }),
      ).rejects.toMatchObject({ failure: { category: "invalid" } });
      expect(
        persistence.connection.prepare("SELECT COUNT(*) AS count FROM event_journal").get(),
      ).toEqual(before);
    },
  );

  it("persists work items with stable ordering and rejects stale edits", async () => {
    const { service } = fixture();
    const threadId = decodeChatThreadId(ids.thread);

    await service.execute({
      kind: "add-chat-work-item",
      threadId,
      expectedVersion: 0 as AggregateVersion,
      itemId: itemId("workItemA"),
      title: "Alpha",
      status: "pending",
      position: 0,
      origin: "user",
    });
    await service.execute({
      kind: "add-chat-work-item",
      threadId,
      expectedVersion: 1 as AggregateVersion,
      itemId: itemId("workItemB"),
      title: "Beta",
      status: "pending",
      position: 1,
      origin: "user",
    });

    const read = service.read(threadId);
    expect(read.workList.items.map((item) => item.title)).toEqual(["Alpha", "Beta"]);
    expect(read.workList.items[0]?.origin).toBe("user");

    await expect(
      service.execute({
        kind: "edit-chat-work-item",
        threadId,
        expectedVersion: 1 as AggregateVersion,
        itemId: itemId("workItemA"),
        title: "Stale edit",
      }),
    ).rejects.toMatchObject({
      failure: { category: "stale" },
    });
  });

  it("keeps completed follow-up stable for replayed triggers and reopens on a newer edge", async () => {
    const { service } = fixture();
    const threadId = decodeChatThreadId(ids.thread);

    await service.observeTrigger(trigger(5, "Blocked on approval", ids.triggerEvent));
    await service.execute({
      kind: "complete-chat-follow-up",
      threadId,
      expectedVersion: 1 as AggregateVersion,
      acknowledgedThroughSequence: 5,
    });

    await service.observeTrigger(trigger(3, "Replayed old trigger", ids.replayTrigger));
    expect(service.read(threadId).followUp?.state).toBe("completed");
    expect(service.read(threadId).followUp?.acknowledgedThroughSequence).toBe(5);

    await service.observeTrigger(trigger(10, "New blocked edge", ids.newTrigger));
    expect(service.read(threadId).followUp?.state).toBe("open");
    expect(service.read(threadId).followUp?.triggerSequence).toBe(10);
  });

  it("returns the committed follow-up when a trigger race loses to the same source event", async () => {
    const { persistence, service } = fixture();
    const observation = trigger(7, "Waiting on user", ids.triggerEvent);
    const realAppend = persistence.journal.append.bind(persistence.journal);
    let simulatedRace = false;

    persistence.journal.append = (input) => {
      const request = input as FollowUpAppendInput;
      const observedFollowUp =
        request.aggregate.aggregateType === "thread-follow-up" &&
        request.events.some((event) => event.causationId !== undefined);

      if (!simulatedRace && observedFollowUp) {
        simulatedRace = true;
        realAppend(input);
        throw new ConcurrencyConflict({
          aggregateType: "thread-follow-up",
          aggregateId: ids.thread,
          expectedVersion: request.expectedVersion,
          actualVersion: request.expectedVersion + 1,
        });
      }
      return realAppend(input);
    };

    const followUp = await service.observeTrigger(observation);
    expect(followUp).toMatchObject({
      state: "open",
      triggerSequence: 7,
      reason: "Waiting on user",
    });
    expect(
      persistence.connection
        .prepare(
          `
            SELECT count(*) AS count
            FROM event_journal
            WHERE aggregate_type = 'thread-follow-up'
              AND aggregate_id = ?
              AND causation_id = ?
          `,
        )
        .get(ids.thread, ids.triggerEvent),
    ).toEqual({ count: 1 });
  });

  it("keeps honest stale failures when a trigger append races without the same causation", async () => {
    const { persistence, service } = fixture();
    const observation = trigger(7, "Waiting on user", ids.triggerEvent);
    const realAppend = persistence.journal.append.bind(persistence.journal);

    persistence.journal.append = (input) => {
      const request = input as FollowUpAppendInput;
      if (request.aggregate.aggregateType === "thread-follow-up") {
        throw new ConcurrencyConflict({
          aggregateType: "thread-follow-up",
          aggregateId: ids.thread,
          expectedVersion: request.expectedVersion,
          actualVersion: request.expectedVersion + 1,
        });
      }
      return realAppend(input);
    };

    await expect(service.observeTrigger(observation)).rejects.toMatchObject({
      failure: { category: "stale" },
    });
  });

  it("attributes observed triggers to system actors and explicit commands to local-user", async () => {
    const { persistence, service } = fixture();
    const threadId = decodeChatThreadId(ids.thread);

    await service.observeTrigger(trigger(4, "Blocked on approval", ids.triggerEvent));
    await service.execute({
      kind: "add-chat-work-item",
      threadId,
      expectedVersion: 0 as AggregateVersion,
      itemId: itemId("workItemA"),
      title: "Alpha",
      status: "pending",
      position: 0,
      origin: "user",
    });
    await service.execute({
      kind: "open-chat-follow-up",
      threadId,
      expectedVersion: 1 as AggregateVersion,
      triggerSequence: 6,
      reason: "Manual follow-up",
      origin: "manual",
    });

    expect(
      persistence.connection
        .prepare(
          `
            SELECT actor_kind
            FROM event_journal
            WHERE aggregate_type = 'thread-follow-up'
              AND aggregate_id = ?
              AND causation_id = ?
          `,
        )
        .get(ids.thread, ids.triggerEvent),
    ).toEqual({ actor_kind: "system" });
    expect(
      persistence.connection
        .prepare(
          `
            SELECT actor_kind
            FROM event_journal
            WHERE aggregate_type = 'thread-work-list'
              AND aggregate_id = ?
          `,
        )
        .all(ids.thread)
        .map((row) => (row as { readonly actor_kind: string }).actor_kind),
    ).toEqual(["local-user"]);
    expect(
      persistence.connection
        .prepare(
          `
            SELECT actor_kind
            FROM event_journal
            WHERE aggregate_type = 'thread-follow-up'
              AND aggregate_id = ?
              AND causation_id IS NULL
          `,
        )
        .all(ids.thread)
        .map((row) => (row as { readonly actor_kind: string }).actor_kind),
    ).toEqual(["local-user"]);
  });

  it("is idempotent by source event identity and sequence", async () => {
    const { service, persistence } = fixture();
    const observation = trigger(7, "Waiting on user", ids.triggerEvent);

    const first = await service.observeTrigger(observation);
    const second = await service.observeTrigger(observation);
    expect(second).toEqual(first);
    expect(
      persistence.connection
        .prepare(
          `
            SELECT count(*) AS count
            FROM event_journal
            WHERE aggregate_type = 'thread-follow-up'
              AND aggregate_id = ?
              AND causation_id = ?
          `,
        )
        .get(ids.thread, ids.triggerEvent),
    ).toEqual({ count: 1 });
  });
});

function trigger(
  sequence: number,
  reason: string,
  sourceEventId: string,
): ThreadFollowUpTriggerObservation {
  return {
    threadId: decodeChatThreadId(ids.thread),
    sourceEventId,
    sourceSequence: sequence,
    reason,
    origin: "automatic",
    triggeredAt: now,
  };
}
