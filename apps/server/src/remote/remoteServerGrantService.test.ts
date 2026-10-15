import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommittedAppend,
  REMOTE_SERVER_GRANT_CLOSED,
  REMOTE_SERVER_GRANT_OPENED,
  THREAD_RETENTION_EVENT_NAMES,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeEventActor,
  decodeRemoteServerGrantRequest,
  decodeThreadRetentionThreadId,
  decodeWindowId,
  type CodeThread,
  type CodeThreadId,
  type RemoteServerGrantResult,
  type RemoteServerGrantSource,
} from "@octant/contracts";
import type { RemoteServerGrantTarget } from "../localServers/localServerService";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildAll } from "../persistence/recovery";
import { readOpenRemoteServerGrants } from "../persistence/remoteServerGrantProjection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { erasePurgedThread } from "../persistence/threadPurge";
import {
  RemoteServerGrantService,
  type RemoteServerGrantOpening,
  type RemoteServerGrantPrincipal,
} from "./remoteServerGrantService";

const now = "2026-10-15T09:00:00.000Z";
const hostActorId = "33333333-3333-4333-8333-333333333333";
const deviceA = "44444444-4444-4444-8444-444444444444";
const deviceB = "55555555-5555-4555-8555-555555555555";
const scopeA = decodeWindowId(deviceA);
const threadId = decodeCodeThreadId("11111111-1111-4111-8111-111111111111");
const otherThreadId = decodeCodeThreadId("66666666-6666-4666-8666-666666666666");
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionA = "a".repeat(64);
const sessionB = "b".repeat(64);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function listenerId(index: number): string {
  return `lsn_${index.toString(16).padStart(32, "0")}`;
}

type ListedTarget = Extract<RemoteServerGrantTarget, { readonly status: "listed" }>;

function listed(
  index: number,
  overrides: Partial<Omit<ListedTarget, "threadId">> & {
    readonly threadId?: CodeThreadId | "none";
  } = {},
): RemoteServerGrantTarget {
  const { threadId: thread = threadId, ...rest } = overrides;
  return {
    status: "listed",
    ownership: "octant-owned",
    health: "listening",
    ...(thread === "none" ? {} : { threadId: thread }),
    endpoint: {
      url: `http://127.0.0.1:${5170 + index}/`,
      port: 5170 + index,
      pid: 4000 + index,
      processName: "node",
    },
    ...rest,
  };
}

function fromLocalServers(index: number, thread: CodeThreadId = threadId) {
  return decodeRemoteServerGrantRequest({
    kind: "open-remote-server-grant",
    requestId: randomUUID(),
    source: {
      surface: "local-servers",
      threadId: thread,
      projectId,
      listenerId: listenerId(index),
    },
  });
}

function fromRunningServices(index: number) {
  return decodeRemoteServerGrantRequest({
    kind: "open-remote-server-grant",
    requestId: randomUUID(),
    source: { surface: "running-services", listenerId: listenerId(index) },
  });
}

function device(deviceId = deviceA, sessionIdDigest = sessionA): RemoteServerGrantPrincipal {
  return { kind: "remote-device", deviceId, credentialGeneration: 1, sessionIdDigest };
}

interface Harness {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly grants: RemoteServerGrantService;
  readonly targets: Map<string, RemoteServerGrantTarget>;
  readonly threads: Map<string, Pick<CodeThread, "lifecycle" | "executionPolicy">>;
  readonly readable: Set<string>;
  readonly observed: RemoteServerGrantSource[];
  /** While set, observation and the thread read wait for it; `throwOnRead` makes the read fail. */
  readonly gates: { observe?: Promise<void>; canOpen?: Promise<void>; throwOnRead?: boolean };
}

