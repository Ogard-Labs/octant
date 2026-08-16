import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCreateRootlessThreadCommand,
  decodeFolderAttachmentId,
  decodeProjectId,
  decodeRootlessThreadId,
  decodeWindowId,
} from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { catchUpProjection, rebuildProjection } from "./persistence/projection";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite } from "./persistence/sqlitePort";
import { readRootlessThread, readRootlessThreadList } from "./persistence/rootlessProjection";
import { readDiagnosticsFailureIncident } from "./persistence/diagnosticsExportProjection";
import { RootlessThreadService } from "./rootlessThreadService";

const directories: string[] = [];
const now = "2026-07-28T10:00:00.000Z";
const ids = {
  project: decodeProjectId("00000000-0000-4000-8000-000000000702"),
  thread: decodeRootlessThreadId("00000000-0000-4000-8000-000000000710"),
  attachment: decodeFolderAttachmentId("00000000-0000-4000-8000-000000000711"),
  window: decodeWindowId("00000000-0000-4000-8000-000000000701"),
} as const;

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("RootlessThreadService", () => {
  it("records the real typed provider failure against the failed turn correlation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-diagnostics-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const service = new RootlessThreadService({
      persistence: { connection, readProviderInstance: () => ({ enabled: true }) } as never,
      journal,
      bindingReceiptStore: { consume: () => ({ canonicalRoot: "/tmp/docs" }) },
      uuid: (() => {
        let suffix = 880;
        return () => `00000000-0000-4000-8000-${String(suffix++).padStart(12, "0")}`;
      })(),
      clock: () => now,
      hostConnected: () => true,
      hasActiveTurn: () => false,
      resolveProviderDriver: () => ({ kind: "opencode" }),
      turnRuntime: {
        run: async () => ({
          kind: "failed" as const,
          failure: {
            category: "failed" as const,
            code: "provider-failed" as never,
            message: "The provider rejected the turn.",
          },
        }),
      },
    } as never);
    const command = {
      kind: "start-rootless-thread-turn",
      requestId: "00000000-0000-4000-8000-000000000880",
      threadId: "00000000-0000-4000-8000-000000000881",
      turnId: "00000000-0000-4000-8000-000000000882",
      title: "Provider failure",
      prompt: "Draft a launch brief",
      context: {
        hostId: "local",
        mode: "work",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    };

    await service.startFirstTurn(ids.window, command);
    await vi.waitFor(() =>
      expect(readRootlessThread(connection, command.threadId as never)?.initialTurn?.status).toBe(
        "failed",
      ),
    );
    expect(readDiagnosticsFailureIncident(connection, command.requestId)).toEqual({
      correlationId: command.requestId,
      domain: "provider",
      failureCode: "provider-failed",
      outcome: "failed",
      observedAt: now,
    });
    connection.close();
  });

  it("atomically retains the first prompt and returns an accepted lookup receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-first-turn-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const service = new RootlessThreadService({
      persistence: {
        connection,
        readProviderInstance: () => ({ enabled: true }),
      } as never,
      journal,
      bindingReceiptStore: { consume: () => ({ canonicalRoot: "/tmp/docs" }) },
      uuid: (() => {
        let suffix = 900;
        return () => `00000000-0000-4000-8000-${String(suffix++).padStart(12, "0")}`;
      })(),
      clock: () => now,
      hostConnected: () => true,
      hasActiveTurn: () => false,
      resolveProviderDriver: () => ({ kind: "opencode" }),
      turnRuntime: {
        run: async () => ({ kind: "completed", response: "Launch brief" }),
      },
    } as never);
    const startFirstTurn = (
      service as RootlessThreadService & {
        startFirstTurn?: (windowId: typeof ids.window, command: unknown) => Promise<unknown>;
      }
    ).startFirstTurn;

    expect(typeof startFirstTurn).toBe("function");
    const command = {
      kind: "start-rootless-thread-turn",
      requestId: "00000000-0000-4000-8000-000000000720",
      threadId: ids.thread,
      turnId: "00000000-0000-4000-8000-000000000721",
      title: "Unfiled brief",
      prompt: "Draft a launch brief",
      context: {
        hostId: "local",
        mode: "work",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    };
    await expect(startFirstTurn!.call(service, ids.window, command)).resolves.toMatchObject({
      kind: "accepted",
      turn: { prompt: "Draft a launch brief", status: "accepted" },
    });

    const events = connection
      .prepare(
        `SELECT event_id, event_name, correlation_id, causation_id, payload_json
         FROM event_journal ORDER BY global_sequence ASC`,
      )
      .all() as ReadonlyArray<{
      event_id: string;
      event_name: string;
      correlation_id: string;
      causation_id: string | null;
      payload_json: string;
    }>;
    expect(events.slice(0, 2).map((event) => event.event_name)).toEqual([
      "rootless.thread-created@1",
      "rootless.turn-accepted@1",
    ]);
    expect(events[0]?.correlation_id).toBe(command.requestId);
    expect(events[1]?.correlation_id).toBe(command.requestId);
    expect(events[1]?.causation_id).toBeTruthy();
    expect(JSON.parse(events[1]!.payload_json)).toMatchObject({ prompt: command.prompt });
    expect(events.slice(2).every((event) => event.causation_id === events[1]!.event_id)).toBe(true);
    connection.close();
  });

  it("rejects reuse of a request identity with substituted provider context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-duplicate-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const service = new RootlessThreadService({
      persistence: {
        connection,
        readProviderInstance: () => ({ enabled: true }),
      } as never,
      journal,
      bindingReceiptStore: { consume: () => ({ canonicalRoot: "/tmp/docs" }) },
      uuid: (() => {
        let suffix = 950;
        return () => `00000000-0000-4000-8000-${String(suffix++).padStart(12, "0")}`;
      })(),
      clock: () => now,
      hostConnected: () => true,
      hasActiveTurn: () => false,
      resolveProviderDriver: () => ({ kind: "opencode" }),
      turnRuntime: { run: async () => ({ kind: "completed", response: "Done" }) },
    } as never);
    const command = {
      kind: "start-rootless-thread-turn",
      requestId: "00000000-0000-4000-8000-000000000740",
      threadId: "00000000-0000-4000-8000-000000000741",
      turnId: "00000000-0000-4000-8000-000000000742",
      title: "Unfiled brief",
      prompt: "Draft a launch brief",
      context: {
        hostId: "local",
        mode: "work",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    };
    await service.startFirstTurn(ids.window, command);

    await expect(
      service.startFirstTurn(ids.window, {
        ...command,
        context: {
          ...command.context,
          providerInstanceId: "00000000-0000-4000-8000-000000000704",
        },
      }),
    ).rejects.toMatchObject({ category: "conflict" });
    connection.close();
  });

  it("allows only one concurrent first-turn start for a persisted request identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-race-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const run = vi.fn(
      async (input: { readonly signal: AbortSignal }) =>
        await new Promise<{ readonly kind: "cancelled" }>((resolve) => {
          if (input.signal.aborted) resolve({ kind: "cancelled" });
          else
            input.signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), {
              once: true,
            });
        }),
    );
    const service = new RootlessThreadService({
      persistence: {
        connection,
        readProviderInstance: () => ({ enabled: true }),
      } as never,
      journal,
      bindingReceiptStore: { consume: () => ({ canonicalRoot: "/tmp/docs" }) },
      uuid: (() => {
        let suffix = 1_100;
        return () => `00000000-0000-4000-8000-${String(suffix++).padStart(12, "0")}`;
      })(),
      clock: () => now,
      hostConnected: () => true,
      hasActiveTurn: () => false,
      resolveProviderDriver: () => ({ kind: "opencode" }),
      turnRuntime: { run },
    } as never);
    const first = {
      kind: "start-rootless-thread-turn",
      requestId: "00000000-0000-4000-8000-000000000750",
      threadId: "00000000-0000-4000-8000-000000000751",
      turnId: "00000000-0000-4000-8000-000000000752",
      title: "First",
      prompt: "First prompt",
      context: {
        hostId: "local",
        mode: "work",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    };
    const second = {
      ...first,
      threadId: "00000000-0000-4000-8000-000000000753",
      turnId: "00000000-0000-4000-8000-000000000754",
      title: "Second",
      prompt: "Substituted prompt",
    };

    const results = await Promise.allSettled([
      Promise.resolve().then(() => service.startFirstTurn(ids.window, first)),
      Promise.resolve().then(() => service.startFirstTurn(ids.window, second)),
    ]);
    const accepted = results.find((result) => result.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");
    expect(accepted).toBeDefined();
    expect(rejected?.reason).toMatchObject({
      category: "conflict",
      conflictReason: "request-reused",
    });
    if (accepted?.status !== "fulfilled") throw new Error("one start must win");
    const receipt = accepted!.value;
    const winningCommand = results[0]?.status === "fulfilled" ? first : second;
    const duplicateReceipt = await service.startFirstTurn(ids.window, winningCommand);
    expect(duplicateReceipt).toMatchObject({
      kind: "accepted",
      turn: {
        requestId: winningCommand.requestId,
        threadId: winningCommand.threadId,
        turnId: winningCommand.turnId,
        providerSessionId:
          receipt !== null && typeof receipt === "object" && "turn" in receipt
            ? (receipt.turn as { readonly providerSessionId: string }).providerSessionId
            : undefined,
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      connection.prepare("SELECT count(*) AS count FROM rootless_turn_request_projection").get(),
    ).toEqual({ count: 1 });
    const winningTurn = winningCommand.turnId;
    await service.cancelFirstTurn({
      kind: "cancel-rootless-turn",
      requestId: winningCommand.requestId,
      threadId: winningCommand.threadId,
      turnId: winningTurn,
    });
    connection.close();
  });

  it("rejects a model missing from the current non-invalidated provider catalog", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-model-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const service = new RootlessThreadService({
      persistence: {
        connection,
        readProviderInstance: () => ({ enabled: true }),
        readProviderCatalog: () => ({
          invalidated: false,
          models: [{ id: "model-b" }],
        }),
      } as never,
      journal,
      bindingReceiptStore: { consume: () => ({ canonicalRoot: "/tmp/docs" }) },
      uuid: (() => {
        let suffix = 1_200;
        return () => `00000000-0000-4000-8000-${String(suffix++).padStart(12, "0")}`;
      })(),
      clock: () => now,
      hostConnected: () => true,
      hasActiveTurn: () => false,
      resolveProviderDriver: () => ({ kind: "opencode" }),
      turnRuntime: { run: vi.fn() },
    } as never);

    await expect(
      service.startFirstTurn(ids.window, {
        kind: "start-rootless-thread-turn",
        requestId: "00000000-0000-4000-8000-000000000760",
        threadId: "00000000-0000-4000-8000-000000000761",
        turnId: "00000000-0000-4000-8000-000000000762",
        title: "Missing model",
        prompt: "Draft a launch brief",
        context: {
          hostId: "local",
          mode: "work",
          providerInstanceId: "00000000-0000-4000-8000-000000000703",
          modelId: "model-a",
          workspace: { kind: "rootless" },
        },
      }),
    ).rejects.toMatchObject({ category: "unavailable" });
    expect(connection.prepare("SELECT count(*) AS count FROM event_journal").get()).toEqual({
      count: 0,
    });
    connection.close();
  });

  it.each([
    ["completed", { kind: "completed", response: "Done" }, "completed", false],
    ["cancelled", { kind: "cancelled" }, "cancelled", false],
    [
      "waiting",
      {
        kind: "waiting",
        failure: { category: "interrupted", message: "Provider is waiting." },
      },
      "waiting",
      false,
    ],
    [
      "failed",
      {
        kind: "failed",
        failure: { category: "failed", message: "Provider failed." },
      },
      "failed",
      false,
    ],
    [
      "failed after a concurrent completed terminal",
      {
        kind: "failed",
        failure: { category: "failed", message: "Provider failed late." },
      },
      "completed",
      true,
    ],
  ] as const)(
    "retries concurrent aggregate advances before running and %s turn updates",
    async (caseName, outcome, expectedStatus, competingTerminal) => {
      const directory = mkdtempSync(join(tmpdir(), `octant-rootless-cas-${caseName}-`));
      directories.push(directory);
      const connection = openSqlite(join(directory, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => now);
      const runtime = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: runtime.events,
        projections: runtime.projections,
        clock: () => now,
      });
      let eventSuffix = 1_300;
      const nextId = () => `00000000-0000-4000-8000-${String(eventSuffix++).padStart(12, "0")}`;
      const interfered = new Set<string>();
      const racingJournal = {
        append: (input: {
          readonly aggregate: { readonly aggregateType: string; readonly aggregateId: string };
          readonly expectedVersion: number;
          readonly events: ReadonlyArray<{
            readonly payload?: {
              readonly kind?: string;
              readonly status?: string;
              readonly threadId?: string;
              readonly requestId?: string;
              readonly turnId?: string;
            };
          }>;
        }) => {
          const update = input.events[0]?.payload;
          if (
            update?.kind === "turn-updated" &&
            update.status !== undefined &&
            update.threadId !== undefined &&
            !interfered.has(update.status)
          ) {
            interfered.add(update.status);
            journal.append({
              aggregate: input.aggregate,
              expectedVersion: input.expectedVersion,
              events: [
                competingTerminal &&
                update.status === "failed" &&
                update.requestId !== undefined &&
                update.turnId !== undefined
                  ? {
                      eventId: nextId(),
                      eventName: "rootless.turn-updated@1",
                      eventVersion: 1,
                      correlationId: update.requestId,
                      actor: { kind: "system", actorId: nextId() },
                      occurredAt: now,
                      payload: {
                        kind: "turn-updated",
                        requestId: update.requestId,
                        threadId: update.threadId,
                        turnId: update.turnId,
                        status: "completed",
                        response: "Concurrent terminal won.",
                        updatedAt: now,
                      },
                    }
                  : {
                      eventId: nextId(),
                      eventName: "rootless.folder-attachment-denied@1",
                      eventVersion: 1,
                      correlationId: nextId(),
                      actor: { kind: "system", actorId: nextId() },
                      occurredAt: now,
                      payload: {
                        kind: "folder-attachment-denied",
                        attachmentId: nextId(),
                        threadId: update.threadId,
                        reason: "concurrent-turn",
                        message: "Concurrent audited denial.",
                        deniedAt: now,
                      },
                    },
              ],
            });
          }
          return journal.append(input);
        },
      };
      const command = {
        kind: "start-rootless-thread-turn",
        requestId: nextId(),
        threadId: nextId(),
        turnId: nextId(),
        title: "CAS retry",
        prompt: "Finish despite concurrent audit",
        context: {
          hostId: "local",
          mode: "work",
          providerInstanceId: "00000000-0000-4000-8000-000000000703",
          modelId: "model-a",
          workspace: { kind: "rootless" },
        },
      };
      const service = new RootlessThreadService({
        persistence: {
          connection,
          readProviderInstance: () => ({ enabled: true }),
        } as never,
        journal: racingJournal as never,
        bindingReceiptStore: { consume: () => ({ canonicalRoot: "/tmp/docs" }) },
        uuid: nextId,
        clock: () => now,
        hostConnected: () => true,
        hasActiveTurn: () => false,
        resolveProviderDriver: () => ({ kind: "opencode" }),
        turnRuntime: { run: async () => outcome },
      } as never);

      await service.startFirstTurn(ids.window, command);
      await vi.waitFor(() =>
        expect(readRootlessThread(connection, command.threadId as never)?.initialTurn?.status).toBe(
          expectedStatus,
        ),
      );
      const list = readRootlessThreadList(connection);
      expect(list.all[0]?.initialTurn).toMatchObject({
        prompt: command.prompt,
        status: expectedStatus,
      });
      expect(list.recents[0]?.initialTurn).toBeUndefined();
      expect(list.unfiled[0]?.initialTurn).toBeUndefined();
      expect(interfered).toEqual(
        new Set(["running", outcome.kind === "completed" ? "completed" : outcome.kind]),
      );
      connection.close();
    },
  );

  it("deduplicates an accepted request and cancels its active provider turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-cancel-service-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const run = vi.fn(
      async (input: { readonly signal: AbortSignal }) =>
        await new Promise<{ readonly kind: "cancelled" }>((resolve) => {
          if (input.signal.aborted) resolve({ kind: "cancelled" });
          else
            input.signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), {
              once: true,
            });
        }),
    );
    const service = new RootlessThreadService({
      persistence: {
        connection,
        readProviderInstance: () => ({ enabled: true }),
      } as never,
      journal,
      bindingReceiptStore: { consume: () => ({ canonicalRoot: "/tmp/docs" }) },
      uuid: (() => {
        let suffix = 980;
        return () => `00000000-0000-4000-8000-${String(suffix++).padStart(12, "0")}`;
      })(),
      clock: () => now,
      hostConnected: () => true,
      hasActiveTurn: () => false,
      resolveProviderDriver: () => ({ kind: "opencode" }),
      turnRuntime: { run },
    } as never);
    const command = {
      kind: "start-rootless-thread-turn",
      requestId: "00000000-0000-4000-8000-000000000790",
      threadId: "00000000-0000-4000-8000-000000000791",
      turnId: "00000000-0000-4000-8000-000000000792",
      title: "Unfiled brief",
      prompt: "Draft a launch brief",
      context: {
        hostId: "local",
        mode: "code",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    };

    await service.startFirstTurn(ids.window, command);
    await service.startFirstTurn(ids.window, command);
    expect(run).toHaveBeenCalledTimes(1);
    await expect(
      service.cancelFirstTurn({
        kind: "cancel-rootless-turn",
        requestId: command.requestId,
        threadId: command.threadId,
        turnId: command.turnId,
      }),
    ).resolves.toMatchObject({ kind: "turn-cancelled", status: "cancelled" });
    expect(service.lookupFirstTurn(command.requestId)).toMatchObject({
      kind: "accepted",
      turn: { status: "cancelled", prompt: command.prompt },
    });
    connection.close();
  });

  it("reconciles an accepted in-flight turn to an ambiguous lookup after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-reconcile-"));
    directories.push(directory);
    const databasePath = join(directory, "octant.sqlite3");
    const firstConnection = openSqlite(databasePath);
    applyMigrations(firstConnection, MIGRATIONS, () => now);
    const firstRuntime = createPhase1RuntimeRegistries();
    const firstJournal = new Journal({
      connection: firstConnection,
      registry: firstRuntime.events,
      projections: firstRuntime.projections,
      clock: () => now,
    });
    const first = new RootlessThreadService({
      persistence: {
        connection: firstConnection,
        readProviderInstance: () => ({ enabled: true }),
      } as never,
      journal: firstJournal,
      bindingReceiptStore: { consume: () => ({ canonicalRoot: "/tmp/docs" }) },
      uuid: (() => {
        let suffix = 1_010;
        return () => `00000000-0000-4000-8000-${String(suffix++).padStart(12, "0")}`;
      })(),
      clock: () => now,
      hostConnected: () => true,
      hasActiveTurn: () => false,
      resolveProviderDriver: () => ({ kind: "opencode" }),
      turnRuntime: { run: async () => await new Promise(() => undefined) },
    } as never);
    const command = {
      kind: "start-rootless-thread-turn",
      requestId: "00000000-0000-4000-8000-000000000810",
      threadId: "00000000-0000-4000-8000-000000000811",
      turnId: "00000000-0000-4000-8000-000000000812",
      title: "Unfiled brief",
      prompt: "Draft a launch brief",
      context: {
        hostId: "local",
        mode: "work",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    };
    await first.startFirstTurn(ids.window, command);
    firstConnection.close();

    const reopened = openSqlite(databasePath);
    applyMigrations(reopened, MIGRATIONS, () => now);
    const restartedRuntime = createPhase1RuntimeRegistries();
    const restartedJournal = new Journal({
      connection: reopened,
      registry: restartedRuntime.events,
      projections: restartedRuntime.projections,
      clock: () => now,
    });
    const rootlessProjection = restartedRuntime.projections.get("rootless");
    if (rootlessProjection === undefined) throw new Error("rootless projection is required");
    rebuildProjection({
      connection: reopened,
      journal: restartedJournal,
      projection: rootlessProjection,
      clock: () => now,
    });
    const restarted = new RootlessThreadService({
      persistence: { connection: reopened } as never,
      journal: restartedJournal,
      bindingReceiptStore: { consume: () => ({ canonicalRoot: "/tmp/docs" }) },
      uuid: (() => {
        let suffix = 1_020;
        return () => `00000000-0000-4000-8000-${String(suffix++).padStart(12, "0")}`;
      })(),
      clock: () => now,
      hostConnected: () => true,
      hasActiveTurn: () => false,
    });

    expect(restarted.lookupFirstTurn(command.requestId)).toMatchObject({
      kind: "ambiguous",
      prompt: command.prompt,
      message: expect.stringContaining("terminal outcome is unknown"),
    });
    reopened.close();
  });

  it("persists creation across restart and refreshes workspace capability after attachment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-rootless-service-"));
    directories.push(directory);
    const databasePath = join(directory, "octant.sqlite3");
    const project = {
      id: ids.project,
      type: "work",
      lifecycle: "active",
      binding: { canonicalRoot: "/tmp/docs" },
    };
    const provider = { enabled: true };
    const createPersistence = (connection: ReturnType<typeof openSqlite>) =>
      ({
        connection,
        readProviderInstance: () => provider,
        readProject: () => project,
        readProjects: () => [project],
      }) as never;
    const uuid = (() => {
      let suffix = 800;
      return () => `00000000-0000-4000-8000-${String(suffix++).padStart(12, "0")}`;
    })();

    const firstConnection = openSqlite(databasePath);
    applyMigrations(firstConnection, MIGRATIONS, () => now);
    const firstRuntime = createPhase1RuntimeRegistries();
    const firstJournal = new Journal({
      connection: firstConnection,
      registry: firstRuntime.events,
      projections: firstRuntime.projections,
      clock: () => now,
    });
    const first = new RootlessThreadService({
      persistence: createPersistence(firstConnection),
      journal: firstJournal,
      bindingReceiptStore: {
        consume: () => ({ canonicalRoot: "/tmp/docs" }),
      },
      uuid,
      clock: () => now,
      hostConnected: () => true,
      hasActiveTurn: () => false,
    });

    const command = decodeCreateRootlessThreadCommand({
      kind: "create-rootless-thread",
      threadId: ids.thread,
      title: "Unfiled brief",
      context: {
        hostId: "local",
        mode: "work",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    });
    await expect(first.createThread(ids.window, command)).resolves.toMatchObject({
      kind: "thread-created",
      threadId: ids.thread,
    });
    expect(readRootlessThreadList(firstConnection).unfiled).toHaveLength(1);
    firstConnection.close();

    const reopened = openSqlite(databasePath);
    applyMigrations(reopened, MIGRATIONS, () => now);
    const restartedRuntime = createPhase1RuntimeRegistries();
    const restartedJournal = new Journal({
      connection: reopened,
      registry: restartedRuntime.events,
      projections: restartedRuntime.projections,
      clock: () => now,
    });
    for (const projection of restartedRuntime.projections.all()) {
      catchUpProjection({
        connection: reopened,
        journal: restartedJournal,
        projection,
        clock: () => now,
      });
    }
    const restarted = new RootlessThreadService({
      persistence: createPersistence(reopened),
      journal: restartedJournal,
      bindingReceiptStore: {
        consume: () => ({ canonicalRoot: "/tmp/docs" }),
      },
      uuid,
      clock: () => now,
      hostConnected: () => true,
      hasActiveTurn: () => false,
    });
    expect(readRootlessThreadList(reopened).unfiled).toEqual([
      expect.objectContaining({
        threadId: ids.thread,
        title: "Unfiled brief",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
      }),
    ]);

    await expect(
      restarted.attachFolder(ids.window, {
        threadId: ids.thread,
        projectId: ids.project,
        receiptId: "receipt",
        attachmentId: ids.attachment,
      }),
    ).resolves.toMatchObject({ kind: "attached", projectId: ids.project });
    const refreshed = readRootlessThreadList(reopened);
    expect(refreshed.unfiled).toHaveLength(0);
    expect(refreshed.all[0]).toMatchObject({
      threadId: ids.thread,
      workspaceKind: "project-backed",
      projectId: ids.project,
    });
    reopened.close();
  });
});
