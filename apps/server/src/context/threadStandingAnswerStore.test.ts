import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventActor, THREAD_STANDING_ANSWER_AGGREGATE } from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ThreadStandingAnswerStore } from "./threadStandingAnswerStore";

const directories: Array<string> = [];
const threadA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const threadB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openHost(directory = mkdtempSync(join(tmpdir(), "octant-standing-answer-"))) {
  if (!directories.includes(directory)) directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-11-13T09:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => "2026-11-13T10:00:00.000Z",
  });
  let next = 0;
  const store = new ThreadStandingAnswerStore({
    journal,
    connection,
    uuid: () => `99999999-9999-4999-8999-${String(++next).padStart(12, "0")}`,
    clock: () => "2026-11-13T10:00:00.000Z",
    actor: Schema.decodeUnknownSync(EventActor)({
      kind: "local-user",
      actorId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    }),
  });
  const events = () =>
    connection
      .prepare("SELECT event_name, payload_json FROM event_journal WHERE aggregate_type = ?")
      .all(THREAD_STANDING_ANSWER_AGGREGATE) as ReadonlyArray<{
      readonly event_name: string;
      readonly payload_json: string;
    }>;
  return { directory, connection, store, events };
}

it("keeps a person's answer for one thread and one subject across a host restart", () => {
  const first = openHost();
  expect(first.store.covers(threadA, "delegation", true)).toBe(false);
  first.store.record(threadA, "delegation", true);
  expect(first.store.covers(threadA, "delegation", true)).toBe(true);
  expect(first.store.covers(threadA, "desktop-file-transfer", true)).toBe(false);
  expect(first.store.covers(threadB, "delegation", true)).toBe(false);
  expect(first.events().map((event) => event.event_name)).toEqual([
    "thread.standing-answer-recorded@1",
  ]);
  expect(JSON.parse(first.events()[0]?.payload_json ?? "{}")).toEqual({
    threadId: threadA,
    subject: "delegation",
    threadMarked: true,
  });
  first.connection.close();

  const restarted = openHost(first.directory);
  expect(restarted.store.covers(threadA, "delegation", true)).toBe(true);
  restarted.connection.close();
});

it("asks again after the thread reads outside content, and journals nothing for an answer it already holds", () => {
  const { store, events, connection } = openHost();
  store.record(threadA, "desktop-file-transfer", false);
  store.record(threadA, "desktop-file-transfer", false);
  expect(events()).toHaveLength(1);
  expect(store.covers(threadA, "desktop-file-transfer", false)).toBe(true);
  expect(store.covers(threadA, "desktop-file-transfer", true)).toBe(false);
  store.record(threadA, "desktop-file-transfer", true);
  expect(store.covers(threadA, "desktop-file-transfer", true)).toBe(true);
  expect(events()).toHaveLength(2);
  connection.close();
});
