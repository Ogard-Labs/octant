import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makePersistenceLive, Persistence } from "./persistence/persistenceService";
import type { PersistenceService } from "./persistence/persistenceService";
import { ProjectService, ProjectServiceError } from "./projectService";

/**
 * The per-Project default for new Code threads is a journaled Project
 * setting, not a local view preference. These tests pin that it survives a
 * persistence restart — which is what "every window sees the same habit" means
 * once the journal is replayed.
 */

const now = "2026-08-14T08:00:00.000Z";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000001");
const codeId = decodeProjectId("00000000-0000-4000-8000-000000000931");
const receiptId = `${"A".repeat(42)}A` as never;

function service(persistence: PersistenceService): ProjectService {
  let value = 900;
  return new ProjectService({
    persistence,
    bindingReceiptStore: { consume: () => ({ canonicalRoot: "/repo" }) } as never,
    projectRootPort: { validate: async (_type, path) => ({ canonicalRoot: path }) },
    uuid: () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`,
    clock: () => now,
  });
}

async function withPersistence<T>(
  directory: string,
  run: (persistence: PersistenceService) => Promise<T>,
): Promise<T> {
  return await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        return yield* Effect.promise(() => run(persistence));
      }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now }))),
    ),
  );
}

describe("Code Project new-thread workspace default", () => {
  it("journals the habit and replays it after a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-project-workspace-"));
    try {
      const changed = await withPersistence(directory, async (persistence) => {
        const projects = service(persistence);
        await projects.executeProject(windowId, {
          kind: "create-code-project",
          projectId: codeId,
          expectedVersion: 0,
          name: "Octant",
          receiptId,
          hostId: "local" as never,
        });
        return await projects.executeProject(windowId, {
          kind: "change-code-project-new-thread-workspace",
          projectId: codeId,
          expectedVersion: 1 as never,
          newThreadWorkspace: "managed-worktree",
        });
      });
      expect(changed).toMatchObject({
        kind: "code-project-new-thread-workspace-changed",
        project: { id: codeId, newThreadWorkspace: "managed-worktree" },
      });

      const restored = await withPersistence(directory, async (persistence) =>
        service(persistence).bootstrap(windowId),
      );
      expect(restored.active).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: codeId, newThreadWorkspace: "managed-worktree" }),
        ]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves a Project with no chosen habit absent rather than guessing one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-project-workspace-default-"));
    try {
      const bootstrap = await withPersistence(directory, async (persistence) => {
        const projects = service(persistence);
        await projects.executeProject(windowId, {
          kind: "create-code-project",
          projectId: codeId,
          expectedVersion: 0,
          name: "Octant",
          receiptId,
          hostId: "local" as never,
        });
        return await projects.bootstrap(windowId);
      });
      const project = bootstrap.active.find((candidate) => candidate.id === codeId);
      expect(project).toBeDefined();
      expect(
        project && "newThreadWorkspace" in project ? project.newThreadWorkspace : undefined,
      ).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a no-op change", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-project-workspace-noop-"));
    try {
      await withPersistence(directory, async (persistence) => {
        const projects = service(persistence);
        await projects.executeProject(windowId, {
          kind: "create-code-project",
          projectId: codeId,
          expectedVersion: 0,
          name: "Octant",
          receiptId,
          hostId: "local" as never,
        });
        await expect(
          projects.executeProject(windowId, {
            kind: "change-code-project-new-thread-workspace",
            projectId: codeId,
            expectedVersion: 1 as never,
            newThreadWorkspace: "current-checkout",
          }),
        ).rejects.toBeInstanceOf(ProjectServiceError);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
