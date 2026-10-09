import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "@octant/host-runtime";
import {
  ARTIFACT_BUNDLE_FORMAT,
  LOCAL_HOST_ID,
  REPLICA_ENTRY_FORMAT,
  ReplayCursor,
  decodeReplicaArtifactEntry,
  decodeReplicaMembershipEntry,
  encodeReplicaEntry,
  type ReplicaInstanceId,
  type ReplicaJoinRequestEntry,
  type ReplicaEntry,
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
  createReplicaDeviceKey,
  makeReplicaDeviceSigner,
  replicaInstanceIdOf,
  verifyReplicaEntrySignature,
  type ReplicaDeviceSignOutcome,
} from "./replicaDeviceKeyService";
import {
  createReplicaMembershipJournal,
  REPLICA_MEMBERSHIP_EVENT_NAMES,
  registerReplicaMembershipEvents,
  ReplicaMembershipProjection,
  type ReplicaMembershipJournal,
} from "./replicaMembershipProjection";
import {
  deriveReplicaJoinMatchingCode,
  REPLICA_MAX_SQUATTED_SLOTS,
  ReplicaMembershipService,
  type ReplicaStoreSelection,
} from "./replicaMembershipService";

const NOW_ISO = "2026-10-07T10:00:00.000Z";
const NOW = Date.parse(NOW_ISO);

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
  readonly now?: () => number;
  /** The host stops (every later journal append throws) right after this event. */
  readonly stopAfter?: string;
}) {
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
  const power = { stopAfter: options.stopAfter, stopped: false };
  const service = new ReplicaMembershipService({
    store: () => options.store,
    credentials: {
      create: () => createReplicaDeviceKey(credentials),
      sign: (instanceId, payload) => makeReplicaDeviceSigner(credentials, instanceId).sign(payload),
    },
    journal: stoppable(
      createReplicaMembershipJournal({
        journal,
        uuid: () => {
          uuid += 1;
          return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
        },
        clock: () => NOW_ISO,
        actor: { kind: "local-user", actorId: "77777777-7777-4777-8777-777777777777" },
      }),
      power,
    ),
    state: () => projection.state(),
    localHostId: LOCAL_HOST_ID,
    clock: options.now ?? (() => NOW),
  });
  const events = () =>
    journal
      .replay(Schema.decodeUnknownSync(ReplayCursor)({ afterSequence: 0, limit: 1_000 }))
      .map((event) => ({ eventName: event.eventName, payload: event.payload }));
  const id = (): ReplicaInstanceId => {
    const local = projection.state().local;
    if (local === undefined) throw new Error("The computer has no identity.");
    return local.instanceId;
  };
  /** The host starts again on the same journal after it stopped. */
  const restart = () => {
    power.stopAfter = undefined;
    power.stopped = false;
  };
  return { service, projection, journal, connection, credentials, events, id, restart };
}

/** A journal that refuses every append after the named event, as a host that stopped would. */
function stoppable(
  inner: ReplicaMembershipJournal,
  power: { stopAfter: string | undefined; stopped: boolean },
): ReplicaMembershipJournal {
  return {
    append: (input) => {
      if (power.stopped) throw new Error("The host stopped.");
      inner.append(input);
      if (input.eventName === power.stopAfter) power.stopped = true;
    },
  };
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

type Computer = ReturnType<typeof computer>;

/** The code the approving computer shows for a join request, from its own key and founder. */
function codeFor(joinRequest: ReplicaJoinRequestEntry, approver: Computer): string {
  const state = approver.projection.state();
  if (state.local === undefined || state.founder === undefined) {
    throw new Error("The approving computer has no identity in a replica.");
  }
  return deriveReplicaJoinMatchingCode({
    joinRequest,
    approver: state.local,
    founder: state.founder,
  });
}

/** `joiner` asks; `approver` reads the store, approves with its code, and the joiner confirms. */
async function joinThrough(joiner: Computer, approver: Computer, displayName: string) {
  const request = expectKind(
    await joiner.service.execute({ kind: "write-join-request", displayName }),
    "join-requested",
  );
  const pulled = expectKind(await approver.service.execute({ kind: "pull" }), "pulled");
  const code = codeFor(request.entry, approver);
  const approved = expectKind(
    await approver.service.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: code,
    }),
    "join-approved",
  );
  const confirmed = expectKind(
    await joiner.service.execute({
      kind: "confirm-join",
      approver: approver.id(),
      confirmationCode: code,
    }),
    "join-confirmed",
  );
  return { request, pulled, approved, confirmed, code };
}

/** North founds the store; South asks to join; North approves; South confirms. */
async function joinedPair(store: MemoryStore) {
  const north = computer({ store: selected(store) });
  const south = computer({ store: selected(store) });
  expectKind(
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" }),
    "replica-created",
  );
  const joined = await joinThrough(south, north, "Mac mini");
  return { north, south, ...joined };
}

