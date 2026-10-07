import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "@octant/host-runtime";
import {
  LOCAL_HOST_ID,
  REPLICA_ENTRY_FORMAT,
  ReplayCursor,
  decodeReplicaMembershipEntry,
  encodeReplicaEntry,
  type ReplicaInstanceId,
  type ReplicaMembershipEntry,
  type ReplicaMembershipResult,
} from "@octant/contracts";
import { REPLICA_JOIN_REQUEST_TTL_MS } from "@octant/domain/replica-membership-policy";
import type { ReplicaStore, ReplicaStorePutResult } from "@octant/plugin-api/replica-store";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection, ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import {
  ensureReplicaDeviceKey,
  makeReplicaDeviceSigner,
  verifyReplicaEntrySignature,
} from "./replicaDeviceKeyService";
import {
  createReplicaMembershipJournal,
  REPLICA_MEMBERSHIP_EVENT_NAMES,
  registerReplicaMembershipEvents,
  ReplicaMembershipProjection,
} from "./replicaMembershipProjection";
import {
  deriveReplicaJoinMatchingCode,
  ReplicaMembershipService,
  type ReplicaStoreSelection,
} from "./replicaMembershipService";

const NOW_ISO = "2026-10-07T10:00:00.000Z";
const NOW = Date.parse(NOW_ISO);

const ids = {
  north: "11111111-1111-4111-8111-111111111111" as ReplicaInstanceId,
  south: "22222222-2222-4222-8222-222222222222" as ReplicaInstanceId,
  east: "33333333-3333-4333-8333-333333333333" as ReplicaInstanceId,
  southAgain: "44444444-4444-4444-8444-444444444444" as ReplicaInstanceId,
  zed: "55555555-5555-4555-8555-555555555555" as ReplicaInstanceId,
} as const;

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function memoryCredentialStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    async set(id, credential) {
      values.set(id, credential);
    },
    async has(id) {
      return values.has(id);
    },
    async resolve(id) {
      const value = values.get(id);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    async delete(id) {
      values.delete(id);
    },
  };
}

type MemoryStore = ReplicaStore & {
  readonly files: Map<string, Uint8Array>;
  /** The next put of a key ending in this suffix answers not-connected once. */
  failNextPut: string | undefined;
  calls: number;
};

/** Write-once in-memory store: putIfAbsent never replaces. */
function memoryStore(): MemoryStore {
  const files = new Map<string, Uint8Array>();
  const store: MemoryStore = {
    files,
    failNextPut: undefined,
    calls: 0,
    kind: "replica-store",
    async status() {
      store.calls += 1;
      return "ready";
    },
    async list() {
      store.calls += 1;
      return {
        status: "ready",
        entries: [...files.keys()].map((key) => ({ key })),
        reports: [],
      };
    },
    async get(key: string) {
      store.calls += 1;
      const bytes = files.get(key);
      if (bytes === undefined) return { status: "missing" as const };
      return { status: "ready" as const, bytes };
    },
    async putIfAbsent(key: string, bytes: Uint8Array): Promise<ReplicaStorePutResult> {
      store.calls += 1;
      if (store.failNextPut !== undefined && key.endsWith(store.failNextPut)) {
        store.failNextPut = undefined;
        return { status: "not-connected" };
      }
      if (files.has(key)) return { status: "already-exists" };
      files.set(key, bytes);
      return { status: "stored" };
    },
  };
  return store;
}

