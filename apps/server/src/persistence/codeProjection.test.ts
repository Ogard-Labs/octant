import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeCheckoutId,
  decodeCodeFileId,
  decodeCodeRuntimeWorkId,
  decodeCodeThreadId,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_SETTINGS_AGGREGATE_ID,
  readCodeCheckout,
  readCodeCheckouts,
  readCodeFileReference,
  readCodeFileReferences,
  readCodeRuntimeWork,
  readCodeRuntimeWorks,
  readCodeSettings,
  readCodeThread,
  readCodeThreads,
  readCodeThreadView,
} from "./codeProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-20T22:00:00.000Z";
const ids = {
  actor: "81000000-0000-4000-8000-000000000001",
  correlation: "81000000-0000-4000-8000-000000000002",
  thread: "81000000-0000-4000-8000-000000000003",
  project: "81000000-0000-4000-8000-000000000004",
  binding: "81000000-0000-4000-8000-000000000005",
  checkout: "81000000-0000-4000-8000-000000000006",
  receipt: "81000000-0000-4000-8000-000000000007",
  provider: "81000000-0000-4000-8000-000000000008",
  file: "81000000-0000-4000-8000-000000000009",
  content: "81000000-0000-4000-8000-000000000010",
  runtime: "81000000-0000-4000-8000-000000000011",
} as const;
const repositoryId = `repo_${"a".repeat(64)}`;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("CodeProjection", () => {
  it("projects strict metadata-only Code state and exposes typed reads", () => {
    const { connection, journal } = openStore();
    try {
      appendFixture(journal);

      expect(readCodeSettings(connection)?.settings.defaultExecutionPolicy).toBe("approval-gated");
      expect(readCodeThread(connection, decodeCodeThreadId(ids.thread))?.title).toBe(
        "Persistence notes",
      );
      expect(readCodeThread(connection, decodeCodeThreadId(ids.thread))?.providerHandoff).toEqual({
        previousProviderInstanceId: ids.provider,
        previousModelId: "model-a",
        nextProviderInstanceId: ids.provider,
        nextModelId: "model-b",
        changedAt: now,
      });
      expect(readCodeThreads(connection).map(({ id }) => String(id))).toEqual([ids.thread]);
      expect(readCodeCheckout(connection, decodeCodeCheckoutId(ids.checkout))?.availability).toBe(
        "available",
      );
      expect(readCodeFileReference(connection, decodeCodeFileId(ids.file))).toMatchObject({
        id: ids.file,
        contentId: ids.content,
        digest: "c".repeat(64),
        byteLength: 12,
        state: "available",
        version: 1,
      });
      expect(readCodeFileReferences(connection, decodeCodeThreadId(ids.thread))).toHaveLength(1);
      expect(readCodeRuntimeWork(connection, decodeCodeRuntimeWorkId(ids.runtime))).toMatchObject({
        id: ids.runtime,
        state: "running",
      });
      expect(readCodeRuntimeWorks(connection, decodeCodeThreadId(ids.thread))).toHaveLength(1);
      expect(readCodeThreadView(connection, decodeCodeThreadId(ids.thread))).toMatchObject({
        thread: { id: ids.thread },
        checkout: { id: ids.checkout },
        lastSequence: 2,
      });

      const persisted = JSON.stringify({
        settings: connection.prepare("SELECT * FROM code_settings_projection").all(),
        threads: connection.prepare("SELECT * FROM code_thread_projection").all(),
        checkouts: connection.prepare("SELECT * FROM code_checkout_projection").all(),
        files: connection.prepare("SELECT * FROM code_file_projection").all(),
        runtime: connection.prepare("SELECT * FROM code_runtime_projection").all(),
      });
      expect(persisted).not.toContain("/private/");
      expect(persisted).not.toContain("private bytes");
    } finally {
      connection.close();
    }
  });

  it("rebuilds idempotently from journal sequence zero", () => {
    const { connection, journal, projection } = openStore();
    try {
      appendFixture(journal);
      const expected = projectedRows(connection);

      rebuildProjection({ connection, journal, projection, clock: () => now });
      expect(projectedRows(connection)).toEqual(expected);
      rebuildProjection({ connection, journal, projection, clock: () => now });
      expect(projectedRows(connection)).toEqual(expected);
    } finally {
      connection.close();
    }
  });

  it("F3: deletes the checkout projection on a compensating checkout-removed event", () => {
    const { connection, journal, projection } = openStore();
    try {
      appendFixture(journal);
      // The fixture appends a checkout-observed; verify it is present.
      expect(readCodeCheckout(connection, decodeCodeCheckoutId(ids.checkout))).toBeDefined();

      // Append a compensating checkout-removed.
      journal.append({
        aggregate: { aggregateType: "code-checkout", aggregateId: ids.checkout },
        expectedVersion: 1,
        events: [
          {
            eventId: "81000000-0000-4000-8000-000000000110",
            eventName: "code.checkout-removed@1",
            eventVersion: 1,
            correlationId: ids.correlation,
            actor: { kind: "system", actorId: ids.actor },
            occurredAt: now,
            payload: { kind: "checkout-removed", checkoutId: ids.checkout },
          },
        ],
      });
      rebuildProjection({ connection, journal, projection, clock: () => now });

      // The checkout is gone from the projection; replay cannot expose it.
      expect(readCodeCheckout(connection, decodeCodeCheckoutId(ids.checkout))).toBeUndefined();
      expect(readCodeCheckouts(connection)).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("projects the durable failed terminal file state at the next aggregate version", () => {
    const { connection, journal } = openStore();
    try {
      appendFixture(journal);
      const current = readCodeFileReference(connection, decodeCodeFileId(ids.file));
      if (current === undefined) throw new Error("file fixture missing");
      journal.append({
        aggregate: { aggregateType: "code-file", aggregateId: ids.file },
        expectedVersion: 1,
        events: [
          {
            eventId: "81000000-0000-4000-8000-000000000012",
            eventName: "code.file-reference-updated@1",
            eventVersion: 1,
            correlationId: ids.correlation,
            actor: { kind: "system", actorId: ids.actor },
            occurredAt: now,
            payload: {
              kind: "file-reference-updated",
              file: { ...current, state: "failed", version: 2 },
            },
          },
        ],
      });

      expect(readCodeFileReference(connection, decodeCodeFileId(ids.file))).toMatchObject({
        state: "failed",
        version: 2,
      });
    } finally {
      connection.close();
    }
  });

  it("fails closed when a persisted Code projection row has a future schema version", () => {
    const { connection, journal } = openStore();
    try {
      appendFixture(journal);
      connection
        .prepare("UPDATE code_file_projection SET schema_version = 2 WHERE file_id = ?")
        .run(ids.file);

      expect(() => readCodeFileReference(connection, decodeCodeFileId(ids.file))).toThrow(
        "unsupported Code projection schema version",
      );
    } finally {
      connection.close();
    }
  });
});

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "octant-code-projection-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const projection = runtime.projections.get("code");
  if (projection === undefined) throw new Error("Code projection must be registered");
  return {
    connection,
    projection,
    journal: new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    }),
  };
}

