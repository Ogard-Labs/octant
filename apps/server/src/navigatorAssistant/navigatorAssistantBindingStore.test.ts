import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeChatThreadId } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  JournalNavigatorAssistantBindingStore,
  NAVIGATOR_ASSISTANT_AGGREGATE_TYPE,
} from "./navigatorAssistantBindingStore";

const now = "2026-08-15T09:00:00.000Z";
const directories: Array<string> = [];
const connections: Array<SqliteConnection> = [];

const threadId = decodeChatThreadId("9e000000-0000-4000-8000-000000000001");
const otherThreadId = decodeChatThreadId("9e000000-0000-4000-8000-000000000002");

afterEach(() => {
  for (const connection of connections.splice(0)) {
    try {
      connection.close();
    } catch {
      // Already closed by the test that exercised a restart.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-navigator-assistant-"));
  directories.push(directory);
  return join(directory, "octant.sqlite3");
}

function openJournal(path: string): { readonly journal: Journal; readonly close: () => void } {
  const connection = openSqlite(path);
  connections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  return {
    journal: new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    }),
    close: () => connection.close(),
  };
}

describe("JournalNavigatorAssistantBindingStore", () => {
  it("has no binding before the conversation is first used", () => {
    const store = new JournalNavigatorAssistantBindingStore({
      journal: openJournal(storePath()).journal,
    });
    expect(store.read()).toBeUndefined();
    expect([...store.hiddenThreadIds()]).toEqual([]);
  });

  it("keeps the bound conversation across a host restart", () => {
    const path = storePath();
    const first = openJournal(path);
    const before = new JournalNavigatorAssistantBindingStore({ journal: first.journal });
    expect(before.bind({ threadId, boundAt: now })).toBe(threadId);
    first.close();

    // A restart rebuilds by replaying the journal. Without the durable event
    // the host would mint a second, empty Navigator conversation and strand
    // the transcript the user already had.
    const second = openJournal(path);
    const after = new JournalNavigatorAssistantBindingStore({ journal: second.journal });
    expect(after.read()).toBe(threadId);
    expect([...after.hiddenThreadIds()]).toEqual([String(threadId)]);
  });

  it("keeps the first conversation when a second bind races it", () => {
    const journal = openJournal(storePath()).journal;
    // Built before the first bind, so it still believes the host is unbound —
    // the state a concurrent request is in when it races.
    const racing = new JournalNavigatorAssistantBindingStore({ journal });
    new JournalNavigatorAssistantBindingStore({ journal }).bind({ threadId, boundAt: now });

    // The journal refuses the second append at version 0, so the racer adopts
    // the committed conversation rather than replacing the one the user is
    // already talking to.
    expect(racing.bind({ threadId: otherThreadId, boundAt: now })).toBe(threadId);
  });

  it("journals the binding under the Navigator aggregate", () => {
    const journal = openJournal(storePath()).journal;
    new JournalNavigatorAssistantBindingStore({ journal }).bind({ threadId, boundAt: now });
    const events = journal.replayAggregateType({
      aggregateType: NAVIGATOR_ASSISTANT_AGGREGATE_TYPE,
      afterSequence: 0,
      limit: 10,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventName).toBe("navigator-assistant.thread-bound@1");
    expect(events[0]?.payload).toEqual({ threadId, boundAt: now });
  });
});
