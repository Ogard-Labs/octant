import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeChatThreadId, decodeProjectId } from "@octant/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  Persistence,
  makePersistenceLive,
  type PersistenceService,
} from "../apps/server/src/persistence/persistenceService";
import { CANVAS_FIXTURE_NAMES, seedCanvasFixtures } from "./seed-canvas-fixtures";

const directories: Array<string> = [];

afterEach(() => {
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
    ]);

    const again = await seedCanvasFixtures({ dataDirectory, fixtures: ["document"] });
    expect(again).toMatchObject({ status: "seeded", threads: [], alreadySeeded: ["document"] });
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
