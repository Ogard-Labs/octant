import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { startCredentialBroker, type CredentialStore } from "@octant/host-runtime";
import { EventActor, LOCAL_HOST_ID, ReplayCursor, type UtcTimestamp } from "@octant/contracts";
import type { ReplicaStoreSettingsResult } from "@octant/contracts/replica-store-settings";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { makeReplicaStoreCredentialBrokerClient } from "../providers/credentialBrokerClient";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { createReplicaDeviceKey, makeReplicaDeviceSigner } from "./replicaDeviceKeyService";
import {
  createReplicaMembershipJournal,
  registerReplicaMembershipEvents,
  ReplicaMembershipProjection,
} from "./replicaMembershipProjection";
import { ReplicaMembershipService } from "./replicaMembershipService";
import { registerReplicaStoreSettingsEvents } from "./replicaStoreSettingsEvents";
import { ReplicaStoreSettingsService } from "./replicaStoreSettingsService";
import { S3_PROBE_KEY_PREFIX, type S3Transport, type S3TransportRequest } from "./s3ReplicaStore";
import {
  SYNCED_FOLDER_PROBE_DIRECTORY,
  SYNCED_FOLDER_REPLICA_DIRECTORY,
} from "./syncedFolderReplicaStore";

const NOW = "2026-10-07T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const bucket = {
  endpoint: "https://s3.example.test",
  region: "eu-north-1",
  bucket: "octant-sync",
  addressing: "path",
} as const;

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(parent: string): string {
  const directory = realpathSync(mkdtempSync(join(parent, "octant-sync-settings-")));
  directories.push(directory);
  return directory;
}

function connection(): SqliteConnection {
  const opened = openSqlite(join(scratch(tmpdir()), "events.sqlite3"));
  applyMigrations(opened, MIGRATIONS, () => NOW);
  return opened;
}