function memberIds(host: Computer): ReadonlyArray<string> {
  return host.projection
    .state()
    .members.map((member) => String(member.instanceId))
    .sort();
}

function cutOf(host: Computer, id: ReplicaInstanceId): number | undefined {
  return host.projection.state().revocations.find((cut) => String(cut.instanceId) === String(id))
    ?.lastAcceptedSequence;
}

function signedText(outcome: ReplicaDeviceSignOutcome): string {
  if (outcome.status !== "signed") throw new Error(`Signing was refused: ${outcome.reason}`);
  return outcome.signature;
}

/** Signs and writes a record with a key the caller holds, outside any service. */
async function writeRecord(
  store: MemoryStore,
  credentials: CredentialStore,
  entry: ReplicaEntry,
): Promise<string> {
  const bytes = new TextEncoder().encode(encodeReplicaEntry(entry));
  const signature = signedText(
    await makeReplicaDeviceSigner(credentials, entry.origin.instanceId).sign(bytes),
  );
  const path = `${entry.origin.instanceId}/${entry.origin.sequence}`;
  store.files.set(`${path}.json`, bytes);
  store.files.set(`${path}.sig`, new TextEncoder().encode(signature));
  return createHash("sha256").update(bytes).digest("hex");
}

/** A valid artifact version entry the host signs at `sequence`; artifact import is not built. */
function artifactEntry(host: Computer, sequence: number): ReplicaEntry {
  const createdAt = NOW_ISO;
  return decodeReplicaArtifactEntry({
    format: REPLICA_ENTRY_FORMAT,
    kind: "artifact-version",
    origin: originOf(host, sequence),
    artifact: {
      canvasId: "11111111-1111-4111-8111-111111111111",
      hostId: "host-south",
      projectName: "Launch",
    },
    parents: [],
    contentHash: "a".repeat(64),
    bundle: {
      octant: {
        format: ARTIFACT_BUNDLE_FORMAT,
        canvasId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        sequence: 1,
        title: "Launch plan",
        mode: "work",
        projectId: "55555555-5555-4555-8555-555555555555",
        hostId: "host-south",
        createdAt,
      },
      definition: {
        schemaVersion: 1,
        title: "Launch plan",
        provenance: {
          hostId: "host-south",
          projectId: "55555555-5555-4555-8555-555555555555",
          actor: { kind: "system", actorId: "88888888-8888-4888-8888-888888888888" },
          providerInstanceId: "77777777-7777-4777-8777-777777777777",
          modelId: "octant-test-model",
          createdAt,
          mode: "work",
          threadId: "66666666-6666-4666-8666-666666666666",
        },
        sourceManifest: [],
        blocks: [{ blockId: "t1", schemaVersion: 1, kind: "rich-text", text: "Ship it." }],
      },
    },
  });
}

function originOf(host: Computer, sequence: number) {
  const local = host.projection.state().local;
  if (local === undefined) throw new Error("The computer has no identity.");
  return {
    instanceId: local.instanceId,
    displayName: local.displayName,
    sequence,
    publicKey: local.publicKey,
  };
}

