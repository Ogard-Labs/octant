import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeMemoryEntryId,
  decodeProjectId,
  decodeWindowId,
  type ProjectBootstrap,
} from "@octant/contracts";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { BINDING_RECEIPT_TTL_MS, BindingReceiptStore } from "./bindingReceiptStore";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import {
  Persistence,
  PersistenceStartupFailed,
  makePersistenceLive,
  type PersistenceService,
} from "./persistence/persistenceService";
import { openSqlite } from "./persistence/sqlitePort";
import { ProjectService } from "./projectService";

const now = "2026-07-14T16:00:00.000Z";
const windowId = decodeWindowId("30000000-0000-4000-8000-000000000001");
const foreignWindowId = decodeWindowId("30000000-0000-4000-8000-000000000002");
const ids = {
  chat: decodeProjectId("30000000-0000-4000-8000-000000000010"),
  chatTie: decodeProjectId("30000000-0000-4000-8000-000000000015"),
  work: decodeProjectId("30000000-0000-4000-8000-000000000020"),
  code: decodeProjectId("30000000-0000-4000-8000-000000000030"),
  archived: decodeProjectId("30000000-0000-4000-8000-000000000040"),
  decision: decodeMemoryEntryId("30000000-0000-4000-8000-000000000050"),
  correctedDecision: decodeMemoryEntryId("30000000-0000-4000-8000-000000000051"),
  outcome: decodeMemoryEntryId("30000000-0000-4000-8000-000000000052"),
  transfer: decodeMemoryEntryId("30000000-0000-4000-8000-000000000053"),
} as const;

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Project restart recovery", () => {
  it("restores Projects, relinks, ordering, and memory while observing roots afresh", async () => {
    const directory = temporaryDirectory();
    const receipts = new BindingReceiptStore(deterministicBytes());
    const missingRoots = new Set<string>();
    const uuid = uuidSequence();
    const service = (persistence: PersistenceService) =>
      new ProjectService({
        persistence,
        bindingReceiptStore: receipts,
        projectRootPort: {
          validate: async (_type, path) => {
            if (missingRoots.has(path)) throw new Error("missing");
            return { canonicalRoot: path };
          },
        },
        uuid,
        clock: () => now,
        now: () => 1,
      });

    const beforeRestart = await withPersistence(directory, async (persistence) => {
      const projects = service(persistence);
      await projects.executeProject(windowId, {
        kind: "create-chat-project",
        hostId: "local",
        projectId: ids.chat,
        expectedVersion: 0,
        name: "Research",
      });
      await projects.executeProject(windowId, {
        kind: "create-chat-project",
        hostId: "local",
        projectId: ids.archived,
        expectedVersion: 0,
        name: "Archived notes",
      });
      await projects.executeProject(windowId, {
        kind: "create-chat-project",
        hostId: "local",
        projectId: ids.chatTie,
        expectedVersion: 0,
        name: "Equal-rank notes",
      });
      await projects.executeProject(windowId, {
        kind: "move-project",
        projectId: ids.chatTie,
        expectedVersion: 1,
        pinned: false,
      });

      const workReceipt = receipts.issue({
        windowId,
        projectType: "work",
        canonicalBinding: { canonicalRoot: "/roots/work" },
        now: 0,
      });
      await projects.executeProject(windowId, {
        kind: "create-work-project",
        hostId: "local",
        projectId: ids.work,
        expectedVersion: 0,
        name: "Workspace",
        receiptId: workReceipt.receiptId,
      });

      const codeReceipt = receipts.issue({
        windowId,
        projectType: "code",
        canonicalBinding: { canonicalRoot: "/roots/code" },
        now: 0,
      });
      await projects.executeProject(windowId, {
        kind: "create-code-project",
        hostId: "local",
        projectId: ids.code,
        expectedVersion: 0,
        name: "Repository",
        receiptId: codeReceipt.receiptId,
      });

      await projects.executeProject(windowId, {
        kind: "change-project-lifecycle",
        projectId: ids.archived,
        expectedVersion: 1,
        lifecycle: "archived",
      });
      await projects.executeProject(windowId, {
        kind: "change-project-lifecycle",
        projectId: ids.chat,
        expectedVersion: 1,
        lifecycle: "archived",
      });
      await projects.executeProject(windowId, {
        kind: "change-project-lifecycle",
        projectId: ids.chat,
        expectedVersion: 2,
        lifecycle: "active",
      });
      await projects.executeProject(windowId, {
        kind: "move-project",
        projectId: ids.work,
        expectedVersion: 1,
        pinned: true,
      });

      const relinkReceipt = receipts.issue({
        windowId,
        projectType: "work",
        canonicalBinding: { canonicalRoot: "/roots/work-moved" },
        now: 0,
      });
      await projects.executeProject(windowId, {
        kind: "relink-project",
        projectId: ids.work,
        expectedVersion: 2,
        receiptId: relinkReceipt.receiptId,
      });

      await projects.executeMemory({
        kind: "create-memory-entry",
        projectId: ids.chat,
        entryId: ids.decision,
        memoryKind: "decision",
        content: "Use an immutable journal.",
        expectedVersion: 0,
      });
      await projects.executeMemory({
        kind: "supersede-memory-entry",
        projectId: ids.chat,
        entryId: ids.decision,
        successorEntryId: ids.correctedDecision,
        content: "Use an immutable local journal.",
        expectedVersion: 1,
      });
      await projects.executeMemory({
        kind: "retract-memory-entry",
        projectId: ids.chat,
        entryId: ids.correctedDecision,
        reason: "Superseded by the outcome.",
        expectedVersion: 2,
      });
      await projects.executeMemory({
        kind: "create-memory-entry",
        projectId: ids.chat,
        entryId: ids.outcome,
        memoryKind: "outcome",
        content: "Restart recovery is required.",
        expectedVersion: 3,
      });
      await projects.executeMemory({
        kind: "transfer-memory-entry",
        sourceProjectId: ids.chat,
        sourceEntryId: ids.outcome,
        destinationProjectId: ids.work,
        destinationEntryId: ids.transfer,
        expectedVersion: 0,
      });

      return {
        bootstrap: await projects.bootstrap(windowId),
        work: persistence.readProject(ids.work),
      };
    });

    expect(beforeRestart.bootstrap.active.map((project) => project.id)).toEqual([
      ids.work,
      ids.chat,
      ids.chatTie,
      ids.code,
    ]);
    expect(
      beforeRestart.bootstrap.active
        .filter((project) => project.type === "chat")
        .map((project) => ({ id: project.id, rank: project.rank })),
    ).toEqual([
      { id: ids.chat, rank: "0/1" },
      { id: ids.chatTie, rank: "0/1" },
    ]);
    expect(beforeRestart.bootstrap.active.find((project) => project.id === ids.code)).toMatchObject(
      {
        codeAccessPersistence: "current-session",
      },
    );
    expect(beforeRestart.bootstrap.active.find((project) => project.id === ids.work)).toMatchObject(
      {
        binding: { canonicalRoot: "/roots/work-moved" },
        version: 3,
      },
    );
    expect(beforeRestart.work).toMatchObject({
      bindingHistory: [
        { revision: 1, currentBinding: { canonicalRoot: "/roots/work" } },
        {
          revision: 2,
          previousBinding: { canonicalRoot: "/roots/work" },
          currentBinding: { canonicalRoot: "/roots/work-moved" },
        },
      ],
    });
    expect(beforeRestart.bootstrap.archived.map((project) => project.id)).toEqual([ids.archived]);
    expect(beforeRestart.bootstrap.availability).toEqual([
      { projectId: ids.work, status: "available", observedAt: now },
      { projectId: ids.code, status: "available", observedAt: now },
    ]);

    missingRoots.add("/roots/work-moved");
    const afterRestart = await withPersistence(directory, async (persistence) => ({
      bootstrap: await service(persistence).bootstrap(windowId),
      work: persistence.readProject(ids.work),
    }));

    expect(durableState(afterRestart.bootstrap)).toEqual(durableState(beforeRestart.bootstrap));
    expect(afterRestart.work).toEqual(beforeRestart.work);
    expect(
      afterRestart.bootstrap.active
        .filter((project) => project.type === "chat")
        .map((project) => ({ id: project.id, rank: project.rank })),
    ).toEqual([
      { id: ids.chat, rank: "0/1" },
      { id: ids.chatTie, rank: "0/1" },
    ]);
    expect(afterRestart.bootstrap.availability).toEqual([
      {
        projectId: ids.work,
        status: "unavailable",
        reason: "Relink required.",
        observedAt: now,
      },
      { projectId: ids.code, status: "available", observedAt: now },
    ]);
    expect(
      afterRestart.bootstrap.memory.find((memory) => memory.projectId === ids.chat),
    ).toMatchObject({
      active: [{ id: ids.outcome, status: "active" }],
      history: [
        { id: ids.decision, status: "superseded" },
        { id: ids.correctedDecision, status: "retracted" },
      ],
    });
    expect(
      afterRestart.bootstrap.memory.find((memory) => memory.projectId === ids.work),
    ).toMatchObject({
      active: [
        {
          id: ids.transfer,
          provenance: {
            kind: "transferred",
            sourceProjectId: ids.chat,
            sourceEntryId: ids.outcome,
          },
        },
      ],
    });
  });

  it("keeps receipt expiry and window authority process-local", () => {
    const receipts = new BindingReceiptStore(deterministicBytes());
    const receipt = receipts.issue({
      windowId,
      projectType: "work",
      canonicalBinding: { canonicalRoot: "/roots/work" },
      now: 0,
    });

    expect(() =>
      receipts.consume({
        receiptId: receipt.receiptId,
        authenticatedWindowId: foreignWindowId,
        projectType: "work",
        now: 1,
      }),
    ).toThrow();
    const restartedReceipts = new BindingReceiptStore(deterministicBytes());
    expect(restartedReceipts).not.toBe(receipts);
    expect(() =>
      restartedReceipts.consume({
        receiptId: receipt.receiptId,
        authenticatedWindowId: windowId,
        projectType: "work",
        now: 1,
      }),
    ).toThrow();
    expect(() =>
      receipts.consume({
        receiptId: receipt.receiptId,
        authenticatedWindowId: windowId,
        projectType: "work",
        now: BINDING_RECEIPT_TTL_MS,
      }),
    ).toThrow();
  });

  it("quarantines an unknown event instead of starting with partial Project state", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "octant.sqlite3");
    const seeded = openSqlite(databasePath);
    applyMigrations(seeded, MIGRATIONS, () => now);
    seeded
      .prepare(`
        INSERT INTO event_journal (
          event_id, aggregate_type, aggregate_id, aggregate_version,
          event_name, event_version, correlation_id, causation_id,
          actor_kind, actor_id, occurred_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "30000000-0000-4000-8000-000000000090",
        "project",
        ids.chat,
        1,
        "project.future-event@1",
        1,
        "30000000-0000-4000-8000-000000000091",
        null,
        "system",
        "30000000-0000-4000-8000-000000000092",
        now,
        JSON.stringify({ privateFutureValue: "not-projected" }),
      );
    seeded.close();

    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.provide(
            Persistence,
            makePersistenceLive({ dataDirectory: directory, clock: () => now }),
          ),
        ),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PersistenceStartupFailed);
      expect(result.left).toMatchObject({ category: "recovery-required" });
      expect(String(result.left)).not.toContain("privateFutureValue");
    }
    const inspected = openSqlite(databasePath);
    expect(
      inspected
        .prepare("SELECT projection_name, reason FROM event_quarantine ORDER BY projection_name")
        .all(),
    ).toEqual([
      { projection_name: "agent-profiles", reason: "unknown-event-name" },
      { projection_name: "agent-runs", reason: "unknown-event-name" },
      { projection_name: "aggregate-heads", reason: "unknown-event-name" },
      { projection_name: "automations", reason: "unknown-event-name" },
      { projection_name: "canvas", reason: "unknown-event-name" },
      { projection_name: "chat", reason: "unknown-event-name" },
      { projection_name: "code", reason: "unknown-event-name" },
      { projection_name: "contexts", reason: "unknown-event-name" },
      { projection_name: "diagnostics-exports", reason: "unknown-event-name" },
      { projection_name: "extensions", reason: "unknown-event-name" },
      { projection_name: "github-clones", reason: "unknown-event-name" },
      { projection_name: "product-feedback", reason: "unknown-event-name" },
      { projection_name: "projects", reason: "unknown-event-name" },
      { projection_name: "providers", reason: "unknown-event-name" },
      { projection_name: "remote-access", reason: "unknown-event-name" },
      { projection_name: "shell", reason: "unknown-event-name" },
      { projection_name: "theme", reason: "unknown-event-name" },
      { projection_name: "thread-checkpoint", reason: "unknown-event-name" },
      { projection_name: "thread-external-content-taint", reason: "unknown-event-name" },
      { projection_name: "thread-retention", reason: "unknown-event-name" },
      { projection_name: "usage", reason: "unknown-event-name" },
      { projection_name: "validation-evidence", reason: "unknown-event-name" },
      { projection_name: "zen", reason: "unknown-event-name" },
    ]);
    inspected.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-project-restart-"));
  directories.push(directory);
  return directory;
}

async function withPersistence<T>(
  directory: string,
  use: (persistence: PersistenceService) => Promise<T>,
): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        return yield* Effect.promise(() => use(persistence));
      }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now }))),
    ),
  );
}

function durableState(bootstrap: ProjectBootstrap) {
  return {
    active: bootstrap.active,
    archived: bootstrap.archived,
    memory: bootstrap.memory,
  };
}

function deterministicBytes(): (size: number) => Uint8Array {
  let value = 1;
  return (size) => Buffer.alloc(size, value++);
}

function uuidSequence(): () => string {
  let value = 100;
  return () => `30000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}