/** A credential store that keeps what it is given and counts every call. */
function memoryCredentials(options: { readonly failSet?: boolean } = {}) {
  const values = new Map<string, string>();
  const calls: string[] = [];
  const store: CredentialStore = {
    async set(id, credential) {
      calls.push(`set:${id}`);
      if (options.failSet === true) throw new Error("locked");
      values.set(id, credential);
    },
    async has(id) {
      calls.push(`has:${id}`);
      return values.has(id);
    },
    async resolve(id) {
      calls.push(`resolve:${id}`);
      const value = values.get(id);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    async delete(id) {
      calls.push(`delete:${id}`);
      values.delete(id);
    },
  };
  return { store, values, calls };
}

function host(
  openConnection: SqliteConnection,
  options: {
    readonly credentials?: CredentialStore;
    readonly s3Transport?: S3Transport;
  } = {},
) {
  const membershipProjection = new ReplicaMembershipProjection();
  const journal = new Journal({
    connection: openConnection,
    registry: registerReplicaStoreSettingsEvents(
      registerReplicaMembershipEvents(new EventRegistry()),
    ),
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(membershipProjection),
    clock: () => NOW,
  });
  let uuid = 0;
  const nextUuid = () => {
    uuid += 1;
    return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
  };
  const settings = new ReplicaStoreSettingsService({
    journal,
    uuid: nextUuid,
    actor,
    clock: () => NOW as UtcTimestamp,
    home: homedir(),
    standingOutsideApproval: false,
    credentials: options.credentials,
    ...(options.s3Transport === undefined ? {} : { s3Transport: options.s3Transport }),
    readFileFlags: async () => 0,
  });
  const deviceKeys = memoryCredentials().store;
  const membership = new ReplicaMembershipService({
    store: () => settings.selection(),
    credentials: {
      create: () => createReplicaDeviceKey(deviceKeys),
      sign: (instanceId, payload) => makeReplicaDeviceSigner(deviceKeys, instanceId).sign(payload),
    },
    journal: createReplicaMembershipJournal({
      journal,
      uuid: nextUuid,
      clock: () => NOW,
      actor: { kind: "local-user", actorId: "77777777-7777-4777-8777-777777777777" },
    }),
    state: () => membershipProjection.state(),
    localHostId: LOCAL_HOST_ID,
    clock: () => Date.parse(NOW),
  });
  const journalText = () =>
    JSON.stringify(
      journal.replay(Schema.decodeUnknownSync(ReplayCursor)({ afterSequence: 0, limit: 1_000 })),
    );
  return { settings, membership, journalText };
}

function expectView(result: ReplicaStoreSettingsResult) {
  if (result.kind !== "replica-store-settings-view") {
    throw new Error(`expected a view, got ${JSON.stringify(result)}`);
  }
  return result;
}

function syncFolder(): string {
  const folder = scratch(homedir());
  return folder;
}

/** A bucket that keeps objects and honours a conditional create. */
function bucketServer() {
  const requests: S3TransportRequest[] = [];
  const objects = new Map<string, Uint8Array>();
  let answer: number | undefined;
  const transport: S3Transport = async (request) => {
    requests.push(request);
    if (answer !== undefined) return { status: answer, body: new Uint8Array() };
    const key = new URL(request.url).pathname;
    if (request.method === "PUT") {
      if (request.headers["if-none-match"] === "*" && objects.has(key)) {
        return { status: 412, body: new Uint8Array() };
      }
      objects.set(key, request.body ?? new Uint8Array());
      return { status: 200, body: new Uint8Array() };
    }
    const bytes = objects.get(key);
    return bytes === undefined
      ? { status: 404, body: new Uint8Array() }
      : { status: 200, body: bytes };
  };
  return {
    requests,
    objects,
    transport,
    answerWith: (status: number) => {
      answer = status;
    },
  };
}

describe("replica store settings", () => {
  it("starts with no store and sync off, so membership commands answer not-configured", async () => {
    const { settings, membership } = host(connection());

    expect(settings.settings()).toMatchObject({ store: { kind: "none" }, syncOn: false });
    expect(settings.selection()).toEqual({ status: "not-configured" });
    expect(
      await membership.execute({ kind: "create-replica", displayName: "MacBook" }),
    ).toMatchObject({ kind: "refused", reason: "not-configured" });
  });

  it("remembers the chosen folder and sync after a restart", async () => {
    const opened = connection();
    const folder = syncFolder();
    const first = host(opened);
    const chosen = expectView(await first.settings.chooseFolder({ folder, expectedVersion: 0 }));
    expect(chosen.store).toEqual({ kind: "synced-folder", folder });
    expect(chosen.syncOn).toBe(false);
    expect(
      expectView(await first.settings.setSync({ syncOn: true, expectedVersion: chosen.version }))
        .syncOn,
    ).toBe(true);

    const restarted = host(opened);
    expect(restarted.settings.settings()).toMatchObject({
      store: { kind: "synced-folder", folder },
      syncOn: true,
      version: 2,
    });
    expect(restarted.settings.selection().status).toBe("selected");
  });

  it("hands the membership service the chosen folder once sync is on", async () => {
    const folder = syncFolder();
    const { settings, membership } = host(connection());
    const chosen = expectView(await settings.chooseFolder({ folder, expectedVersion: 0 }));

    // Chosen but off: still no store call, and nothing is written.
    expect(
      await membership.execute({ kind: "create-replica", displayName: "MacBook" }),
    ).toMatchObject({ kind: "refused", reason: "not-configured" });
    expect(existsSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY))).toBe(false);

    await settings.setSync({ syncOn: true, expectedVersion: chosen.version });
    const created = await membership.execute({ kind: "create-replica", displayName: "MacBook" });
    if (created.kind !== "replica-created") {
      throw new Error(`expected a replica, got ${JSON.stringify(created)}`);
    }
    expect(
      readdirSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, String(created.instanceId))).sort(),
    ).toEqual(["1.json", "1.sig"]);
  });

  it("turns sync off when the store changes", async () => {
    const { settings } = host(connection());
    const chosen = expectView(
      await settings.chooseFolder({ folder: syncFolder(), expectedVersion: 0 }),
    );
    const on = expectView(
      await settings.setSync({ syncOn: true, expectedVersion: chosen.version }),
    );

    const moved = expectView(
      await settings.chooseFolder({ folder: syncFolder(), expectedVersion: on.version }),
    );
    expect(moved.syncOn).toBe(false);
    expect(settings.selection()).toEqual({ status: "not-configured" });
  });

  it("refuses turning sync on with no store", async () => {
    const { settings } = host(connection());
    expect(await settings.setSync({ syncOn: true, expectedVersion: 0 })).toMatchObject({
      kind: "replica-store-refused",
      reason: "not-configured",
    });
    expect(settings.settings().syncOn).toBe(false);
  });

  it("refuses a change made against a version that has moved on", async () => {
    const { settings } = host(connection());
    await settings.chooseFolder({ folder: syncFolder(), expectedVersion: 0 });
    expect(await settings.clear({ expectedVersion: 0 })).toMatchObject({
      kind: "replica-store-refused",
      reason: "stale-version",
    });
  });

  it("refuses a folder outside the home folder", async () => {
    const { settings } = host(connection());
    expect(
      await settings.chooseFolder({ folder: scratch(tmpdir()), expectedVersion: 0 }),
    ).toMatchObject({ kind: "replica-store-refused", reason: "outside-home" });
  });

  it("keeps a bucket's key pair only in the credential store", async () => {
    const credentials = memoryCredentials();
    const { settings, journalText } = host(connection(), { credentials: credentials.store });

    const view = expectView(
      await settings.configureS3({
        settings: bucket,
        credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET },
        expectedVersion: 0,
      }),
    );

    expect(view.store).toEqual({ kind: "s3", settings: bucket, credentials: "saved" });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(journalText()).not.toContain(SECRET);
    expect(journalText()).not.toContain("AKIAEXAMPLE");
    const store = settings.settings().store;
    if (store.kind !== "s3") throw new Error("expected a bucket");
    expect(JSON.parse(credentials.values.get(store.credentialRef) ?? "{}")).toEqual({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: SECRET,
    });
  });

  it("saves a bucket's key pair through the broker where no provider credential can reach it", async () => {
    const providers = memoryCredentials();
    const deviceKeys = memoryCredentials();
    const bucketKeys = memoryCredentials();
    const broker = await startCredentialBroker(
      providers.store,
      undefined,
      undefined,
      deviceKeys.store,
      bucketKeys.store,
    );
    try {
      const credentials = makeReplicaStoreCredentialBrokerClient({
        url: broker.url,
        token: broker.token,
        fetch: async (input, init) => broker.fetchForTest(new Request(input, init)),
      });
      const { settings } = host(connection(), { credentials });

      const saved = expectView(
        await settings.configureS3({
          settings: bucket,
          credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET },
          expectedVersion: 0,
        }),
      );
      expect(saved.store).toEqual({ kind: "s3", settings: bucket, credentials: "saved" });
      const store = settings.settings().store;
      if (store.kind !== "s3") throw new Error("expected a bucket");
      expect([...bucketKeys.values.keys()]).toEqual([store.credentialRef]);
      expect(providers.values.size).toBe(0);
      expect(deviceKeys.values.size).toBe(0);

      // A new key pair for the same bucket replaces the saved one.
      const replaced = expectView(
        await settings.configureS3({
          settings: bucket,
          credentials: { accessKeyId: "AKIAREPLACED", secretAccessKey: SECRET },
          expectedVersion: saved.version,
        }),
      );
      expect(JSON.parse(bucketKeys.values.get(store.credentialRef) ?? "{}")).toMatchObject({
        accessKeyId: "AKIAREPLACED",
      });

      await settings.clear({ expectedVersion: replaced.version });
      expect(bucketKeys.values.size).toBe(0);
    } finally {
      await broker.close();
    }
  });

  it("keeps the saved key pair when only the bucket's settings change", async () => {
    const credentials = memoryCredentials();
    const { settings } = host(connection(), { credentials: credentials.store });
    const first = expectView(
      await settings.configureS3({
        settings: bucket,
        credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET },
        expectedVersion: 0,
      }),
    );
    const ref = settings.settings().store;

    const edited = expectView(
      await settings.configureS3({
        settings: { ...bucket, prefix: "laptop" },
        expectedVersion: first.version,
      }),
    );

    expect(edited.store).toMatchObject({ credentials: "saved", settings: { prefix: "laptop" } });
    expect(settings.settings().store).toMatchObject({
      credentialRef: ref.kind === "s3" ? ref.credentialRef : "",
    });
    expect(credentials.calls.filter((call) => call.startsWith("set:"))).toHaveLength(1);
  });

  it("asks for a key pair before it saves a new bucket", async () => {
    const credentials = memoryCredentials();
    const { settings } = host(connection(), { credentials: credentials.store });
    expect(await settings.configureS3({ settings: bucket, expectedVersion: 0 })).toMatchObject({
      kind: "replica-store-refused",
      reason: "credentials-required",
    });
  });

  it("refuses to save a bucket when the credential store cannot keep the key pair", async () => {
    const unavailable = host(connection());
    expect(
      await unavailable.settings.configureS3({
        settings: bucket,
        credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET },
        expectedVersion: 0,
      }),
    ).toMatchObject({ kind: "replica-store-refused", reason: "credential-store-unavailable" });

    const locked = host(connection(), { credentials: memoryCredentials({ failSet: true }).store });
    expect(
      await locked.settings.configureS3({
        settings: bucket,
        credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET },
        expectedVersion: 0,
      }),
    ).toMatchObject({ kind: "replica-store-refused", reason: "credential-store-unavailable" });
    expect(locked.settings.settings().store).toEqual({ kind: "none" });
  });

  it("removes a bucket's key pair once another store is chosen", async () => {
    const credentials = memoryCredentials();
    const { settings } = host(connection(), { credentials: credentials.store });
    const saved = expectView(
      await settings.configureS3({
        settings: bucket,
        credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET },
        expectedVersion: 0,
      }),
    );

    await settings.clear({ expectedVersion: saved.version });

    expect(credentials.values.size).toBe(0);
  });

  it("writes one probe file in the chosen folder and nothing while sync is off", async () => {
    const folder = syncFolder();
    const { settings } = host(connection());
    const chosen = expectView(await settings.chooseFolder({ folder, expectedVersion: 0 }));

    expect(await settings.testConnection()).toMatchObject({ outcome: "sync-off" });
    expect(existsSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY))).toBe(false);

    await settings.setSync({ syncOn: true, expectedVersion: chosen.version });
    expect(await settings.testConnection()).toMatchObject({ outcome: "reachable" });
    expect(
      readdirSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, SYNCED_FOLDER_PROBE_DIRECTORY)),
    ).toHaveLength(1);
  });

  it("reports a missing sync folder instead of creating it", async () => {
    const parent = syncFolder();
    const folder = join(parent, "Synced");
    mkdirSync(folder);
    const { settings } = host(connection());
    const chosen = expectView(await settings.chooseFolder({ folder, expectedVersion: 0 }));
    await settings.setSync({ syncOn: true, expectedVersion: chosen.version });
    rmSync(folder, { recursive: true });

    expect(await settings.testConnection()).toMatchObject({ outcome: "not-connected" });
    expect(existsSync(folder)).toBe(false);
  });

  it("proves a bucket with one probe object over https and reports a refused key", async () => {
    const server = bucketServer();
    const credentials = memoryCredentials();
    const { settings } = host(connection(), {
      credentials: credentials.store,
      s3Transport: server.transport,
    });
    const saved = expectView(
      await settings.configureS3({
        settings: bucket,
        credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET },
        expectedVersion: 0,
      }),
    );

    expect(await settings.testConnection()).toMatchObject({ outcome: "sync-off" });
    expect(server.requests).toHaveLength(0);

    await settings.setSync({ syncOn: true, expectedVersion: saved.version });
    expect(await settings.testConnection()).toMatchObject({ outcome: "reachable" });
    expect(server.requests).toHaveLength(1);
    const probe = server.requests[0];
    expect(probe?.method).toBe("PUT");
    expect(
      probe?.url.startsWith(`https://s3.example.test/octant-sync/${S3_PROBE_KEY_PREFIX}`),
    ).toBe(true);
    expect(JSON.stringify(probe?.headers)).not.toContain(SECRET);

    server.answerWith(403);
    expect(await settings.testConnection()).toMatchObject({ outcome: "unauthorized" });
  });
});
