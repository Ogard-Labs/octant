import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  journalThreadMessageSteered,
  readNewestThreadMessagesSteered,
  readThreadMessagesSteered,
  threadMessagesSteeredInto,
} from "./threadMessageSteeredRecord";

const directories: string[] = [];
const connections: SqliteConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("steered messages of a thread", () => {
  it("reads the newest ones in order however many came before", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-steered-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "events.sqlite3"));
    connections.push(connection);
    const now = "2026-11-01T10:00:00.000Z";
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const threadId = randomUUID();
    const bodies: string[] = [];
    for (let index = 0; index < 1_100; index += 1) {
      bodies.push(`message ${String(index)}`);
      journalThreadMessageSteered(journal, {
        mode: "code",
        threadId,
        turnKey: randomUUID(),
        messageId: randomUUID(),
        body: `message ${String(index)}`,
        steeredAt: new Date(Date.parse(now) + index * 1_000).toISOString(),
        uuid: randomUUID,
        actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000001" as never },
      });
    }

    expect(
      readNewestThreadMessagesSteered(journal, threadId, 3).map((record) => record.body),
    ).toEqual(["message 1097", "message 1098", "message 1099"]);
    expect(
      readNewestThreadMessagesSteered(journal, threadId, 1).map((record) => record.body),
    ).toEqual(["message 1099"]);
  });

  it("keeps the pull requests and issues a steered message mentioned on the turn it entered", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-steered-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "events.sqlite3"));
    connections.push(connection);
    const now = "2026-11-01T10:00:00.000Z";
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const threadId = randomUUID();
    const turnKey = randomUUID();
    journalThreadMessageSteered(journal, {
      mode: "code",
      threadId,
      turnKey,
      messageId: randomUUID(),
      body: "also [#7 Bug](https://github.com/acme/app/issues/7)",
      steeredAt: now,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000001" as never },
    });

    expect(
      threadMessagesSteeredInto(readThreadMessagesSteered(journal, threadId), turnKey).map(
        (message) => message.trackerMentions,
      ),
    ).toEqual([
      [
        {
          kind: "github-issue",
          source: "github",
          id: "7",
          url: "https://github.com/acme/app/issues/7",
        },
      ],
    ]);
  });
});
