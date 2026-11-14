import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeEventActor,
  THREAD_NOTES_AGGREGATE_TYPE,
  type ThreadNotesResult,
  type WindowId,
} from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { registerThreadNoteEvents, ThreadNoteStore, ThreadNotesService } from "./threadNotes";
import { createThreadNotesRouteHandler } from "./threadNotesRoutes";

const directories: string[] = [];
const now = "2026-11-14T12:00:00.000Z";
const threadId = "00000000-0000-4000-8000-000000000020";
const otherThreadId = "00000000-0000-4000-8000-000000000021";
const windowId = "00000000-0000-4000-8000-0000000000f0" as WindowId;
const person = decodeEventActor({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const agent = decodeEventActor({
  kind: "agent",
  actorId: "88888888-8888-4888-8888-888888888888",
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  threadId,
});

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-thread-notes-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function journalOn(connection: SqliteConnection): Journal {
  return new Journal({
    connection,
    registry: registerThreadNoteEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
}

let counter = 0;
function uuid(): string {
  counter += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${counter.toString(16).padStart(12, "0")}`;
}

function serviceOn(journal: Journal) {
  return new ThreadNotesService({
    store: new ThreadNoteStore({ journal, uuid, clock: () => now }),
    canOpen: async (_windowId, id) => String(id) === threadId,
    readRecapSource: async (_windowId, id) =>
      String(id) === threadId
        ? {
            kind: "readable",
            mode: "work",
            title: "Quarterly report",
            transcript: [],
            truncated: false,
          }
        : { kind: "unreadable" },
  });
}

function notesOf(result: ThreadNotesResult) {
  if (result.kind !== "thread-notes") throw new Error(`expected notes, got ${result.kind}`);
  return result.notes;
}

describe("thread notes", () => {
  it("keeps the person's notes in the journal and rebuilds the same notes after a restart", async () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const service = serviceOn(journal);
    const context = { windowId, actor: person };

    const first = notesOf(
      await service.execute(
        { kind: "add-thread-note", threadId, text: "Ask Dana about Q3" },
        context,
      ),
    );
    await service.execute(
      { kind: "add-thread-note", threadId, text: "Draft is in /reports" },
      context,
    );
    const firstId = String(first[0]?.id);
    await service.execute(
      { kind: "edit-thread-note", threadId, noteId: firstId, text: "Ask Dana about Q3 numbers" },
      context,
    );
    const second = notesOf(
      await service.execute({ kind: "read-thread-notes", threadId }, context),
    )[1];
    await service.execute(
      { kind: "delete-thread-note", threadId, noteId: String(second?.id) },
      context,
    );

    const journaled = journal.replayAggregateType({
      aggregateType: THREAD_NOTES_AGGREGATE_TYPE,
      afterSequence: 0,
      limit: 100,
    });
    expect(journaled.map((event) => event.eventName)).toEqual([
      "thread.note-added@1",
      "thread.note-added@1",
      "thread.note-edited@1",
      "thread.note-deleted@1",
    ]);
    expect(journaled.every((event) => event.actor.kind === "local-user")).toBe(true);

    const rebuilt = serviceOn(journalOn(connection));
    const notes = notesOf(await rebuilt.execute({ kind: "read-thread-notes", threadId }, context));
    expect(notes.map((note) => note.text)).toEqual(["Ask Dana about Q3 numbers"]);
    expect(String(notes[0]?.id)).toBe(firstId);

    // The rebuilt store continues the aggregate rather than conflicting with it.
    expect(
      notesOf(
        await rebuilt.execute(
          { kind: "add-thread-note", threadId, text: "After restart" },
          context,
        ),
      ),
    ).toHaveLength(2);
    connection.close();
  });

  it("refuses a note from the thread's agent and journals nothing", async () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const service = serviceOn(journal);

    const result = await service.execute(
      { kind: "add-thread-note", threadId, text: "I am the agent" },
      { windowId, actor: agent },
    );

    expect(result).toMatchObject({ kind: "thread-notes-refused", reason: "not-the-person" });
    expect(
      journal.replayAggregateType({
        aggregateType: THREAD_NOTES_AGGREGATE_TYPE,
        afterSequence: 0,
        limit: 10,
      }),
    ).toHaveLength(0);
    connection.close();
  });

  it("refuses notes and a recap on a thread the window cannot open", async () => {
    const connection = openConnection();
    const service = serviceOn(journalOn(connection));
    const context = { windowId, actor: person };

    await expect(
      service.execute({ kind: "add-thread-note", threadId: otherThreadId, text: "x" }, context),
    ).resolves.toMatchObject({ reason: "thread-unavailable" });
    await expect(
      service.execute({ kind: "read-thread-recap", threadId: otherThreadId }, context),
    ).resolves.toMatchObject({ reason: "thread-unavailable" });
    await expect(
      service.execute({ kind: "read-thread-recap", threadId }, context),
    ).resolves.toMatchObject({ kind: "thread-recap", recap: { title: "Quarterly report" } });
    connection.close();
  });

  it("journals a note sent by a window as the local person and refuses a request without a window", async () => {
    const connection = openConnection();
    const journal = journalOn(connection);
    const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const route = createThreadNotesRouteHandler({
      service: serviceOn(journal),
      windowAuthorityStore,
      now: () => 1,
    });
    const post = (headers: Record<string, string>) =>
      route(
        new Request("http://127.0.0.1/api/thread-notes/commands", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ kind: "add-thread-note", threadId, text: "From the panel" }),
        }),
      );

    expect((await post({}))?.status).toBe(401);
    const accepted = await post({ "x-octant-window-capability": capability });
    expect(accepted?.status).toBe(200);
    const [event] = journal.replayAggregateType({
      aggregateType: THREAD_NOTES_AGGREGATE_TYPE,
      afterSequence: 0,
      limit: 10,
    });
    expect(event?.actor.kind).toBe("local-user");
    expect(event?.payload).toMatchObject({ threadId, text: "From the panel" });
    connection.close();
  });
});