function appendFixture(journal: Journal): void {
  const common = {
    correlationId: ids.correlation,
    actor: { kind: "system", actorId: ids.actor },
    occurredAt: now,
  } as const;
  const thread = {
    id: ids.thread,
    projectId: ids.project,
    bindingRevisionId: ids.binding,
    repositoryId,
    checkoutId: ids.checkout,
    title: "Persistence notes",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/phase-7-authority-foundation",
      remoteName: "origin",
      proposedBaseRepository: "octocat/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as const;
  const checkout = {
    id: ids.checkout,
    repositoryId,
    kind: "managed-worktree",
    availability: "available",
    head: { kind: "branch", name: "feature/phase-7", oid: "b".repeat(40) },
    ownershipReceiptId: ids.receipt,
    observedAt: now,
  } as const;

  for (const input of [
    {
      aggregate: { aggregateType: "code-settings", aggregateId: CODE_SETTINGS_AGGREGATE_ID },
      eventId: "81000000-0000-4000-8000-000000000101",
      eventName: "code.settings-updated@1",
      payload: {
        kind: "settings-updated",
        settings: {
          defaultExecutionPolicy: "approval-gated",
          defaultPermissionPersistence: "current-session",
          version: 1,
          updatedAt: now,
        },
      },
    },
    {
      aggregate: { aggregateType: "code-thread", aggregateId: ids.thread },
      eventId: "81000000-0000-4000-8000-000000000102",
      eventName: "code.thread-created@1",
      payload: { kind: "thread-created", thread },
    },
    {
      aggregate: { aggregateType: "code-thread", aggregateId: ids.thread },
      eventId: "81000000-0000-4000-8000-000000000103",
      eventName: "code.thread-updated@1",
      payload: {
        kind: "thread-updated",
        thread: {
          ...thread,
          providerHandoff: {
            previousProviderInstanceId: ids.provider,
            previousModelId: "model-a",
            nextProviderInstanceId: ids.provider,
            nextModelId: "model-b",
            changedAt: now,
          },
          version: 2,
        },
      },
    },
    {
      aggregate: { aggregateType: "code-checkout", aggregateId: ids.checkout },
      eventId: "81000000-0000-4000-8000-000000000104",
      eventName: "code.checkout-observed@1",
      payload: { kind: "checkout-observed", checkout },
    },
    {
      aggregate: { aggregateType: "code-file", aggregateId: ids.file },
      eventId: "81000000-0000-4000-8000-000000000105",
      eventName: "code.file-reference-updated@1",
      payload: {
        kind: "file-reference-updated",
        file: {
          id: ids.file,
          threadId: ids.thread,
          checkoutId: ids.checkout,
          contentId: ids.content,
          digest: "c".repeat(64),
          byteLength: 12,
          state: "available",
          version: 1,
          updatedAt: now,
        },
      },
    },
    {
      aggregate: { aggregateType: "code-runtime", aggregateId: ids.runtime },
      eventId: "81000000-0000-4000-8000-000000000106",
      eventName: "code.runtime-work-updated@1",
      payload: {
        kind: "runtime-work-updated",
        work: {
          id: ids.runtime,
          threadId: ids.thread,
          kind: "provider-turn",
          state: "running",
          updatedAt: now,
        },
      },
    },
  ] as const) {
    const actualVersion = input.eventName === "code.thread-updated@1" ? 1 : 0;
    journal.append({
      aggregate: input.aggregate,
      expectedVersion: actualVersion,
      events: [
        {
          ...common,
          eventId: input.eventId,
          eventName: input.eventName,
          eventVersion: 1,
          payload: input.payload,
        },
      ],
    });
  }
}

function projectedRows(connection: ReturnType<typeof openSqlite>) {
  return {
    settings: connection.prepare("SELECT * FROM code_settings_projection").all(),
    threads: connection.prepare("SELECT * FROM code_thread_projection").all(),
    checkouts: connection.prepare("SELECT * FROM code_checkout_projection").all(),
    files: connection.prepare("SELECT * FROM code_file_projection").all(),
    runtime: connection.prepare("SELECT * FROM code_runtime_projection").all(),
  };
}