/** One simulated computer: its own journal, keychain, and identity, sharing a store. */
function computer(options: {
  readonly store: ReplicaStoreSelection;
  readonly instanceId: ReplicaInstanceId;
  /** Identities this computer takes after its first, in order. */
  readonly laterInstanceIds?: ReadonlyArray<ReplicaInstanceId>;
  readonly now?: () => number;
}) {
  const instanceIds = [options.instanceId, ...(options.laterInstanceIds ?? [])];
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-replica-membership-")));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW_ISO);
  const projection = new ReplicaMembershipProjection();
  const registry = registerReplicaMembershipEvents(new EventRegistry());
  const projections = new ProjectionRegistry()
    .register(new AggregateHeadsProjection())
    .register(projection);
  const journal = new Journal({ connection, registry, projections, clock: () => NOW_ISO });
  const credentials = memoryCredentialStore();
  let uuid = 0;
  const service = new ReplicaMembershipService({
    store: () => options.store,
    credentials: {
      ensure: (instanceId) => ensureReplicaDeviceKey(credentials, instanceId),
      sign: (instanceId, payload) => makeReplicaDeviceSigner(credentials, instanceId).sign(payload),
    },
    journal: createReplicaMembershipJournal({
      journal,
      uuid: () => {
        uuid += 1;
        return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
      },
      clock: () => NOW_ISO,
      actor: { kind: "local-user", actorId: "77777777-7777-4777-8777-777777777777" },
    }),
    state: () => projection.state(),
    localHostId: LOCAL_HOST_ID,
    clock: options.now ?? (() => NOW),
    newInstanceId: () => instanceIds.shift() ?? options.instanceId,
  });
  const events = () =>
    journal
      .replay(Schema.decodeUnknownSync(ReplayCursor)({ afterSequence: 0, limit: 1_000 }))
      .map((event) => ({ eventName: event.eventName, payload: event.payload }));
  return { service, projection, journal, connection, credentials, events };
}

function selected(store: ReplicaStore): ReplicaStoreSelection {
  return { status: "selected", store };
}