function setup(
  options: { readonly perHost?: number; readonly connection?: SqliteConnection } = {},
): Harness {
  let connection = options.connection;
  if (connection === undefined) {
    const directory = mkdtempSync(join(tmpdir(), "octant-remote-server-grants-"));
    directories.push(directory);
    connection = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
  }
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const targets = new Map<string, RemoteServerGrantTarget>();
  const threads = new Map<string, Pick<CodeThread, "lifecycle" | "executionPolicy">>([
    [String(threadId), { lifecycle: "active", executionPolicy: "approval-gated" }],
    [String(otherThreadId), { lifecycle: "active", executionPolicy: "plan" }],
  ]);
  const readable = new Set<string>([String(threadId), String(otherThreadId)]);
  const observed: RemoteServerGrantSource[] = [];
  const conn = connection;
  const gates: Harness["gates"] = {};
  const grants = new RemoteServerGrantService({
    observeTarget: async (_scope, source) => {
      observed.push(source);
      if (gates.observe !== undefined) await gates.observe;
      return targets.get(String(source.listenerId)) ?? { status: "not-listed" };
    },
    canOpenThread: async (_scope, id) => {
      if (gates.canOpen !== undefined) await gates.canOpen;
      if (gates.throwOnRead === true) throw new Error("read failed");
      return readable.has(String(id));
    },
    readThread: (id) => threads.get(String(id)),
    readOpenGrants: () => readOpenRemoteServerGrants(conn),
    confirmEndpoint: async () => "held",
    isCodeEnabled: () => true,
    journal,
    hostActor: decodeEventActor({ kind: "system", actorId: hostActorId }),
    uuid: randomUUID,
    clock: () => now,
    ...(options.perHost === undefined ? {} : { limits: { perHost: options.perHost } }),
  });
  return { connection, journal, grants, targets, threads, readable, observed, gates };
}

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const decodeAppend = Schema.decodeUnknownSync(CommittedAppend);

function committed(event: {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventName: string;
  readonly payload: unknown;
}): CommittedAppend {
  return decodeAppend({
    events: [
      {
        eventId: randomUUID(),
        globalSequence: 1,
        aggregateVersion: 1,
        eventVersion: 1,
        hostId: "local",
        correlationId: randomUUID(),
        actor: { kind: "system", actorId: hostActorId },
        occurredAt: now,
        ...event,
      },
    ],
    firstSequence: 1,
    lastSequence: 1,
    aggregateVersion: 1,
  });
}

function archivedThreadEvent() {
  return committed({
    aggregateType: "code-thread",
    aggregateId: threadId,
    eventName: "code.thread-updated@1",
    payload: {
      kind: "thread-updated",
      thread: decodeCodeThread({
        id: threadId,
        projectId,
        bindingRevisionId: "99999999-9999-4999-8999-999999999991",
        repositoryId: `repo_${"a".repeat(64)}`,
        checkoutId: "99999999-9999-4999-8999-999999999993",
        title: "Login",
        lifecycle: "archived",
        providerInstanceId: "99999999-9999-4999-8999-999999999994",
        modelId: "model-a",
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget: {
          branchIntent: "feature/login",
          remoteName: "origin",
          proposedBaseRepository: "octant/octant",
          proposedBaseBranch: "main",
          outcomeKind: "opened-pr",
          confirmedAt: now,
        },
        version: 2,
        createdAt: now,
        updatedAt: now,
      }),
    },
  });
}

function resultOf(opening: RemoteServerGrantOpening): RemoteServerGrantResult {
  if (opening.kind !== "answered") throw new Error(`expected an answer, got ${opening.kind}`);
  return opening.result;
}

function refusalOf(opening: RemoteServerGrantOpening) {
  const result = resultOf(opening);
  if (result.kind !== "remote-server-grant-refused") throw new Error("expected a refusal");
  return result.refusal;
}

function grantOf(opening: RemoteServerGrantOpening) {
  const result = resultOf(opening);
  if (result.kind !== "remote-server-grant-opened") throw new Error("expected a grant");
  return result.grant;
}

