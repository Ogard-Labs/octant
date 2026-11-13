import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeCodeThread, type CodeThread, type Project } from "@octant/contracts";
import { createCodeRestartContinuationAttempts } from "../code/codeRestartContinuation";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { createCoordinatorCountStore } from "./coordinatorCountStore";
import { CoordinatorService, type CoordinatorServicePorts } from "./coordinatorService";
import {
  createCoordinatorWakeJournal,
  registerCoordinatorWakeEvents,
} from "./coordinatorWakeJournal";
import {
  continueCoordinatorWakesAfterRestart,
  type CoordinatorWakeRestartContinuationPorts,
} from "./coordinatorWakeRestartContinuation";

const now = "2026-11-13T12:00:00.000Z";
const PROJECT = "40000000-0000-4000-8000-000000000001";
const COORDINATOR = "20000000-0000-4000-8000-000000000001";
const SENDER = "20000000-0000-4000-8000-000000000003";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function codeThread(id: string, overrides: Record<string, unknown> = {}): CodeThread {
  return decodeCodeThread({
    id,
    projectId: PROJECT,
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "30000000-0000-4000-8000-000000000001",
    title: "Coordinator",
    lifecycle: "active",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    executionPolicy: "auto-accept-edits",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/coordinate",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function openStoreFile(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-coordinator-wakes-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

/** One host's lifetime over a store file that outlives it. */
function startHost(
  connection: SqliteConnection,
  startHostTurn: CoordinatorServicePorts["startHostTurn"],
  states: Map<string, "working" | "idle"> = new Map(),
) {
  const journal = new Journal({
    connection,
    registry: registerCoordinatorWakeEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const wakes = createCoordinatorWakeJournal({ journal, connection, clock: () => now });
  const threads = new Map([[COORDINATOR, codeThread(COORDINATOR, { messageWake: true })]]);
  const service = new CoordinatorService({
    readThread: (id) => threads.get(id),
    readThreads: () => [...threads.values()],
    readProject: () => ({ type: "code", lifecycle: "active" }) as unknown as Project,
    readSettings: () => undefined,
    isDesignatedPlanner: () => false,
    isMarked: () => false,
    threadState: (id) => states.get(id) ?? "idle",
    latestTurnId: () => undefined,
    providerKnown: () => true,
    executeCode: async () => {
      throw new Error("unexpected command");
    },
    startHostTurn,
    propose: () => ({ status: "refused", message: "unused" }),
    counts: createCoordinatorCountStore(connection),
    wakes,
    uuid: randomUUID,
    now: () => Date.parse(now),
  });
  return { service, wakes };
}

/** A message from another thread, as the journal would commit it. */
function messageTo(service: CoordinatorService): void {
  service.onCommittedEvents([
    {
      eventName: "agent.message-sent@1",
      payload: {
        kind: "message-sent",
        messageId: randomUUID(),
        correlationId: randomUUID(),
        senderThreadId: SENDER,
        recipientThreadId: COORDINATOR,
        bodyReference: { contentReference: "agent-message-body-1", byteLength: 7 },
        occurredAt: now,
      },
    } as never,
  ]);
}

/** A turn start that never answers: the host stops while it is starting. */
const neverStarts: CoordinatorServicePorts["startHostTurn"] = () => new Promise(() => undefined);

function ports(
  host: ReturnType<typeof startHost>,
  connection: SqliteConnection,
  overrides: Partial<CoordinatorWakeRestartContinuationPorts> = {},
): CoordinatorWakeRestartContinuationPorts {
  return {
    quitByPerson: false,
    open: host.wakes.open(),
    enabled: () => true,
    optedOut: () => false,
    heldByCode: new Set(),
    attempts: createCodeRestartContinuationAttempts(connection),
    coordinator: host.service,
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("coordinator wakes after a restart", () => {
  it("records a wake when it is decided and again when its turn starts", async () => {
    const connection = openStoreFile();
    const host = startHost(connection, async () => ({ status: "started", operationId: "turn-1" }));
    messageTo(host.service);
    await flush();
    expect(host.wakes.open()).toEqual([]);
  });

  it("starts a wake the previous host never started, until its own starts are cut off twice", async () => {
    const connection = openStoreFile();
    const first = startHost(connection, neverStarts);
    messageTo(first.service);
    await flush();
    expect(first.wakes.open()).toMatchObject([{ threadId: COORDINATOR, cause: "message" }]);

    // Two restarts whose own start of the wake takes the host down.
    for (const _ of [1, 2]) {
      const host = startHost(connection, neverStarts);
      void continueCoordinatorWakesAfterRestart(ports(host, connection));
      await flush();
      expect(host.wakes.open()).toHaveLength(1);
    }

    const started: string[] = [];
    const third = startHost(connection, async (_threadId, prompt) => {
      started.push(prompt);
      return { status: "started", operationId: "turn-2" };
    });
    const recovered = await continueCoordinatorWakesAfterRestart(ports(third, connection));
    expect(started).toEqual([]);
    expect(recovered.held).toMatchObject([
      { mode: "code", threadId: COORDINATOR, reason: "crash-loop" },
    ]);
    // Held is journaled, so no later start runs it by itself.
    expect(third.wakes.open()).toEqual([]);
  });

  it("starts the open wake once on the next start and closes it", async () => {
    const connection = openStoreFile();
    messageTo(startHost(connection, neverStarts).service);
    await flush();
    const started: string[] = [];
    const host = startHost(connection, async (_threadId, prompt) => {
      started.push(prompt);
      return { status: "started", operationId: "turn-2" };
    });
    const recovered = await continueCoordinatorWakesAfterRestart(ports(host, connection));
    expect(recovered.continued).toEqual([{ mode: "code", threadId: COORDINATOR }]);
    expect(started).toHaveLength(1);
    expect(started[0]).toContain(SENDER);
    expect(host.wakes.open()).toEqual([]);
  });

  it("drops an open wake rather than start it beside a turn already on the thread", async () => {
    const connection = openStoreFile();
    messageTo(startHost(connection, neverStarts).service);
    await flush();
    const started: string[] = [];
    const host = startHost(
      connection,
      async (_threadId, prompt) => {
        started.push(prompt);
        return { status: "started", operationId: "turn-2" };
      },
      new Map([[COORDINATOR, "working"]]),
    );
    const recovered = await continueCoordinatorWakesAfterRestart(ports(host, connection));
    expect(started).toEqual([]);
    expect(recovered).toEqual({ continued: [], held: [] });
    expect(host.wakes.open()).toEqual([]);
  });

  it("holds an open wake after a deliberate quit, with the setting off, or behind a held thread", async () => {
    for (const [overrides, held] of [
      [{ quitByPerson: true }, [{ reason: "quit" }]],
      [{ enabled: () => false }, [{ reason: "turned-off" }]],
      [{ optedOut: () => true }, [{ reason: "opted-out" }]],
      [{ heldByCode: new Set([COORDINATOR]) }, []],
    ] as const) {
      const connection = openStoreFile();
      messageTo(startHost(connection, neverStarts).service);
      await flush();
      const host = startHost(connection, async () => {
        throw new Error("a held wake must not start");
      });
      const recovered = await continueCoordinatorWakesAfterRestart(
        ports(host, connection, overrides),
      );
      expect(recovered.continued).toEqual([]);
      expect(recovered.held).toMatchObject(held);
      expect(host.wakes.open()).toEqual([]);
    }
  });
});