function expectKind<K extends ReplicaMembershipResult["kind"]>(
  outcome: ReplicaMembershipResult,
  kind: K,
): Extract<ReplicaMembershipResult, { kind: K }> {
  if (outcome.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(outcome)}`);
  return outcome as Extract<ReplicaMembershipResult, { kind: K }>;
}

/** North founds the store; South asks to join; North approves; South confirms. */
async function joinedPair(store: MemoryStore) {
  const north = computer({ store: selected(store), instanceId: ids.north });
  const south = computer({ store: selected(store), instanceId: ids.south });
  expectKind(
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" }),
    "replica-created",
  );
  const requested = expectKind(
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
    "join-requested",
  );
  const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
  const code = deriveReplicaJoinMatchingCode({
    joinRequest: requested.entry,
    approverInstanceId: ids.north,
  });
  const approved = expectKind(
    await north.service.execute({
      kind: "approve-join",
      joinRequest: requested.entry,
      confirmationCode: code,
    }),
    "join-approved",
  );
  expectKind(
    await south.service.execute({
      kind: "confirm-join",
      approver: ids.north,
      confirmationCode: code,
    }),
    "join-confirmed",
  );
  return { north, south, requested, pulled, approved, code };
}

function verifiesAt(store: MemoryStore, path: string, publicKey: string): boolean {
  const entry = store.files.get(`${path}.json`);
  const signature = store.files.get(`${path}.sig`);
  if (entry === undefined || signature === undefined) return false;
  return verifyReplicaEntrySignature({
    publicKeyBase64: publicKey,
    payload: entry,
    signatureBase64: new TextDecoder().decode(signature),
  });
}

describe("replica membership service", () => {
  it("answers not-configured and calls no store when the host has none set up", async () => {
    const north = computer({ store: { status: "not-configured" }, instanceId: ids.north });
    for (const command of [
      { kind: "create-replica", displayName: "MacBook" },
      { kind: "pull" },
      { kind: "revoke", subject: ids.south },
    ] as const) {
      const outcome = await north.service.execute(command);
      expect(outcome).toMatchObject({ kind: "refused", reason: "not-configured" });
    }
    expect(north.projection.state().local).toBeUndefined();
    expect(
      north.events().filter((e) => e.eventName === REPLICA_MEMBERSHIP_EVENT_NAMES.commandRefused),
    ).toHaveLength(3);
  });

  it("creates a replica with a signed founding self-approval and journals the member", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    const created = expectKind(
      await north.service.execute({ kind: "create-replica", displayName: "MacBook" }),
      "replica-created",
    );
    const state = north.projection.state();
    expect(state.local?.instanceId).toBe(ids.north);
    expect(state.members.map((m) => m.instanceId)).toEqual([ids.north]);
    expect(state.localSequence).toBe(1);
    expect(created.entry.subjectDeviceKey).toBe(state.local?.publicKey);
    expect(verifiesAt(store, `${ids.north}/1`, state.local?.publicKey ?? "")).toBe(true);
  });

  it("joins, confirms and revokes between two computers, and refuses the revoked one's later entry", async () => {
    const store = memoryStore();
    const { north, south, pulled, approved } = await joinedPair(store);

    // North saw South's request on its pull and approved it under its own name.
    expect(pulled.joinRequests.map((entry) => entry.subject)).toEqual([ids.south]);
    expect(approved.entry.origin).toEqual({
      instanceId: ids.north,
      displayName: "MacBook",
      sequence: 2,
    });
    expect(
      north.projection
        .state()
        .members.map((m) => m.instanceId)
        .sort(),
    ).toEqual([ids.north, ids.south].sort());
    // South learned North from its own confirmation, then accepts North's log.
    expect(
      south.projection
        .state()
        .members.map((m) => m.instanceId)
        .sort(),
    ).toEqual([ids.north, ids.south].sort());
    const east = computer({ store: selected(store), instanceId: ids.east });
    const eastRequest = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    const southPull = expectKind(await south.service.execute({ kind: "pull" }), "pulled");
    expect(southPull.refused).toEqual([]);
    expect(southPull.applied).toBe(3);

    const revoked = expectKind(
      await north.service.execute({ kind: "revoke", subject: ids.south }),
      "revoked",
    );
    expect(revoked.entry.origin.displayName).toBe("MacBook");
    expect(revoked.entry.subjectDisplayName).toBe("Mac mini");
    expect(north.projection.state().revocations.map((cut) => cut.instanceId)).toEqual([ids.south]);

    // South has not read the revocation yet and approves East; North refuses
    // that record on read and does not admit East through it.
    expectKind(
      await south.service.execute({
        kind: "approve-join",
        joinRequest: eastRequest.entry,
        confirmationCode: deriveReplicaJoinMatchingCode({
          joinRequest: eastRequest.entry,
          approverInstanceId: ids.south,
        }),
      }),
      "join-approved",
    );
    const northPull = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(northPull.refused).toEqual([
      { instanceId: ids.south, sequence: 2, reason: "revoked-instance" },
    ]);
    expect(north.projection.state().members.map((m) => m.instanceId)).not.toContain(ids.east);
    expect(
      north
        .events()
        .some(
          (e) =>
            e.eventName === REPLICA_MEMBERSHIP_EVENT_NAMES.entryRefused &&
            (e.payload as { reason: string }).reason === "revoked-instance",
        ),
    ).toBe(true);

    // Once South reads North's revocation it holds itself revoked too.
    const southSecondPull = expectKind(await south.service.execute({ kind: "pull" }), "pulled");
    expect(southSecondPull.applied).toBe(1);
    expect(south.projection.state().revocations.map((cut) => cut.instanceId)).toEqual([ids.south]);
  });

  it("starts a new identity with its own sequence when a revoked computer asks to join again", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    const south = computer({
      store: selected(store),
      instanceId: ids.south,
      laterInstanceIds: [ids.southAgain],
    });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    // South asks again under the same identity: its sequence 2.
    const refreshed = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    expect(refreshed.entry.origin.sequence).toBe(2);
    await north.service.execute({ kind: "pull" });
    const code = deriveReplicaJoinMatchingCode({
      joinRequest: refreshed.entry,
      approverInstanceId: ids.north,
    });
    expectKind(
      await north.service.execute({
        kind: "approve-join",
        joinRequest: refreshed.entry,
        confirmationCode: code,
      }),
      "join-approved",
    );
    expectKind(
      await south.service.execute({
        kind: "confirm-join",
        approver: ids.north,
        confirmationCode: code,
      }),
      "join-confirmed",
    );
    await north.service.execute({ kind: "revoke", subject: ids.south });
    await south.service.execute({ kind: "pull" });
    expect(south.projection.state().revocations.map((cut) => cut.instanceId)).toEqual([ids.south]);

    const again = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    expect(again.instanceId).toBe(ids.southAgain);
    expect(again.entry.origin.sequence).toBe(1);
    // The new identity's next entry follows its own first one, not the old
    // identity's sequence.
    expect(south.projection.state().localSequence).toBe(1);
    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toEqual([]);
    expect(pulled.joinRequests.map((entry) => entry.subject)).toEqual([ids.southAgain]);
  });

  it("refuses a pull whose store listing does not end inside the bound", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const endless: ReplicaStore = {
      ...store,
      async list() {
        return { status: "ready", entries: [], reports: [], nextCursor: "more" };
      },
    };
    const reader = new ReplicaMembershipService({
      store: () => selected(endless),
      credentials: {
        ensure: () => Promise.reject(new Error("unused")),
        sign: () => Promise.reject(new Error("unused")),
      },
      journal: createReplicaMembershipJournal({
        journal: north.journal,
        uuid: () => crypto.randomUUID(),
        clock: () => NOW_ISO,
        actor: { kind: "local-user", actorId: "77777777-7777-4777-8777-777777777777" },
      }),
      state: () => north.projection.state(),
      localHostId: LOCAL_HOST_ID,
      clock: () => NOW,
    });
    const outcome = await reader.execute({ kind: "pull" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "store-unavailable" });
    const failure = north
      .events()
      .find((e) => e.eventName === REPLICA_MEMBERSHIP_EVENT_NAMES.storeFailure);
    expect(failure?.payload).toMatchObject({ phase: "list", reason: "truncated" });
  });

  it("refuses a new identity that carries a revoked computer's key, on read and on approve", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    expectKind(await north.service.execute({ kind: "revoke", subject: ids.south }), "revoked");
    const southKey = south.projection.state().local?.publicKey ?? "";
    const entry = decodeReplicaMembershipEntry({
      format: REPLICA_ENTRY_FORMAT,
      kind: "join-request",
      origin: { instanceId: ids.zed, displayName: "Mac mini", sequence: 1 },
      subject: ids.zed,
      subjectDisplayName: "Mac mini",
      subjectDeviceKey: southKey,
      requestedAt: NOW,
    });
    const bytes = new TextEncoder().encode(encodeReplicaEntry(entry));
    const { signature } = await makeReplicaDeviceSigner(south.credentials, ids.south).sign(bytes);
    store.files.set(`${ids.zed}/1.json`, bytes);
    store.files.set(`${ids.zed}/1.sig`, new TextEncoder().encode(signature));

    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.joinRequests).toEqual([]);
    expect(pulled.refused).toContainEqual({
      instanceId: ids.zed,
      sequence: 1,
      reason: "revoked-instance",
    });
    const outcome = await north.service.execute({
      kind: "approve-join",
      joinRequest: entry,
      confirmationCode: deriveReplicaJoinMatchingCode({
        joinRequest: entry,
        approverInstanceId: ids.north,
      }),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "revoked-instance" });
  });

  it("drops a revoked identity's stopped publish instead of finishing it", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store), instanceId: ids.east });
    const eastRequest = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    await south.service.execute({ kind: "pull" });
    store.failNextPut = `${ids.south}/2.json`;
    const failed = await south.service.execute({
      kind: "approve-join",
      joinRequest: eastRequest.entry,
      confirmationCode: deriveReplicaJoinMatchingCode({
        joinRequest: eastRequest.entry,
        approverInstanceId: ids.south,
      }),
    });
    expect(failed.kind).toBe("store-failed");
    expectKind(await north.service.execute({ kind: "revoke", subject: ids.south }), "revoked");
    await south.service.execute({ kind: "pull" });
    expect(south.projection.state().pending).toBeUndefined();

    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    expect(store.files.has(`${ids.south}/2.json`)).toBe(false);
  });

  it("keeps a stopped publish and recorded refusals when the journal is replayed", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store), instanceId: ids.east });
    await east.service.execute({ kind: "write-join-request", displayName: "Studio" });
    store.files.delete(`${ids.east}/1.sig`);
    await north.service.execute({ kind: "pull" });
    store.failNextPut = `${ids.north}/3.json`;
    expect((await north.service.execute({ kind: "revoke", subject: ids.south })).kind).toBe(
      "store-failed",
    );
    const before = north.projection.state();
    expect(before.pending?.origin.sequence).toBe(3);
    const rebuilt = new ReplicaMembershipProjection();
    for (let round = 0; round < 2; round += 1) {
      catchUpProjection({
        connection: north.connection,
        journal: north.journal,
        projection: rebuilt,
        clock: () => NOW_ISO,
      });
      const after = rebuilt.state();
      expect(after.pending).toEqual(before.pending);
      expect(after.localSequence).toBe(before.localSequence);
      expect(after.applied).toEqual(before.applied);
      expect(after.members).toEqual(before.members);
      expect(
        after.refusalRecorded({ instanceId: ids.east, sequence: 1, reason: "bad-signature" }),
      ).toBe(true);
    }
    expect(south.projection.state().local?.instanceId).toBe(ids.south);
  });

  it("refuses what a revoked computer approved after its cut, whatever order the logs are read in", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store), instanceId: ids.east });
    const eastRequest = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    await north.service.execute({ kind: "pull" });
    const eastCode = deriveReplicaJoinMatchingCode({
      joinRequest: eastRequest.entry,
      approverInstanceId: ids.north,
    });
    expectKind(
      await north.service.execute({
        kind: "approve-join",
        joinRequest: eastRequest.entry,
        confirmationCode: eastCode,
      }),
      "join-approved",
    );
    expectKind(
      await east.service.execute({
        kind: "confirm-join",
        approver: ids.north,
        confirmationCode: eastCode,
      }),
      "join-confirmed",
    );
    await east.service.execute({ kind: "pull" });
    // East (3333...) revokes South (2222...).
    const revocation = expectKind(
      await east.service.execute({ kind: "revoke", subject: ids.south }),
      "revoked",
    );
    expect(revocation.entry.lastAcceptedSequence).toBe(1);
    // South has not read it and approves Zed after the cut.
    const zed = computer({ store: selected(store), instanceId: ids.zed });
    const zedRequest = expectKind(
      await zed.service.execute({ kind: "write-join-request", displayName: "Unknown" }),
      "join-requested",
    );
    expectKind(
      await south.service.execute({
        kind: "approve-join",
        joinRequest: zedRequest.entry,
        confirmationCode: deriveReplicaJoinMatchingCode({
          joinRequest: zedRequest.entry,
          approverInstanceId: ids.south,
        }),
      }),
      "join-approved",
    );

    // North reads South's log before East's, once.
    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    const state = north.projection.state();
    expect(state.revocations.map((cut) => cut.instanceId)).toEqual([ids.south]);
    expect(state.members.map((member) => member.instanceId)).not.toContain(ids.zed);
    expect(pulled.refused).toContainEqual({
      instanceId: ids.south,
      sequence: 2,
      reason: "revoked-instance",
    });
  });

  it("refuses an entry whose bytes were changed after it was signed, and applies nothing past it", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    const south = computer({ store: selected(store), instanceId: ids.south });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    const path = `${ids.south}/1.json`;
    const original = new TextDecoder().decode(store.files.get(path));
    store.files.set(path, new TextEncoder().encode(original.replace("Mac mini", "Mac mimi")));

    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toEqual([
      { instanceId: ids.south, sequence: 1, reason: "bad-signature" },
    ]);
    expect(pulled.applied).toBe(0);
    expect(pulled.joinRequests).toEqual([]);
    expect(north.projection.state().applied).toEqual([]);
  });

  it("refuses an entry whose signature is missing", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    const south = computer({ store: selected(store), instanceId: ids.south });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    store.files.delete(`${ids.south}/1.sig`);

    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toEqual([
      { instanceId: ids.south, sequence: 1, reason: "bad-signature" },
    ]);
    // A second pull meets the same file and does not journal the refusal again.
    await north.service.execute({ kind: "pull" });
    expect(
      north.events().filter((e) => e.eventName === REPLICA_MEMBERSHIP_EVENT_NAMES.entryRefused),
    ).toHaveLength(1);
  });

  it("refuses an entry filed under a path its body does not name", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    const south = computer({ store: selected(store), instanceId: ids.south });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    for (const suffix of ["json", "sig"]) {
      const bytes = store.files.get(`${ids.south}/1.${suffix}`);
      if (bytes !== undefined) store.files.set(`${ids.east}/1.${suffix}`, bytes);
    }

    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toEqual([
      { instanceId: ids.east, sequence: 1, reason: "path-mismatch" },
    ]);
    expect(pulled.applied).toBe(1);
  });

  it("refuses a later entry while an earlier one from the same computer is missing", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store), instanceId: ids.east });
    const request = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    await south.service.execute({ kind: "pull" });
    // South approves and then revokes East: its sequences 2 and 3.
    expectKind(
      await south.service.execute({
        kind: "approve-join",
        joinRequest: request.entry,
        confirmationCode: deriveReplicaJoinMatchingCode({
          joinRequest: request.entry,
          approverInstanceId: ids.south,
        }),
      }),
      "join-approved",
    );
    expectKind(await south.service.execute({ kind: "revoke", subject: ids.east }), "revoked");
    // Sequence 2 never reached the store North reads.
    store.files.delete(`${ids.south}/2.json`);
    store.files.delete(`${ids.south}/2.sig`);

    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toContainEqual({
      instanceId: ids.south,
      sequence: 3,
      reason: "sequence-gap",
    });
    expect(north.projection.state().revocations).toEqual([]);
  });

  it("rebuilds the same membership facts when the journal is replayed", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    await north.service.execute({ kind: "revoke", subject: ids.south });
    await south.service.execute({ kind: "pull" });

    for (const host of [north, south]) {
      const before = host.projection.state();
      const rebuilt = new ReplicaMembershipProjection();
      for (let round = 0; round < 2; round += 1) {
        catchUpProjection({
          connection: host.connection,
          journal: host.journal,
          projection: rebuilt,
          clock: () => NOW_ISO,
        });
        const after = rebuilt.state();
        expect(after.local).toEqual(before.local);
        expect(after.members).toEqual(before.members);
        expect(after.revocations).toEqual(before.revocations);
        expect(after.localSequence).toBe(before.localSequence);
        expect(after.applied).toEqual(before.applied);
        expect(after.joinRequests).toEqual(before.joinRequests);
        expect(after.pending).toEqual(before.pending);
      }
    }
  });

  it("finishes a publish that stopped after its signature landed, keeping the sequence usable", async () => {
    const store = memoryStore();
    const { north } = await joinedPair(store);
    store.failNextPut = `${ids.north}/3.json`;
    const failed = await north.service.execute({ kind: "revoke", subject: ids.south });
    expect(failed.kind).toBe("store-failed");
    expect(store.files.has(`${ids.north}/3.sig`)).toBe(true);
    expect(store.files.has(`${ids.north}/3.json`)).toBe(false);
    expect(north.projection.state().pending?.origin.sequence).toBe(3);

    // The next command finishes the stopped revocation in its own slot first.
    const east = computer({ store: selected(store), instanceId: ids.east });
    const request = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    const approved = expectKind(
      await north.service.execute({
        kind: "approve-join",
        joinRequest: request.entry,
        confirmationCode: deriveReplicaJoinMatchingCode({
          joinRequest: request.entry,
          approverInstanceId: ids.north,
        }),
      }),
      "join-approved",
    );
    const northKey = north.projection.state().local?.publicKey ?? "";
    expect(verifiesAt(store, `${ids.north}/3`, northKey)).toBe(true);
    expect(approved.entry.origin.sequence).toBe(4);
    expect(north.projection.state().revocations.map((cut) => cut.instanceId)).toEqual([ids.south]);
    expect(north.projection.state().pending).toBeUndefined();
  });

  it("refuses an approval when the matching codes do not agree", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    const south = computer({ store: selected(store), instanceId: ids.south });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const request = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    const outcome = await north.service.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: "000000",
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "code-mismatch" });
    expect(store.files.has(`${ids.north}/2.json`)).toBe(false);
    expect(north.projection.state().members.map((m) => m.instanceId)).toEqual([ids.north]);
  });

  it("refuses an approval from a computer that is not a member", async () => {
    const store = memoryStore();
    const south = computer({ store: selected(store), instanceId: ids.south });
    const east = computer({ store: selected(store), instanceId: ids.east });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    const request = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    const outcome = await south.service.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: deriveReplicaJoinMatchingCode({
        joinRequest: request.entry,
        approverInstanceId: ids.south,
      }),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "not-a-member" });
  });

  it("refuses an approval for a join request that is not in the store", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const key = await ensureReplicaDeviceKey(memoryCredentialStore(), ids.south);
    const request = joinRequestEntry(ids.south, key.publicKey, NOW);
    const outcome = await north.service.execute({
      kind: "approve-join",
      joinRequest: request,
      confirmationCode: deriveReplicaJoinMatchingCode({
        joinRequest: request,
        approverInstanceId: ids.north,
      }),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "unknown-instance" });
    expect(
      north.events().some((e) => e.eventName === REPLICA_MEMBERSHIP_EVENT_NAMES.commandRefused),
    ).toBe(true);
  });

  it("refuses an approval whose stored join request was signed by another key", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const joinerKeys = memoryCredentialStore();
    const key = await ensureReplicaDeviceKey(joinerKeys, ids.south);
    const request = joinRequestEntry(ids.south, key.publicKey, NOW);
    const bytes = new TextEncoder().encode(encodeReplicaEntry(request));
    store.files.set(`${ids.south}/1.json`, bytes);
    const otherKeys = memoryCredentialStore();
    await ensureReplicaDeviceKey(otherKeys, ids.east);
    const { signature } = await makeReplicaDeviceSigner(otherKeys, ids.east).sign(bytes);
    store.files.set(`${ids.south}/1.sig`, new TextEncoder().encode(signature));
    const outcome = await north.service.execute({
      kind: "approve-join",
      joinRequest: request,
      confirmationCode: deriveReplicaJoinMatchingCode({
        joinRequest: request,
        approverInstanceId: ids.north,
      }),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "code-mismatch" });
  });

  it("refuses an approval whose join request is no longer fresh", async () => {
    let now = NOW;
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north, now: () => now });
    const south = computer({ store: selected(store), instanceId: ids.south, now: () => now });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const request = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    now += REPLICA_JOIN_REQUEST_TTL_MS + 1;
    const outcome = await north.service.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: deriveReplicaJoinMatchingCode({
        joinRequest: request.entry,
        approverInstanceId: ids.north,
      }),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "expired-join-request" });
  });

  it("refuses a join confirmation whose code names a different approver", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    const south = computer({ store: selected(store), instanceId: ids.south });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const request = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    const outcome = await south.service.execute({
      kind: "confirm-join",
      approver: ids.north,
      confirmationCode: deriveReplicaJoinMatchingCode({
        joinRequest: request.entry,
        approverInstanceId: ids.east,
      }),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "code-mismatch" });
    expect(south.projection.state().members).toEqual([]);
  });

  it("refuses a join confirmation before the approver has published an approval", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    const south = computer({ store: selected(store), instanceId: ids.south });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const request = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    const outcome = await south.service.execute({
      kind: "confirm-join",
      approver: ids.north,
      confirmationCode: deriveReplicaJoinMatchingCode({
        joinRequest: request.entry,
        approverInstanceId: ids.north,
      }),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "unknown-instance" });
    expect(south.projection.state().members).toEqual([]);
  });

  it("leaves no entry behind when another file already holds the signature slot", async () => {
    const store = memoryStore();
    store.files.set(`${ids.south}/1.sig`, new TextEncoder().encode("taken"));
    const south = computer({ store: selected(store), instanceId: ids.south });
    const outcome = await south.service.execute({
      kind: "write-join-request",
      displayName: "Mac mini",
    });
    expect(outcome.kind).toBe("store-failed");
    expect(store.files.has(`${ids.south}/1.json`)).toBe(false);
    expect(south.projection.state().local).toBeUndefined();
    const failure = south
      .events()
      .find((e) => e.eventName === REPLICA_MEMBERSHIP_EVENT_NAMES.storeFailure);
    expect(failure?.payload).toMatchObject({ phase: "signature", reason: "slot-occupied" });
  });

  it("refuses to revoke a computer that is not a member", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store), instanceId: ids.north });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const outcome = await north.service.execute({ kind: "revoke", subject: ids.south });
    expect(outcome).toMatchObject({ kind: "refused", reason: "unknown-instance" });
    expect(store.files.has(`${ids.north}/2.json`)).toBe(false);
  });
});

function joinRequestEntry(
  instanceId: ReplicaInstanceId,
  publicKey: string,
  requestedAt: number,
): ReplicaMembershipEntry {
  return decodeReplicaMembershipEntry({
    format: REPLICA_ENTRY_FORMAT,
    kind: "join-request",
    origin: { instanceId, displayName: "Mac mini", sequence: 1 },
    subject: instanceId,
    subjectDisplayName: "Mac mini",
    subjectDeviceKey: publicKey,
    requestedAt,
  });
}