function nextSequence(store: MemoryStore, id: ReplicaInstanceId): number {
  let highest = 0;
  for (const key of store.files.keys()) {
    const match = /^([^/]+)\/(\d+)\.json$/.exec(key);
    if (match?.[1] === String(id)) highest = Math.max(highest, Number(match[2]));
  }
  return highest + 1;
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
    const north = computer({ store: { status: "not-configured" } });
    const subject = "11111111-1111-8111-8111-111111111111" as ReplicaInstanceId;
    for (const command of [
      { kind: "create-replica", displayName: "MacBook" },
      { kind: "pull" },
      { kind: "revoke", subject },
    ] as const) {
      const outcome = await north.service.execute(command);
      expect(outcome).toMatchObject({ kind: "refused", reason: "not-configured" });
    }
    expect(north.projection.state().local).toBeUndefined();
    expect(
      north.events().filter((e) => e.eventName === REPLICA_MEMBERSHIP_EVENT_NAMES.commandRefused),
    ).toHaveLength(3);
  });

  it("creates a replica with a signed founding record under the id its key certifies", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const created = expectKind(
      await north.service.execute({ kind: "create-replica", displayName: "MacBook" }),
      "replica-created",
    );
    const state = north.projection.state();
    expect(created.instanceId).toBe(replicaInstanceIdOf(created.entry.origin.publicKey));
    expect(String(created.instanceId)[14]).toBe("8");
    expect(state.local?.instanceId).toBe(created.instanceId);
    expect(state.founder?.instanceId).toBe(created.instanceId);
    expect(state.members.map((m) => m.instanceId)).toEqual([created.instanceId]);
    expect(state.localSequence).toBe(1);
    expect(verifiesAt(store, `${created.instanceId}/1`, created.entry.origin.publicKey)).toBe(true);
  });

  it("stays the founder of its replica when the host stops right after taking its identity", async () => {
    const store = memoryStore();
    const north = computer({
      store: selected(store),
      stopAfter: REPLICA_MEMBERSHIP_EVENT_NAMES.identityCreated,
    });
    await expect(
      north.service.execute({ kind: "create-replica", displayName: "MacBook" }),
    ).rejects.toThrow("The host stopped.");
    north.restart();
    const rebuilt = new ReplicaMembershipProjection();
    catchUpProjection({
      connection: north.connection,
      journal: north.journal,
      projection: rebuilt,
      clock: () => NOW_ISO,
    });
    expect(rebuilt.state().founder?.instanceId).toBe(north.id());
    // The founding record landed before the stop; a pull holds it, and the
    // founder can bring a computer in.
    expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(memberIds(north)).toEqual([String(north.id())]);
    const south = computer({ store: selected(store) });
    await joinThrough(south, north, "Mac mini");
    expect(memberIds(south)).toContain(String(south.id()));
  });

  it("joins only once the joiner signs its acceptance, and records the approver as its parent", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const south = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const request = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.joinRequests.map((entry) => entry.origin.instanceId)).toEqual([south.id()]);
    const code = codeFor(request.entry, north);
    const approved = expectKind(
      await north.service.execute({
        kind: "approve-join",
        joinRequest: request.entry,
        confirmationCode: code,
      }),
      "join-approved",
    );
    expect(approved.entry.origin.sequence).toBe(2);
    expect(approved.entry.subjectKey).toBe(request.entry.origin.publicKey);
    // The approval alone admits nobody.
    expect(memberIds(north)).toEqual([String(north.id())]);

    const confirmed = expectKind(
      await south.service.execute({
        kind: "confirm-join",
        approver: north.id(),
        confirmationCode: code,
      }),
      "join-confirmed",
    );
    expect(confirmed.founder).toBe(north.id());
    expect(store.files.has(`${south.id()}/2.json`)).toBe(true);
    expect(memberIds(south)).toEqual([String(north.id()), String(south.id())].sort());
    await north.service.execute({ kind: "pull" });
    const southOnNorth = north.projection
      .state()
      .members.find((member) => String(member.instanceId) === String(south.id()));
    expect(southOnNorth?.parent).toBe(north.id());
    expect(southOnNorth?.publicKey).toBe(request.entry.origin.publicKey);
  });

  it("revokes a computer and stops counting what it signed after the cut, on every computer", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    const eastRequest = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    await south.service.execute({ kind: "pull" });
    const revoked = expectKind(
      await north.service.execute({ kind: "revoke", subject: south.id() }),
      "revoked",
    );
    expect(revoked.entry.cut).toBe(2);
    expect(revoked.readStore).toBe(true);
    expect(cutOf(north, south.id())).toBe(2);

    // South has not read the revocation yet and approves East past its cut.
    const code = codeFor(eastRequest.entry, south);
    expectKind(
      await south.service.execute({
        kind: "approve-join",
        joinRequest: eastRequest.entry,
        confirmationCode: code,
      }),
      "join-approved",
    );
    // East's confirmation reads the store and sees the cut first.
    expect(
      await east.service.execute({
        kind: "confirm-join",
        approver: south.id(),
        confirmationCode: code,
      }),
    ).toMatchObject({ kind: "refused", reason: "revoked-instance" });
    await north.service.execute({ kind: "pull" });
    expect(memberIds(north)).not.toContain(String(east.id()));
    // A computer that reads everything later reaches the same answer.
    const late = computer({ store: selected(store) });
    await joinThrough(late, north, "Late");
    await north.service.execute({ kind: "pull" });
    expect(memberIds(late)).toEqual(memberIds(north));
    expect(cutOf(late, south.id())).toBe(2);
    // South, once it reads the revocation, holds itself revoked too.
    await south.service.execute({ kind: "pull" });
    expect(cutOf(south, south.id())).toBe(2);
  });

  it("reads the store before revoking, so the cut keeps approvals the revoker had not read", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    await joinThrough(east, south, "Studio");
    // North never pulled South's approval of East; revoke reads it first.
    const revoked = expectKind(
      await north.service.execute({ kind: "revoke", subject: south.id() }),
      "revoked",
    );
    expect(revoked.entry.cut).toBe(3);
    expect(memberIds(north)).toContain(String(east.id()));
  });

  it("lists the computers a revoked one brought in, and revokes them in the same step", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    const west = computer({ store: selected(store) });
    await joinThrough(east, south, "Studio");
    await joinThrough(west, east, "Laptop");
    const preview = expectKind(
      await north.service.execute({ kind: "revoke-preview", subject: south.id() }),
      "revoke-preview",
    );
    expect(preview.cut).toBe(3);
    expect(preview.broughtIn.map((node) => [node.instanceId, node.parent])).toEqual([
      [east.id(), south.id()],
      [west.id(), east.id()],
    ]);
    expect(preview.broughtIn[0]?.approvalSequence).toBe(3);
    const revoked = expectKind(
      await north.service.execute({
        kind: "revoke",
        subject: south.id(),
        alsoRevoke: [east.id()],
      }),
      "revoked",
    );
    expect(revoked.alsoRevoked.map((entry) => [entry.subject, entry.cut])).toEqual([
      [east.id(), 3],
    ]);
    expect(cutOf(north, south.id())).toBe(3);
    expect(cutOf(north, east.id())).toBe(3);
    // A computer outside the revoked one's subtree cannot ride along.
    const other = computer({ store: selected(store) });
    await joinThrough(other, north, "Other");
    expect(
      await north.service.execute({ kind: "revoke", subject: west.id(), alsoRevoke: [other.id()] }),
    ).toMatchObject({ kind: "refused", reason: "not-a-descendant" });
  });

  it("cuts by default at the revoked computer's last signed entry, an artifact entry included", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    // South's sequence 3 is an artifact version, which no host holds yet.
    await writeRecord(store, south.credentials, artifactEntry(south, 3));
    const preview = expectKind(
      await north.service.execute({ kind: "revoke-preview", subject: south.id() }),
      "revoke-preview",
    );
    expect(preview.cut).toBe(3);
    expect(north.projection.state().heldSequence(south.id())).toBe(2);
    expect(
      await north.service.execute({ kind: "revoke", subject: south.id(), cut: 4 }),
    ).toMatchObject({ kind: "refused", reason: "invalid-cut" });
    const revoked = expectKind(
      await north.service.execute({ kind: "revoke", subject: south.id() }),
      "revoked",
    );
    expect(revoked.entry.cut).toBe(3);
  });

  it("shows the revocations a computer already wrote, so its cut can move before them", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    await joinThrough(east, south, "Studio");
    const southRevokes = expectKind(
      await south.service.execute({ kind: "revoke", subject: east.id() }),
      "revoked",
    );
    const preview = expectKind(
      await north.service.execute({ kind: "revoke-preview", subject: south.id() }),
      "revoke-preview",
    );
    expect(preview.subjectRevocations).toEqual([
      { sequence: southRevokes.entry.origin.sequence, subject: east.id(), cut: 2 },
    ]);
    expectKind(
      await north.service.execute({
        kind: "revoke",
        subject: south.id(),
        cut: southRevokes.entry.origin.sequence - 1,
      }),
      "revoked",
    );
    expect(cutOf(north, east.id())).toBeUndefined();
  });

  it("says which revocations landed when a later one in the same step stops", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    const west = computer({ store: selected(store) });
    await joinThrough(east, south, "Studio");
    await joinThrough(west, south, "Laptop");
    await north.service.execute({ kind: "pull" });
    const next = north.projection.state().localSequence + 1;
    store.failNextPut = `${north.id()}/${next + 1}.json`;
    const outcome = expectKind(
      await north.service.execute({
        kind: "revoke",
        subject: south.id(),
        alsoRevoke: [east.id(), west.id()],
      }),
      "revoked-in-part",
    );
    expect(outcome.entry.subject).toBe(south.id());
    expect(outcome.alsoRevoked).toEqual([]);
    expect(outcome.notRevoked).toEqual([east.id(), west.id()]);
    expect(cutOf(north, south.id())).toBeDefined();
    expect(cutOf(north, east.id())).toBeUndefined();
  });

  it("lets a person move the cut earlier, which removes what the revoked computer approved after it", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    await joinThrough(east, south, "Studio");
    expect(
      await north.service.execute({ kind: "revoke", subject: south.id(), cut: 4 }),
    ).toMatchObject({ kind: "refused", reason: "invalid-cut" });
    expectKind(
      await north.service.execute({ kind: "revoke", subject: south.id(), cut: 2 }),
      "revoked",
    );
    expect(memberIds(north)).not.toContain(String(east.id()));
  });

  it("lets only an ancestor revoke, and keeps an ancestor able to answer a revocation from below", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    await joinThrough(east, north, "Studio");
    await south.service.execute({ kind: "pull" });
    // A sibling, and a computer revoking the one that approved it, are refused.
    expect(await south.service.execute({ kind: "revoke", subject: east.id() })).toMatchObject({
      kind: "refused",
      reason: "not-a-descendant",
    });
    expect(await south.service.execute({ kind: "revoke", subject: north.id() })).toMatchObject({
      kind: "refused",
      reason: "not-a-descendant",
    });
    // A stolen South signs a revocation of the founder anyway; it never counts.
    await writeRecord(
      store,
      south.credentials,
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "revocation",
        origin: originOf(south, nextSequence(store, south.id())),
        subject: north.id(),
        cut: 0,
      }),
    );
    await north.service.execute({ kind: "pull" });
    expect(cutOf(north, north.id())).toBeUndefined();
    expectKind(await north.service.execute({ kind: "revoke", subject: south.id() }), "revoked");
  });

  it("does not let a second approval, with the member's key or another, change its key or parent", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    await joinThrough(east, north, "Studio");
    await south.service.execute({ kind: "pull" });
    const southKey = south.projection.state().local?.publicKey ?? "";
    const eastKey = east.projection.state().local?.publicKey ?? "";
    // South approves East again with East's real key, then names its own key for East.
    for (const subjectKey of [eastKey, southKey]) {
      await writeRecord(
        store,
        south.credentials,
        decodeReplicaMembershipEntry({
          format: REPLICA_ENTRY_FORMAT,
          kind: "join-approved",
          origin: originOf(south, nextSequence(store, south.id())),
          subject: east.id(),
          subjectKey,
          subjectName: "Studio",
        }),
      );
    }
    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    // The approval naming another key is not a valid record at all.
    expect(pulled.refused).toEqual([
      { instanceId: south.id(), sequence: 4, reason: "bad-signature" },
    ]);
    const eastOnNorth = north.projection
      .state()
      .members.find((member) => String(member.instanceId) === String(east.id()));
    expect(eastOnNorth?.publicKey).toBe(eastKey);
    expect(eastOnNorth?.parent).toBe(north.id());
    expect(await south.service.execute({ kind: "revoke", subject: east.id() })).toMatchObject({
      reason: "not-a-descendant",
    });
  });

  it("confirms through the founder its approver's edges reach, whatever other founders the store holds", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const stranger = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    await stranger.service.execute({ kind: "create-replica", displayName: "Stranger" });
    const south = computer({ store: selected(store) });
    await joinThrough(south, north, "Mac mini");
    // The stranger's founder approves South too, and the store holds both founders.
    const southKey = south.projection.state().local?.publicKey ?? "";
    await writeRecord(
      store,
      stranger.credentials,
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-approved",
        origin: originOf(stranger, 2),
        subject: south.id(),
        subjectKey: southKey,
        subjectName: "Mac mini",
      }),
    );
    const east = computer({ store: selected(store) });
    const { confirmed } = await joinThrough(east, south, "Studio");
    expect(confirmed.founder).toBe(north.id());
    expect(east.projection.state().founder?.instanceId).toBe(north.id());
  });

  it("applies the founder's revocations on a computer a non-founder approved", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    const west = computer({ store: selected(store) });
    await joinThrough(east, south, "Studio");
    await joinThrough(west, east, "Laptop");
    expectKind(
      await north.service.execute({ kind: "revoke", subject: east.id(), cut: 2 }),
      "revoked",
    );
    await west.service.execute({ kind: "pull" });
    expect(cutOf(west, east.id())).toBe(2);
    expect(memberIds(west)).not.toContain(String(west.id()));
  });

  it("starts a new identity with its own key and sequence when a revoked computer asks again", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const oldId = south.id();
    await north.service.execute({ kind: "revoke", subject: oldId });
    await south.service.execute({ kind: "pull" });
    expect(cutOf(south, oldId)).toBe(2);
    const again = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    expect(again.instanceId).not.toBe(oldId);
    expect(again.entry.origin.sequence).toBe(1);
    expect(south.projection.state().localSequence).toBe(1);
    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.joinRequests.map((entry) => entry.origin.instanceId)).toEqual([again.instanceId]);
  });

  it("treats an old key as the old identity: it cannot come back under another id or be approved again", async () => {
    const store = memoryStore();
    const { north, south, request } = await joinedPair(store);
    await north.service.execute({ kind: "revoke", subject: south.id() });
    // The same request under the old id is the revoked identity.
    const refused = await north.service.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: codeFor(request.entry, north),
    });
    expect(refused).toMatchObject({ kind: "refused", reason: "revoked-instance" });
    // The old key filed under another id is not a valid record.
    const otherId = "0aaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa" as ReplicaInstanceId;
    const forged = decodeReplicaMembershipEntry({
      ...request.entry,
      origin: { ...request.entry.origin, instanceId: otherId },
    });
    const bytes = new TextEncoder().encode(encodeReplicaEntry(forged));
    const signature = signedText(
      await makeReplicaDeviceSigner(south.credentials, south.id()).sign(bytes),
    );
    store.files.set(`${otherId}/1.json`, bytes);
    store.files.set(`${otherId}/1.sig`, new TextEncoder().encode(signature));
    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toContainEqual({
      instanceId: otherId,
      sequence: 1,
      reason: "bad-signature",
    });
    expect(pulled.joinRequests).toEqual([]);
  });

  it("asks to join again as a new identity after a cut removed the approval that admitted it", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    await joinThrough(east, south, "Studio");
    const oldId = east.id();
    await north.service.execute({ kind: "revoke", subject: south.id(), cut: 2 });
    await east.service.execute({ kind: "pull" });
    expect(memberIds(east)).not.toContain(String(oldId));
    expect(
      await east.service.execute({
        kind: "confirm-join",
        approver: south.id(),
        confirmationCode: "000000",
      }),
    ).toMatchObject({ kind: "refused", reason: "revoked-instance" });
    const again = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    expect(again.instanceId).not.toBe(oldId);
  });

  it("refuses a join confirmation through an approval a revocation in the store already cut", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    const request = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    await south.service.execute({ kind: "pull" });
    const code = codeFor(request.entry, south);
    expectKind(
      await south.service.execute({
        kind: "approve-join",
        joinRequest: request.entry,
        confirmationCode: code,
      }),
      "join-approved",
    );
    await north.service.execute({ kind: "revoke", subject: south.id(), cut: 2 });
    const outcome = await east.service.execute({
      kind: "confirm-join",
      approver: south.id(),
      confirmationCode: code,
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "revoked-instance" });
    // Nothing was published, so this identity can still be approved by someone else.
    expect(store.files.has(`${east.id()}/2.json`)).toBe(false);
  });

  it("refuses a join confirmation before the approver has published an approval", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const south = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const request = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    const outcome = await south.service.execute({
      kind: "confirm-join",
      approver: north.id(),
      confirmationCode: codeFor(request.entry, north),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "unknown-instance" });
    expect(south.projection.state().members).toEqual([]);
  });

  it("refuses a join confirmation whose code does not match what the store says", async () => {
    const store = memoryStore();
    const { north } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    const request = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    await north.service.execute({ kind: "pull" });
    const code = codeFor(request.entry, north);
    expectKind(
      await north.service.execute({
        kind: "approve-join",
        joinRequest: request.entry,
        confirmationCode: code,
      }),
      "join-approved",
    );
    const outcome = await east.service.execute({
      kind: "confirm-join",
      approver: north.id(),
      confirmationCode: code === "000000" ? "000001" : "000000",
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "code-mismatch" });
    expect(store.files.has(`${east.id()}/2.json`)).toBe(false);
  });

  it("holds a later record while an earlier one from the same computer is missing", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    await joinThrough(east, south, "Studio");
    const west = computer({ store: selected(store) });
    await joinThrough(west, south, "Laptop");
    // South's approval of East (its sequence 3) never reached the store North reads.
    store.files.delete(`${south.id()}/3.json`);
    store.files.delete(`${south.id()}/3.sig`);
    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toEqual([]);
    expect(memberIds(north)).toContain(String(west.id()));
    expect(memberIds(north)).not.toContain(String(east.id()));
  });

  it("refuses a file whose bytes were changed after signing, and still holds what comes after it", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    await joinThrough(east, south, "Studio");
    const path = `${south.id()}/2.json`;
    const original = new TextDecoder().decode(store.files.get(path));
    store.files.set(path, new TextEncoder().encode(original.replace("Mac mini", "Mac mimi")));
    const late = computer({ store: selected(store) });
    await joinThrough(late, north, "Late");
    const pulled = expectKind(await late.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toEqual([
      { instanceId: south.id(), sequence: 2, reason: "bad-signature" },
    ]);
    // South's accept is unreadable here, so South and the computer it approved are not members.
    expect(memberIds(late)).not.toContain(String(south.id()));
    expect(late.projection.state().holds(south.id(), 3)).toBe(true);
  });

  it("refuses a file whose signature is missing, and journals that once", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const south = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    store.files.delete(`${south.id()}/1.sig`);
    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toEqual([
      { instanceId: south.id(), sequence: 1, reason: "bad-signature" },
    ]);
    await north.service.execute({ kind: "pull" });
    expect(
      north.events().filter((e) => e.eventName === REPLICA_MEMBERSHIP_EVENT_NAMES.entryUnreadable),
    ).toHaveLength(1);
  });

  it("refuses a validly signed record in a non-canonical form, and keeps reading the store", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const south = computer({ store: selected(store) });
    const east = computer({ store: selected(store) });
    const west = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    await east.service.execute({ kind: "write-join-request", displayName: "Studio" });
    await west.service.execute({ kind: "write-join-request", displayName: "Laptop" });
    // South re-signs its request padded past the size a held record may have.
    const southPath = `${south.id()}/1`;
    const padded = new TextEncoder().encode(
      `${new TextDecoder().decode(store.files.get(`${southPath}.json`))}${" ".repeat(70_000)}`,
    );
    const paddedSignature = signedText(
      await makeReplicaDeviceSigner(south.credentials, south.id()).sign(padded),
    );
    store.files.set(`${southPath}.json`, padded);
    store.files.set(`${southPath}.sig`, new TextEncoder().encode(paddedSignature));
    // West's signature still decodes to the same 64 bytes, but not as their canonical text.
    const westSignature = `${new TextDecoder().decode(store.files.get(`${west.id()}/1.sig`))}\n`;
    store.files.set(`${west.id()}/1.sig`, new TextEncoder().encode(westSignature));

    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toEqual(
      expect.arrayContaining([
        { instanceId: south.id(), sequence: 1, reason: "unreadable" },
        { instanceId: west.id(), sequence: 1, reason: "bad-signature" },
      ]),
    );
    expect(north.projection.state().holds(south.id(), 1)).toBe(false);
    expect(north.projection.state().holds(west.id(), 1)).toBe(false);
    expect(north.projection.state().holds(east.id(), 1)).toBe(true);
    expectKind(await north.service.execute({ kind: "pull" }), "pulled");
  });

  it("refuses a file filed under a path its body does not name", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const south = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    const elsewhere = "0bbbbbbb-bbbb-8bbb-8bbb-bbbbbbbbbbbb";
    for (const suffix of ["json", "sig"]) {
      const bytes = store.files.get(`${south.id()}/1.${suffix}`);
      if (bytes !== undefined) store.files.set(`${elsewhere}/1.${suffix}`, bytes);
    }
    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.refused).toEqual([
      { instanceId: elsewhere, sequence: 1, reason: "path-mismatch" },
    ]);
    expect(pulled.applied).toBe(1);
  });

  it("refuses a pull whose store listing does not end inside the bound", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
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
        create: () => Promise.reject(new Error("unused")),
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

  it("skips a slot someone else's file already holds, and publishes in the next one", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    store.files.set(`${north.id()}/3.json`, new TextEncoder().encode("not mine"));
    store.files.set(`${north.id()}/3.sig`, new TextEncoder().encode("taken"));
    const revoked = expectKind(
      await north.service.execute({ kind: "revoke", subject: south.id() }),
      "revoked",
    );
    expect(revoked.entry.origin.sequence).toBe(4);
    expect(north.projection.state().localSequence).toBe(4);
    const failure = north
      .events()
      .find((e) => e.eventName === REPLICA_MEMBERSHIP_EVENT_NAMES.storeFailure);
    expect(failure?.payload).toMatchObject({ reason: "slot-occupied", sequence: 3 });
    await south.service.execute({ kind: "pull" });
    expect(cutOf(south, south.id())).toBe(2);
  });

  it("stops publishing with a visible error when every slot it may skip is taken", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    for (let sequence = 3; sequence < 3 + REPLICA_MAX_SQUATTED_SLOTS; sequence += 1) {
      store.files.set(`${north.id()}/${sequence}.sig`, new TextEncoder().encode("taken"));
    }
    const outcome = expectKind(
      await north.service.execute({ kind: "revoke", subject: south.id() }),
      "store-failed",
    );
    expect(outcome.message).toContain("did not write");
    expect(store.files.has(`${north.id()}/${3 + REPLICA_MAX_SQUATTED_SLOTS}.json`)).toBe(false);
  });

  it("finishes a publish that stopped after its signature landed, keeping the sequence usable", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    store.failNextPut = `${north.id()}/3.json`;
    expect((await north.service.execute({ kind: "revoke", subject: south.id() })).kind).toBe(
      "store-failed",
    );
    expect(store.files.has(`${north.id()}/3.sig`)).toBe(true);
    expect(north.projection.state().pending?.origin.sequence).toBe(3);
    const east = computer({ store: selected(store) });
    const request = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    await north.service.execute({ kind: "pull" });
    const approved = expectKind(
      await north.service.execute({
        kind: "approve-join",
        joinRequest: request.entry,
        confirmationCode: codeFor(request.entry, north),
      }),
      "join-approved",
    );
    const northKey = north.projection.state().local?.publicKey ?? "";
    expect(verifiesAt(store, `${north.id()}/3`, northKey)).toBe(true);
    expect(approved.entry.origin.sequence).toBe(4);
    expect(cutOf(north, south.id())).toBe(2);
    expect(north.projection.state().pending).toBeUndefined();
  });

  it("drops a revoked identity's stopped publish instead of finishing it", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    const eastRequest = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    await south.service.execute({ kind: "pull" });
    const oldId = south.id();
    store.failNextPut = `${oldId}/3.json`;
    const failed = await south.service.execute({
      kind: "approve-join",
      joinRequest: eastRequest.entry,
      confirmationCode: codeFor(eastRequest.entry, south),
    });
    expect(failed.kind).toBe("store-failed");
    expectKind(await north.service.execute({ kind: "revoke", subject: oldId }), "revoked");
    await south.service.execute({ kind: "pull" });
    expect(south.projection.state().pending).toBeUndefined();
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    expect(store.files.has(`${oldId}/3.json`)).toBe(false);
  });

  it("rebuilds the same membership, pending publish, and diagnostics when the journal is replayed", async () => {
    const store = memoryStore();
    const { north, south } = await joinedPair(store);
    const east = computer({ store: selected(store) });
    await east.service.execute({ kind: "write-join-request", displayName: "Studio" });
    store.files.delete(`${east.id()}/1.sig`);
    await north.service.execute({ kind: "pull" });
    store.failNextPut = `${north.id()}/3.json`;
    expect((await north.service.execute({ kind: "revoke", subject: south.id() })).kind).toBe(
      "store-failed",
    );
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
        expect(after.founder).toEqual(before.founder);
        expect(after.membership).toEqual(before.membership);
        expect(after.localSequence).toBe(before.localSequence);
        expect(after.pending).toEqual(before.pending);
        expect(after.joinRequests).toEqual(before.joinRequests);
      }
    }
    const rebuilt = new ReplicaMembershipProjection();
    catchUpProjection({
      connection: north.connection,
      journal: north.journal,
      projection: rebuilt,
      clock: () => NOW_ISO,
    });
    expect(rebuilt.state().pending?.origin.sequence).toBe(3);
    expect(
      rebuilt
        .state()
        .unreadableRecorded({ instanceId: east.id(), sequence: 1, reason: "bad-signature" }),
    ).toBe(true);
  });

  it("refuses an approval when the matching codes do not agree", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const south = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const request = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    const code = codeFor(request.entry, north);
    const outcome = await north.service.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: code === "000000" ? "000001" : "000000",
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "code-mismatch" });
    expect(store.files.has(`${north.id()}/2.json`)).toBe(false);
  });

  it("refuses an approval from a computer that is not a member", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const south = computer({ store: selected(store) });
    const east = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    const request = expectKind(
      await east.service.execute({ kind: "write-join-request", displayName: "Studio" }),
      "join-requested",
    );
    const outcome = await south.service.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: "123456",
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "not-a-member" });
  });

  it("refuses an approval for a join request that is not in the store", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const south = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const request = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    store.files.delete(`${south.id()}/1.json`);
    const outcome = await north.service.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: codeFor(request.entry, north),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "unknown-instance" });
  });

  it("refuses an approval of a copy that differs from the stored, signed request", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const south = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const request = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    const renamed = decodeReplicaMembershipEntry({
      ...request.entry,
      origin: { ...request.entry.origin, displayName: "Somebody else" },
    });
    if (renamed.kind !== "join-request") throw new Error("not a join request");
    const outcome = await north.service.execute({
      kind: "approve-join",
      joinRequest: renamed,
      confirmationCode: codeFor(renamed, north),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "code-mismatch" });
  });

  it("refuses an approval whose join request is no longer fresh", async () => {
    const store = memoryStore();
    let now = NOW;
    const north = computer({ store: selected(store), now: () => now });
    const south = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    const request = expectKind(
      await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" }),
      "join-requested",
    );
    now = NOW + REPLICA_JOIN_REQUEST_TTL_MS + 1;
    const pulled = expectKind(await north.service.execute({ kind: "pull" }), "pulled");
    expect(pulled.joinRequests).toEqual([]);
    const outcome = await north.service.execute({
      kind: "approve-join",
      joinRequest: request.entry,
      confirmationCode: codeFor(request.entry, north),
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "expired-join-request" });
  });

  it("refuses to revoke a computer that is not a member", async () => {
    const store = memoryStore();
    const north = computer({ store: selected(store) });
    const south = computer({ store: selected(store) });
    await north.service.execute({ kind: "create-replica", displayName: "MacBook" });
    await south.service.execute({ kind: "write-join-request", displayName: "Mac mini" });
    const outcome = await north.service.execute({ kind: "revoke", subject: south.id() });
    expect(outcome).toMatchObject({ kind: "refused", reason: "unknown-instance" });
    expect(store.files.has(`${north.id()}/2.json`)).toBe(false);
  });
});
