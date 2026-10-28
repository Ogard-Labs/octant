import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeChatThreadId, decodeProjectId } from "@octant/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasService } from "../apps/server/src/canvas/canvasService";
import {
  Persistence,
  makePersistenceLive,
  type PersistenceService,
} from "../apps/server/src/persistence/persistenceService";
import { CHAT_SETTINGS_AGGREGATE_ID } from "../apps/server/src/persistence/chatProjection";
import { OCTANT_LOCAL_ACTOR_ID } from "../apps/server/src/shellService";
import { CANVAS_FIXTURE_NAMES, SEED_MARKER_FILE, seedCanvasFixtures } from "./seed-canvas-fixtures";

const directories: Array<string> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-seed-canvas-"));
  directories.push(directory);
  return directory;
}

function inspect<A>(
  dataDirectory: string,
  read: (persistence: PersistenceService) => A,
): Promise<A> {
  return Effect.runPromise(
    Effect.flatMap(Persistence, (persistence) => Effect.sync(() => read(persistence))).pipe(
      Effect.provide(makePersistenceLive({ environment: { OCTANT_DATA_DIR: dataDirectory } })),
    ),
  );
}

describe("seeding Canvas fixtures", () => {
  it("leaves each fixture as a thread with a settled turn and the Canvas it wrote", async () => {
    const dataDirectory = join(scratch(), "data");
    const outcome = await seedCanvasFixtures({ dataDirectory });
    if (outcome.status !== "seeded")
      throw new Error(`Expected a seeded directory: ${outcome.message}`);
    expect(outcome.threads.map((thread) => thread.fixture)).toEqual([...CANVAS_FIXTURE_NAMES]);

    const reopened = await inspect(dataDirectory, (persistence) =>
      outcome.threads.map((seeded) => {
        const view = persistence.readChatThreadView(decodeChatThreadId(seeded.threadId));
        const canvases = persistence.canvasProjection.byThread({
          mode: "chat",
          threadId: seeded.threadId,
          projectId: decodeProjectId(outcome.projectId),
        });
        return {
          fixture: seeded.fixture,
          turnOpenedAt: view?.turns[0]?.createdAt,
          outcomes: view?.turns.flatMap((turn) => turn.attempts.map((attempt) => attempt.outcome)),
          reply: view?.contents.find((content) => content.role === "assistant")?.body,
          canvasCount: canvases.length,
          canvasId:
            canvases[0] === undefined ? undefined : String(canvases[0].currentVersion.canvasId),
          canvasCreatedAt: canvases[0]?.versions[0]?.createdAt,
          presentation: canvases[0]?.currentVersion.definition.presentation,
        };
      }),
    );

    for (const [index, seeded] of outcome.threads.entries()) {
      const read = reopened[index];
      expect(read).toMatchObject({
        outcomes: ["completed"],
        canvasCount: 1,
        canvasId: seeded.canvasId,
      });
      expect(read?.reply).toBeTruthy();
      // The thread places a Canvas after the turn opened at or before its first version.
      expect(Date.parse(String(read?.canvasCreatedAt))).toBeGreaterThanOrEqual(
        Date.parse(String(read?.turnOpenedAt)),
      );
    }
    expect(reopened.map((read) => read.presentation)).toEqual([
      "inline",
      "inline",
      "sidebar",
      "sidebar",
      "sidebar",
      "sidebar",
    ]);

    const again = await seedCanvasFixtures({ dataDirectory, fixtures: ["document"] });
    expect(again).toMatchObject({ status: "seeded", threads: [], alreadySeeded: ["document"] });
  }, 60_000);

  it("finishes a fixture on its existing thread when an earlier run stopped before the Canvas", async () => {
    const dataDirectory = join(scratch(), "data");
    vi.spyOn(CanvasService.prototype, "create").mockImplementationOnce(() => {
      throw new Error("Stopped before the Canvas was written.");
    });
    await expect(seedCanvasFixtures({ dataDirectory, fixtures: ["document"] })).rejects.toThrow();

    const outcome = await seedCanvasFixtures({ dataDirectory, fixtures: ["document"] });
    if (outcome.status !== "seeded")
      throw new Error(`Expected a seeded directory: ${outcome.message}`);
    const threads = await inspect(dataDirectory, (persistence) =>
      persistence.readChatThreads().map((thread) => ({
        id: String(thread.id),
        turns: persistence.readChatThreadView(thread.id)?.turns.length,
      })),
    );
    expect(threads).toEqual([{ id: outcome.threads[0]?.threadId, turns: 1 }]);
  }, 60_000);

  it("seeds a directory whose Chat settings already exist without a default provider", async () => {
    const dataDirectory = scratch();
    chmodSync(dataDirectory, 0o700);
    writeFileSync(
      join(dataDirectory, SEED_MARKER_FILE),
      `${JSON.stringify({ kind: "octant-canvas-fixtures" })}\n`,
    );
    const now = new Date(Date.now() - 60_000).toISOString();
    await inspect(dataDirectory, (persistence) =>
      persistence.journal.append({
        aggregate: { aggregateType: "chat-settings", aggregateId: CHAT_SETTINGS_AGGREGATE_ID },
        expectedVersion: 0,
        events: [
          {
            eventId: crypto.randomUUID(),
            eventName: "chat.settings-updated@1",
            eventVersion: 1,
            correlationId: crypto.randomUUID(),
            actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
            occurredAt: now,
            payload: {
              kind: "settings-updated",
              settings: {
                defaultResearchEnabled: true,
                defaultResearchRouting: "automatic",
                defaultPersonalityInstructions: "Keep it short.",
                version: 1,
                updatedAt: now,
              },
            },
          },
        ],
      }),
    );

    await expect(
      seedCanvasFixtures({ dataDirectory, fixtures: ["document"] }),
    ).resolves.toMatchObject({ status: "seeded" });
    const settings = await inspect(dataDirectory, (persistence) => persistence.readChatSettings());
    expect(settings).toMatchObject({
      aggregateVersion: 2,
      settings: { defaultResearchEnabled: false, defaultPersonalityInstructions: "Keep it short." },
    });
  }, 60_000);

  it("seeds an existing empty scratch directory that was created with open permissions", async () => {
    const dataDirectory = scratch();
    chmodSync(dataDirectory, 0o755);

    await expect(
      seedCanvasFixtures({ dataDirectory, fixtures: ["document"] }),
    ).resolves.toMatchObject({ status: "seeded" });
  }, 60_000);

  it("refuses a directory it did not make, a real data directory, and a relative path without touching them", async () => {
    const root = scratch();
    const foreign = join(root, "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "notes.txt"), "not an Octant seed");
    const real = join(root, "real");
    mkdirSync(real);

    await expect(seedCanvasFixtures({ dataDirectory: foreign })).resolves.toMatchObject({
      status: "refused",
      reason: "unrecognised-data-directory",
    });
    await expect(
      seedCanvasFixtures({ dataDirectory: real, protectedDirectories: [real] }),
    ).resolves.toMatchObject({ status: "refused", reason: "protected-data-directory" });
    await expect(
      seedCanvasFixtures({ dataDirectory: join(real, "nested"), protectedDirectories: [real] }),
    ).resolves.toMatchObject({ status: "refused", reason: "protected-data-directory" });
    await expect(seedCanvasFixtures({ dataDirectory: "relative/path" })).resolves.toMatchObject({
      status: "refused",
      reason: "relative-data-directory",
    });

    expect(readdirSync(foreign)).toEqual(["notes.txt"]);
    expect(readdirSync(real)).toEqual([]);
  });
});