function grantEvents(connection: SqliteConnection) {
  return connection
    .prepare(
      `SELECT event_name, payload_json, actor_json FROM event_journal
       WHERE aggregate_type = 'remote-server-grant' ORDER BY global_sequence`,
    )
    .all() as ReadonlyArray<{
    readonly event_name: string;
    readonly payload_json: string;
    readonly actor_json: string;
  }>;
}

describe("RemoteServerGrantService", () => {
  it("opens a grant for a listening Octant-owned server in a readable thread's own worktree", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    const grant = grantOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(1),
      }),
    );
    expect(grant.grantId).toMatch(/^rsg_[a-f0-9]{64}$/);
    expect(grant).toMatchObject({ threadId, port: 5171 });
  });

  it("refuses a local window without reading anything about the server", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    expect(
      refusalOf(
        await harness.grants.open({
          principal: { kind: "local-window" },
          scopeId: scopeA,
          request: fromLocalServers(1),
        }),
      ).reason,
    ).toBe("local-principal");
    expect(harness.observed).toEqual([]);
  });

  it("refuses a thread the device cannot read before looking at the listing", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    harness.readable.delete(String(threadId));
    expect(
      refusalOf(
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromLocalServers(1),
        }),
      ).reason,
    ).toBe("thread-unreadable");
    expect(harness.observed).toEqual([]);
  });

  it("refuses an archived thread as one the device cannot open servers in", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    harness.threads.set(String(threadId), {
      lifecycle: "archived",
      executionPolicy: "approval-gated",
    });
    expect(
      refusalOf(
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromLocalServers(1),
        }),
      ).reason,
    ).toBe("thread-unreadable");
  });

  it("refuses the thread a Running services row names when the device cannot read it", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1, { threadId: otherThreadId }));
    harness.readable.delete(String(otherThreadId));
    expect(
      refusalOf(
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromRunningServices(1),
        }),
      ).reason,
    ).toBe("thread-unreadable");
  });

  it("answers an unlisted id and a stopped server alike", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    const before = refusalOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(9),
      }),
    );
    harness.targets.delete(listenerId(1));
    const after = refusalOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(1),
      }),
    );
    expect(before).toEqual(after);
    expect(after.reason).toBe("not-found");
  });

  it.each([
    ["not-octant-owned", listed(1, { ownership: "leftover" })],
    ["not-in-thread", listed(1, { threadId: "none" })],
    ["not-listening", listed(1, { health: "unresponsive" })],
    ["not-listening", listed(1, { health: "unknown" })],
  ] as const)("refuses %s", async (reason, target) => {
    const harness = setup();
    harness.targets.set(listenerId(1), target);
    expect(
      refusalOf(
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromRunningServices(1),
        }),
      ).reason,
    ).toBe(reason);
  });

  it("decides on the thread as it stands after the host looked", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    const archiving = new RemoteServerGrantService({
      observeTarget: async () => {
        harness.threads.set(String(threadId), {
          lifecycle: "archived",
          executionPolicy: "approval-gated",
        });
        return listed(1);
      },
      canOpenThread: async () => true,
      readThread: (id) => harness.threads.get(String(id)),
      readOpenGrants: () => [],
      confirmEndpoint: async () => "held",
      isCodeEnabled: () => true,
      journal: harness.journal,
      hostActor: decodeEventActor({ kind: "system", actorId: hostActorId }),
      uuid: randomUUID,
      clock: () => now,
    });
    expect(
      refusalOf(
        await archiving.open({
          principal: device(),
          scopeId: scopeA,
          request: fromLocalServers(1),
        }),
      ).reason,
    ).toBe("thread-unreadable");
    expect(archiving.openCount()).toBe(0);
  });

  it("mints nothing for a server Octant stopped while the host was looking", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    const gate = deferred();
    harness.gates.observe = gate.promise;
    const opening = harness.grants.open({
      principal: device(),
      scopeId: scopeA,
      request: fromLocalServers(1),
    });
    await vi.waitFor(() => expect(harness.observed).toHaveLength(1));
    harness.grants.closeServer({ pid: 4001, port: 5171 });
    gate.release();
    expect((await opening).kind).toBe("unavailable");
    expect(harness.grants.openCount()).toBe(0);
    expect(grantEvents(harness.connection)).toEqual([]);
  });

  it("mints nothing for a thread archived while its readability was read", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    const gate = deferred();
    harness.gates.canOpen = gate.promise;
    const opening = harness.grants.open({
      principal: device(),
      scopeId: scopeA,
      request: fromRunningServices(1),
    });
    await vi.waitFor(() => expect(harness.observed).toHaveLength(1));
    harness.threads.set(String(threadId), { lifecycle: "archived", executionPolicy: "plan" });
    harness.grants.observeCommitted(archivedThreadEvent());
    gate.release();
    expect((await opening).kind).toBe("unavailable");
    expect(grantEvents(harness.connection)).toEqual([]);
  });

  it("refuses a thread no longer active just before minting, even with no close recorded", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    const gate = deferred();
    harness.gates.canOpen = gate.promise;
    const opening = harness.grants.open({
      principal: device(),
      scopeId: scopeA,
      request: fromRunningServices(1),
    });
    await vi.waitFor(() => expect(harness.observed).toHaveLength(1));
    // The thread was read before `canOpenThread` was asked; it changes before the answer lands.
    harness.threads.set(String(threadId), { lifecycle: "archived", executionPolicy: "plan" });
    gate.release();
    expect(refusalOf(await opening).reason).toBe("thread-unreadable");
    expect(grantEvents(harness.connection)).toEqual([]);
  });

  it("leaves no record when a thread is purged while a grant was being decided", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    const gate = deferred();
    harness.gates.canOpen = gate.promise;
    const opening = harness.grants.open({
      principal: device(),
      scopeId: scopeA,
      request: fromRunningServices(1),
    });
    await vi.waitFor(() => expect(harness.observed).toHaveLength(1));
    harness.threads.delete(String(threadId));
    harness.grants.observeCommitted(
      committed({
        aggregateType: "thread-retention",
        aggregateId: randomUUID(),
        eventName: THREAD_RETENTION_EVENT_NAMES.threadPurged,
        payload: { kind: "thread-purged", mode: "code", threadId, purgedAt: now },
      }),
    );
    erasePurgedThread({
      connection: harness.connection,
      mode: "code",
      threadId: decodeThreadRetentionThreadId(String(threadId)),
    });
    gate.release();
    expect((await opening).kind).toBe("unavailable");
    expect(grantEvents(harness.connection)).toEqual([]);
    expect(readOpenRemoteServerGrants(harness.connection)).toEqual([]);
  });

  it("closes a thread's grants from a committed archive or purge, and skips an event it cannot read", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    harness.targets.set(listenerId(2), listed(2, { threadId: otherThreadId }));
    grantOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(1),
      }),
    );
    grantOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(2, otherThreadId),
      }),
    );
    const unreadable = committed({
      aggregateType: "code-thread",
      aggregateId: threadId,
      eventName: "code.thread-updated@1",
      payload: { kind: "thread-updated", thread: { id: threadId } },
    });
    const archive = archivedThreadEvent();
    harness.grants.observeCommitted(
      decodeAppend({ ...archive, events: [...unreadable.events, ...archive.events] }),
    );
    expect(harness.grants.openCount()).toBe(1);
    harness.grants.observeCommitted(
      committed({
        aggregateType: "thread-retention",
        aggregateId: randomUUID(),
        eventName: THREAD_RETENTION_EVENT_NAMES.threadPurged,
        payload: { kind: "thread-purged", mode: "code", threadId: otherThreadId, purgedAt: now },
      }),
    );
    expect(harness.grants.openCount()).toBe(0);
    expect(
      grantEvents(harness.connection)
        .filter((event) => event.event_name === REMOTE_SERVER_GRANT_CLOSED)
        .map((event) => (JSON.parse(event.payload_json) as { reason: string }).reason),
    ).toEqual(["thread-archived", "thread-unreadable"]);
  });

  it("answers unavailable, not unreadable, when the thread read fails", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    harness.gates.throwOnRead = true;
    expect(
      (
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromLocalServers(1),
        })
      ).kind,
    ).toBe("unavailable");
  });

  it("answers unavailable, not a refusal, when the host cannot look", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), { status: "unavailable" });
    expect(
      (
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromLocalServers(1),
        })
      ).kind,
    ).toBe("unavailable");
  });

  it("mints nothing when the session ends while the request is decided", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    const opening = await harness.grants.open({
      principal: device(),
      scopeId: scopeA,
      request: fromLocalServers(1),
      stillAuthorized: () => false,
    });
    expect(opening.kind).toBe("session-ended");
    expect(harness.grants.openCount()).toBe(0);
  });

  it("returns the same grant when the same session opens the same server again", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    const first = grantOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(1),
      }),
    );
    const second = grantOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(1),
      }),
    );
    expect(second.grantId).toBe(first.grantId);
    expect(harness.grants.openCount(deviceA)).toBe(1);
  });

  it("refuses a device past its cap of eight open grants, and only that device", async () => {
    const harness = setup();
    for (let index = 1; index <= 9; index += 1)
      harness.targets.set(listenerId(index), listed(index));
    for (let index = 1; index <= 8; index += 1) {
      grantOf(
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromLocalServers(index),
        }),
      );
    }
    expect(
      refusalOf(
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromLocalServers(9),
        }),
      ).reason,
    ).toBe("grant-limit");
    grantOf(
      await harness.grants.open({
        principal: device(deviceB, sessionB),
        scopeId: decodeWindowId(deviceB),
        request: fromLocalServers(9),
      }),
    );
  });

  it("refuses past the host's cap across devices", async () => {
    const harness = setup({ perHost: 2 });
    for (let index = 1; index <= 3; index += 1)
      harness.targets.set(listenerId(index), listed(index));
    grantOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(1),
      }),
    );
    grantOf(
      await harness.grants.open({
        principal: device(deviceB, sessionB),
        scopeId: scopeA,
        request: fromLocalServers(2),
      }),
    );
    expect(
      refusalOf(
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromLocalServers(3),
        }),
      ).reason,
    ).toBe("grant-limit");
  });

  it("asks the cap last, after every rule about the server", async () => {
    const harness = setup({ perHost: 1 });
    harness.targets.set(listenerId(1), listed(1));
    harness.targets.set(listenerId(2), listed(2, { ownership: "leftover" }));
    grantOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(1),
      }),
    );
    expect(
      refusalOf(
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromLocalServers(2),
        }),
      ).reason,
    ).toBe("not-octant-owned");
  });

  it("journals an opening with the device and a closing with the host, and nothing about the endpoint", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    const grant = grantOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(1),
      }),
    );
    harness.grants.closeSession(sessionA, "proxy-session-ended");
    const events = grantEvents(harness.connection);
    expect(events.map((event) => event.event_name)).toEqual([
      REMOTE_SERVER_GRANT_OPENED,
      REMOTE_SERVER_GRANT_CLOSED,
    ]);
    expect(JSON.parse(events[0]?.payload_json ?? "")).toEqual({
      grantId: grant.grantId,
      deviceId: deviceA,
      threadId,
      port: 5171,
    });
    expect(JSON.parse(events[0]?.actor_json ?? "")).toMatchObject({
      kind: "remote-device",
      deviceId: deviceA,
    });
    expect(JSON.parse(events[1]?.payload_json ?? "")).toMatchObject({
      reason: "proxy-session-ended",
    });
    expect(JSON.parse(events[1]?.actor_json ?? "")).toMatchObject({ kind: "system" });
    for (const event of events) {
      expect(event.payload_json).not.toContain("127.0.0.1");
      expect(event.payload_json).not.toContain("4001");
    }
  });

  it("rebuilds the open-grant view from the journal, and a starting host closes what it left open", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    harness.targets.set(listenerId(2), listed(2));
    const kept = grantOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(1),
      }),
    );
    grantOf(
      await harness.grants.open({
        principal: device(deviceB, sessionB),
        scopeId: scopeA,
        request: fromLocalServers(2),
      }),
    );
    harness.grants.closeDevice(deviceB, "device-revoked");

    const runtime = createPhase1RuntimeRegistries();
    rebuildAll({
      connection: harness.connection,
      journal: harness.journal,
      projections: runtime.projections,
      clock: () => now,
    });
    expect(
      readOpenRemoteServerGrants(harness.connection).map((record) => record.grant.grantId),
    ).toEqual([kept.grantId]);

    const restarted = setup({ connection: harness.connection });
    restarted.grants.reconcile();
    expect(readOpenRemoteServerGrants(harness.connection)).toEqual([]);
    const last = grantEvents(harness.connection).at(-1);
    expect(JSON.parse(last?.payload_json ?? "")).toMatchObject({
      grantId: kept.grantId,
      reason: "proxy-session-ended",
    });
  });

  it.each([
    [
      "a proxy session ending",
      (grants: RemoteServerGrantService) => grants.closeSession(sessionA, "proxy-session-ended"),
      "proxy-session-ended",
    ],
    [
      "the device being revoked",
      (grants: RemoteServerGrantService) => grants.closeDevice(deviceA, "device-revoked"),
      "device-revoked",
    ],
    [
      "the thread being archived",
      (grants: RemoteServerGrantService) => grants.closeThread(threadId, "thread-archived"),
      "thread-archived",
    ],
    [
      "the server being stopped",
      (grants: RemoteServerGrantService) => grants.closeServer({ pid: 4001, port: 5171 }),
      "server-stopped",
    ],
  ] as const)(
    "closes a grant on %s and leaves other grants open",
    async (_label, close, reason) => {
      const harness = setup();
      harness.targets.set(listenerId(1), listed(1));
      harness.targets.set(listenerId(2), listed(2, { threadId: otherThreadId }));
      grantOf(
        await harness.grants.open({
          principal: device(),
          scopeId: scopeA,
          request: fromLocalServers(1),
        }),
      );
      const other = grantOf(
        await harness.grants.open({
          principal: device(deviceB, sessionB),
          scopeId: scopeA,
          request: fromLocalServers(2, otherThreadId),
        }),
      );
      close(harness.grants);
      expect(harness.grants.openCount()).toBe(1);
      expect(
        readOpenRemoteServerGrants(harness.connection).map((record) => record.grant.grantId),
      ).toEqual([other.grantId]);
      expect(JSON.parse(grantEvents(harness.connection).at(-1)?.payload_json ?? "")).toMatchObject({
        reason,
      });
    },
  );

  it("leaves no record of a grant once its thread is purged", async () => {
    const harness = setup();
    harness.targets.set(listenerId(1), listed(1));
    grantOf(
      await harness.grants.open({
        principal: device(),
        scopeId: scopeA,
        request: fromLocalServers(1),
      }),
    );
    harness.grants.closeThread(threadId, "thread-unreadable");
    erasePurgedThread({
      connection: harness.connection,
      mode: "code",
      threadId: decodeThreadRetentionThreadId(String(threadId)),
    });
    expect(grantEvents(harness.connection)).toEqual([]);
    expect(
      harness.connection
        .prepare("SELECT COUNT(*) AS count FROM remote_server_grant_projection")
        .get(),
    ).toEqual({ count: 0 });
  });
});
