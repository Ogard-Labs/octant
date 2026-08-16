import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeChatThreadId } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  readChatContent,
  readChatThread,
  readChatThreads,
  readPendingChatPurges,
  writeChatContent,
} from "./chatProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { catchUpProjection, rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-19T13:00:00.000Z";
const ids = {
  actor: "83000000-0000-4000-8000-000000000001",
  correlation: "83000000-0000-4000-8000-000000000002",
  provider: "83000000-0000-4000-8000-000000000003",
  thread: "83000000-0000-4000-8000-000000000010",
  content: "83000000-0000-4000-8000-000000000020",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("chat persistence restart", () => {
  it("restores thread metadata after restart and rebuilds without purged bodies", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-chat-restart-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const first = openSqlite(path);
    applyMigrations(first, MIGRATIONS, () => now);
    const firstRuntime = createPhase1RuntimeRegistries();
    const firstJournal = new Journal({
      connection: first,
      registry: firstRuntime.events,
      projections: firstRuntime.projections,
      clock: () => now,
    });
    const body = "restart-safe";
    const contentDigest = createHash("sha256").update(body).digest("hex");

    firstJournal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [
        {
          eventId: "83000000-0000-4000-8000-000000000100",
          eventName: "chat.thread-created@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "thread-created",
            thread: {
              id: ids.thread,
              title: "Restart thread",
              lifecycle: "active",
              providerInstanceId: ids.provider,
              modelId: "model-a",
              researchEnabled: false,
              researchRouting: "automatic",
              personalityInstructions: "Be calm.",
              version: 1,
              createdAt: now,
              updatedAt: now,
            },
          },
        },
      ],
    });
    firstJournal.append(
      {
        aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
        expectedVersion: 1,
        events: [
          {
            eventId: "83000000-0000-4000-8000-000000000099",
            eventName: "chat.turn-created@1",
            eventVersion: 1,
            correlationId: ids.correlation,
            actor: { kind: "system", actorId: ids.actor },
            occurredAt: now,
            payload: {
              kind: "turn-created",
              turn: {
                id: "83000000-0000-4000-8000-000000000098",
                threadId: ids.thread,
                sequence: 1,
                userMessageRef: {
                  contentId: ids.content,
                  digest: contentDigest,
                  byteLength: body.length,
                },
                attachmentIds: [],
                attempts: [],
                createdAt: now,
              },
            },
          },
        ],
      },
      {
        beforeEvents(connection) {
          writeChatContent(connection, {
            contentId: ids.content,
            threadId: ids.thread,
            role: "user",
            body,
            digest: contentDigest,
            byteLength: body.length,
          });
        },
      },
    );
    firstJournal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [
        {
          eventId: "83000000-0000-4000-8000-000000000101",
          eventName: "chat.deletion-requested@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "deletion-requested",
            threadId: ids.thread,
            requestedAt: now,
          },
        },
      ],
    });
    first.close();

    const reopened = openSqlite(path);
    applyMigrations(reopened, MIGRATIONS, () => now);
    const restartedRuntime = createPhase1RuntimeRegistries();
    const restartedJournal = new Journal({
      connection: reopened,
      registry: restartedRuntime.events,
      projections: restartedRuntime.projections,
      clock: () => now,
    });
    const chatProjection = restartedRuntime.projections.get("chat");
    if (chatProjection === undefined) throw new Error("chat projection must be registered");

    for (const projection of restartedRuntime.projections.all()) {
      catchUpProjection({
        connection: reopened,
        journal: restartedJournal,
        projection,
        clock: () => now,
      });
    }

    expect(readChatThread(reopened, decodeChatThreadId(ids.thread))?.lifecycle).toBe("deleting");
    expect(readChatContent(reopened, ids.content)?.body).toBe(body);
    expect(readPendingChatPurges(reopened)).toHaveLength(1);

    rebuildProjection({
      connection: reopened,
      journal: restartedJournal,
      projection: chatProjection,
      clock: () => now,
    });

    expect(readChatThread(reopened, decodeChatThreadId(ids.thread))?.lifecycle).toBe("deleting");
    expect(readChatContent(reopened, ids.content)?.body).toBe(body);
    expect(readChatThreads(reopened)).toHaveLength(1);
    reopened.close();
  });
});
