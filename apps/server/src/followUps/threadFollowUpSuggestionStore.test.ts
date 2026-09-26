import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  EventActor,
  NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
  NATIVE_HARNESS_SESSION_EVENT_NAMES,
  decodeNativeHarnessSlotCandidate,
  type NativeHarnessFollowUpSet,
} from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { registerNativeHarnessEvents } from "../harness/nativeHarnessEvents";
import { NativeHarnessSessionStore } from "../harness/nativeHarnessSessionStore";
import { settleFollowUpSuggestion } from "./followUpSuggestionRoutes";
import {
  registerFollowUpSuggestionEvents,
  ThreadFollowUpSuggestionStore,
} from "./threadFollowUpSuggestionStore";

const directories: string[] = [];
const now = "2026-09-26T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const threadId = "00000000-0000-4000-8000-000000000020";
const projectId = "00000000-0000-4000-8000-0000000000bb";
const claude = {
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "claude-sonnet",
} as never;
const suggestionId = "00000000-0000-4000-8000-000000000041";

function suggestions(title = "Add tests"): NativeHarnessFollowUpSet {
  return {
    turnId: "00000000-0000-4000-8000-000000000031",
    suggestions: [
      { id: suggestionId, title, prompt: "Write tests for the new parser.", target: "new-thread" },
    ],
  } as never;
}

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-follow-up-store-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function journalFor(connection: SqliteConnection): Journal {
  return new Journal({
    connection,
    registry: registerFollowUpSuggestionEvents(registerNativeHarnessEvents(new EventRegistry())),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
}

function uuidFactory() {
  let counter = 0;
  return () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`;
}

function storeOn(connection: SqliteConnection) {
  return new ThreadFollowUpSuggestionStore({
    journal: journalFor(connection),
    uuid: uuidFactory(),
    actor,
    clock: () => now,
  });
}

describe("thread follow-up suggestions", () => {
  it("keeps a non-harness thread's suggestions across a restart and retires them when a later reply offers none", () => {
    const connection = openConnection();
    const store = storeOn(connection);
    store.recordReply({
      threadId,
      mode: "code",
      projectId: projectId as never,
      suggestedBy: claude,
      followUps: suggestions(),
    });
    const restarted = storeOn(connection);
    expect(restarted.read(threadId)).toMatchObject({
      mode: "code",
      projectId,
      suggestedBy: { modelId: "claude-sonnet" },
      followUps: { suggestions: [{ title: "Add tests" }] },
      activatedFollowUpIds: [],
    });

    restarted.recordReply({ threadId, mode: "code", suggestedBy: claude, followUps: undefined });
    expect(storeOn(connection).read(threadId)?.followUps.suggestions).toEqual([]);
  });

  it("writes nothing for a thread whose replies never suggested anything", () => {
    const store = storeOn(openConnection());
    store.recordReply({ threadId, mode: "chat", suggestedBy: claude, followUps: undefined });
    expect(store.read(threadId)).toBeUndefined();
  });

  it("creates a confirmed follow-up once and leaves it offered when creation is refused", async () => {
    const store = storeOn(openConnection());
    store.recordReply({
      threadId,
      mode: "chat",
      projectId: projectId as never,
      suggestedBy: claude,
      followUps: suggestions(),
    });
    const settle = (
      action: string,
      createFollowUp: () => Promise<
        { kind: "created"; created: never } | { kind: "refused"; message: string }
      >,
    ) =>
      settleFollowUpSuggestion(
        { store, createFollowUp },
        {
          threadId,
          windowId: "00000000-0000-4000-8000-0000000000f0",
          action,
          body: { turnId: "00000000-0000-4000-8000-000000000031", suggestionId, confirmed: true },
        },
      );
    const created = {
      kind: "new-thread",
      mode: "chat",
      projectId,
      title: "Add tests",
      threadId: "00000000-0000-4000-8000-000000000099",
    } as never;

    const preview = await settle("preview", async () => ({ kind: "created", created }));
    expect(preview.body).toMatchObject({
      preview: { wouldCreate: { kind: "new-thread", mode: "chat", projectId } },
    });

    const refusedCreation = await settle("activate", async () => ({
      kind: "refused",
      message: "The host did not create the Chat thread.",
    }));
    expect(refusedCreation).toMatchObject({ status: 409, body: { kind: "follow-up-refused" } });
    expect(store.read(threadId)?.activatedFollowUpIds).toEqual([]);

    const activated = await settle("activate", async () => ({ kind: "created", created }));
    expect(activated).toMatchObject({ status: 200, body: { kind: "follow-up-activated" } });
    const repeated = await settle("activate", async () => ({ kind: "created", created }));
    expect(repeated).toMatchObject({ status: 409, body: { reason: "already-activated" } });
  });

  it("still offers a harness thread the follow-ups its session journaled", () => {
    const connection = openConnection();
    const journal = journalFor(connection);
    const sessions = new NativeHarnessSessionStore({
      journal,
      uuid: uuidFactory(),
      actor,
      clock: () => now,
    });
    sessions.ensure({
      threadId,
      mode: "work",
      projectId: projectId as never,
      leadSlotId: "default" as never,
      lead: decodeNativeHarnessSlotCandidate({
        hostId: "00000000-0000-4000-8000-0000000000aa",
        providerInstanceId: "00000000-0000-4000-8000-000000000002",
        modelId: "frontier-large",
      }),
    });
    journal.append({
      aggregate: { aggregateType: NATIVE_HARNESS_SESSION_AGGREGATE_TYPE, aggregateId: threadId },
      expectedVersion: 1,
      events: [
        {
          eventId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
          eventName: NATIVE_HARNESS_SESSION_EVENT_NAMES.followUpsSuggested,
          eventVersion: 1,
          correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
          actor,
          occurredAt: now,
          payload: suggestions("Document it"),
        },
      ],
    } as never);

    expect(storeOn(connection).read(threadId)).toMatchObject({
      mode: "work",
      projectId,
      suggestedBy: { modelId: "frontier-large" },
      followUps: { suggestions: [{ title: "Document it" }] },
    });
    expect(
      new NativeHarnessSessionStore({ journal, uuid: uuidFactory(), actor, clock: () => now }).read(
        threadId,
      )?.session.mode,
    ).toBe("work");
  });
});
