import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { Journal } from "../persistence/journal";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  createPushNotificationTokenStore,
  PUSH_REGISTRATIONS_FILE,
  pushDestinationStands,
  pushRegistrationClearReasonFor,
} from "./pushNotificationTokenStore";

const hostId = "11111111-1111-4111-8111-111111111111";
const phone = "22222222-2222-4222-8222-222222222222";
const tablet = "33333333-3333-4333-8333-333333333333";
const hostActorId = "00000000-0000-4000-8000-000000000002";
const now = "2026-10-26T12:00:00.000Z";
const phoneKey = "MJaD3ARvNKlDGKOdP1uw2ORQnq9V7CJeVRT9Xg09h3E";
const otherKey = "hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo";
const allKinds = {
  approvalNeeded: true,
  waiting: true,
  failure: true,
  completion: true,
  threadTitles: false,
};
const keyed = { notificationPublicKey: phoneKey, preferences: allKinds };
const directories: string[] = [];
const connections: SqliteConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function host(dataDirectory = mkdtempSync(join(tmpdir(), "octant-push-registrations-"))) {
  directories.push(dataDirectory);
  const connection = openSqlite(join(dataDirectory, "store.sqlite3"));
  connections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  let counter = 0;
  const open = () =>
    createPushNotificationTokenStore({
      dataDirectory,
      journal,
      hostActorId,
      uuid: () => `44444444-4444-4444-8444-${String(++counter).padStart(12, "0")}`,
    });
  const journaled = () =>
    connection
      .prepare(
        "SELECT event_name, payload_json, actor_json FROM event_journal WHERE aggregate_type = 'remote-push-registration' ORDER BY global_sequence",
      )
      .all() as ReadonlyArray<{
      readonly event_name: string;
      readonly payload_json: string;
      readonly actor_json: string | null;
    }>;
  return { dataDirectory, connection, journal, open, journaled };
}

describe("push registrations on the host", () => {
  it("keeps a registration across a restart in an owner-only file the journal never holds the token of", () => {
    const first = host();
    const store = first.open();
    expect(
      store.register({
        hostId,
        deviceId: phone,
        platform: "ios",
        token: "apns-secret-1",
        ...keyed,
        now,
      }),
    ).toEqual({ result: "registered" });

    const restarted = first.open();
    expect(restarted.get({ hostId, deviceId: phone })).toEqual({
      hostId,
      deviceId: phone,
      platform: "ios",
      token: "apns-secret-1",
      notificationPublicKey: phoneKey,
      preferences: allKinds,
      collapseKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      updatedAt: now,
    });
    const file = join(first.dataDirectory, PUSH_REGISTRATIONS_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(first.dataDirectory, "remote")).mode & 0o777).toBe(0o700);

    const events = first.journaled();
    expect(events.map((event) => event.event_name)).toEqual([
      "remote.push-registration-recorded@1",
    ]);
    expect(JSON.parse(events[0]?.payload_json ?? "{}")).toEqual({
      hostId,
      deviceId: phone,
      platform: "ios",
      change: "added",
      recordedAt: now,
    });
    expect(JSON.stringify(events)).not.toContain("apns-secret-1");
    expect(JSON.stringify(events)).not.toContain(phoneKey);
  });

  it("keeps the phone's notification key and preferences with its token, and journals a change of either without them", () => {
    const { open, journaled, dataDirectory } = host();
    const store = open();
    const base = { hostId, deviceId: phone, platform: "ios" as const, token: "phone-token", now };
    expect(store.register({ ...base, ...keyed })).toEqual({ result: "registered" });
    const collapseKey = store.get({ hostId, deviceId: phone })?.collapseKey;
    expect(
      store.register({ ...base, ...keyed, preferences: { ...allKinds, threadTitles: true } }),
    ).toEqual({ result: "registered" });
    expect(
      store.register({
        ...base,
        notificationPublicKey: otherKey,
        preferences: { ...allKinds, threadTitles: true },
      }),
    ).toEqual({ result: "registered" });
    expect(
      store.register({
        ...base,
        notificationPublicKey: otherKey,
        preferences: { ...allKinds, threadTitles: true },
      }),
    ).toEqual({ result: "already-registered" });

    const restarted = open().get({ hostId, deviceId: phone });
    expect(restarted).toMatchObject({
      notificationPublicKey: otherKey,
      preferences: { ...allKinds, threadTitles: true },
    });
    // A changed registration keeps its collapse key, so an update still
    // replaces the notification it updates on the phone.
    expect(restarted?.collapseKey).toBe(collapseKey);

    const events = journaled();
    expect(
      events.map((event) => (JSON.parse(event.payload_json) as Record<string, unknown>).change),
    ).toEqual(["added", "changed", "changed"]);
    const journal = JSON.stringify(events);
    for (const secret of [phoneKey, otherKey, collapseKey ?? "missing", "phone-token"]) {
      expect(journal).not.toContain(secret);
    }
    const stored = readFileSync(join(dataDirectory, PUSH_REGISTRATIONS_FILE), "utf8");
    expect(stored).toContain(otherKey);
    expect(stored).not.toContain(phoneKey);
  });

  it("narrows a remote folder another remote file left open before it writes a token there", () => {
    const { dataDirectory, open } = host();
    // The host identity key creates `remote/` with the process umask's mode.
    mkdirSync(join(dataDirectory, "remote"), { mode: 0o755 });
    chmodSync(join(dataDirectory, "remote"), 0o755);
    open().register({
      hostId,
      deviceId: phone,
      platform: "ios",
      token: "phone-token",
      ...keyed,
      now,
    });
    expect(statSync(join(dataDirectory, "remote")).mode & 0o777).toBe(0o700);
  });

  it("writes the token only into its own owner-only file when a crashed write left a link in the staging place", () => {
    const { dataDirectory, open } = host();
    mkdirSync(join(dataDirectory, "remote"), { mode: 0o700 });
    const elsewhere = join(dataDirectory, "elsewhere.json");
    writeFileSync(elsewhere, "", { mode: 0o644 });
    const file = join(dataDirectory, PUSH_REGISTRATIONS_FILE);
    symlinkSync(elsewhere, `${file}.${process.pid}.tmp`);

    open().register({
      hostId,
      deviceId: phone,
      platform: "ios",
      token: "phone-token",
      ...keyed,
      now,
    });

    expect(readFileSync(elsewhere, "utf8")).toBe("");
    expect(statSync(elsewhere).mode & 0o777).toBe(0o644);
    expect(lstatSync(file).isFile()).toBe(true);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(open().get({ hostId, deviceId: phone })?.token).toBe("phone-token");
  });

  it("journals an add, a change, and a clear once each, and a repeat of any of them not at all", () => {
    const { open, journaled, dataDirectory } = host();
    const store = open();
    const base = { hostId, deviceId: phone, platform: "ios" as const, ...keyed, now };
    expect(store.register({ ...base, token: "token-a" })).toEqual({ result: "registered" });
    expect(store.register({ ...base, token: "token-a" })).toEqual({
      result: "already-registered",
    });
    expect(store.register({ ...base, token: "token-b" })).toEqual({ result: "registered" });
    expect(store.clear({ hostId, deviceId: phone, reason: "device-cleared", now })).toEqual({
      result: "cleared",
    });
    expect(store.clear({ hostId, deviceId: phone, reason: "device-cleared", now })).toEqual({
      result: "already-cleared",
    });

    const events = journaled();
    expect(
      events.map((event) => {
        const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        return payload.change ?? payload.reason;
      }),
    ).toEqual(["added", "changed", "device-cleared"]);
    expect(JSON.parse(events[2]?.actor_json ?? "{}")).toMatchObject({
      kind: "remote-device",
      deviceId: phone,
    });
    expect(JSON.stringify(events)).not.toMatch(/token-[ab]/);
    expect(existsSync(join(dataDirectory, PUSH_REGISTRATIONS_FILE))).toBe(false);
    expect(open().get({ hostId, deviceId: phone })).toBeUndefined();
  });

  it("isolates tokens across devices on the same host", () => {
    const store = host().open();
    store.register({
      hostId,
      deviceId: phone,
      platform: "ios",
      token: "phone-token",
      ...keyed,
      now,
    });
    store.register({
      hostId,
      deviceId: tablet,
      platform: "android",
      token: "tablet-token",
      ...keyed,
      now,
    });
    store.clear({ hostId, deviceId: phone, reason: "device-revoked", now });
    expect(store.get({ hostId, deviceId: tablet })?.token).toBe("tablet-token");
    expect(store.listDeviceIdsForHost(hostId)).toEqual([tablet]);
  });

  it("clears the registration of a device that no longer stands, as the host", () => {
    const { open, journaled } = host();
    const store = open();
    store.register({
      hostId,
      deviceId: phone,
      platform: "ios",
      token: "phone-token",
      ...keyed,
      now,
    });
    store.register({
      hostId,
      deviceId: tablet,
      platform: "android",
      token: "tablet-token",
      ...keyed,
      now,
    });

    expect(
      store.clearWithoutStanding({
        hasStanding: (_registeredHostId, deviceId) => deviceId === tablet,
        now,
      }),
    ).toBe(1);
    expect(store.listDeviceIdsForHost(hostId)).toEqual([tablet]);
    const cleared = journaled().at(-1);
    expect(JSON.parse(cleared?.payload_json ?? "{}")).toMatchObject({
      deviceId: phone,
      reason: "device-without-standing",
    });
    expect(JSON.parse(cleared?.actor_json ?? "{}")).toEqual({
      kind: "system",
      actorId: hostActorId,
    });
  });

  it("keeps no token the journal refused to record", () => {
    const { dataDirectory, journal, connection } = host();
    const store = createPushNotificationTokenStore({
      dataDirectory,
      journal: {
        aggregateVersions: (type) => journal.aggregateVersions(type),
        // The file is written inside the append, and the commit then fails.
        append: (_input, options) => {
          options?.beforeEvents?.(connection);
          expect(existsSync(join(dataDirectory, PUSH_REGISTRATIONS_FILE))).toBe(true);
          throw new Error("journal unavailable");
        },
      },
      hostActorId,
      uuid: () => "44444444-4444-4444-8444-000000000001",
    });
    expect(() =>
      store.register({
        hostId,
        deviceId: phone,
        platform: "ios",
        token: "refused-token",
        ...keyed,
        now,
      }),
    ).toThrow();
    expect(store.get({ hostId, deviceId: phone })).toBeUndefined();
    expect(existsSync(join(dataDirectory, PUSH_REGISTRATIONS_FILE))).toBe(false);
  });

  it("starts with no registrations from a file it cannot read back exactly", () => {
    const first = host();
    first
      .open()
      .register({ hostId, deviceId: phone, platform: "ios", token: "phone-token", ...keyed, now });
    const file = join(first.dataDirectory, PUSH_REGISTRATIONS_FILE);
    writeFileSync(file, readFileSync(file, "utf8").replace('"ios"', '"windows"'));
    expect(first.open().listDestinations()).toEqual([]);
  });

  it("keeps a registration through a key rotation or a listener stop, and clears it on every other credential change", () => {
    expect(pushRegistrationClearReasonFor("credential-rotated")).toBeUndefined();
    expect(pushRegistrationClearReasonFor("credentials-rotated-all")).toBeUndefined();
    expect(pushRegistrationClearReasonFor("listener-disabled")).toBeUndefined();
    expect(pushRegistrationClearReasonFor("signed-out")).toBe("signed-out");
    expect(pushRegistrationClearReasonFor("self-revoked")).toBe("self-revoked");
    expect(pushRegistrationClearReasonFor("pairing-abandoned")).toBe("pairing-abandoned");
    expect(pushRegistrationClearReasonFor("credential-expired")).toBe("credential-expired");
    expect(pushRegistrationClearReasonFor("local-device-revoked")).toBe("device-revoked");
    expect(pushRegistrationClearReasonFor("host-key-recovered")).toBe("device-revoked");
    expect(pushRegistrationClearReasonFor("a-reason-added-later")).toBe("device-revoked");
  });

  it("lets a notification go only to a device whose record under that host is active and unexpired", () => {
    const device = {
      host_id: hostId,
      device_id: phone,
      state: "active",
      expires_at: "2026-11-26T12:00:00.000Z",
    };
    const asked = { hostId, deviceId: phone, now };
    expect(pushDestinationStands([device], asked)).toBe(true);
    expect(pushDestinationStands([{ ...device, state: "revoked" }], asked)).toBe(false);
    expect(pushDestinationStands([{ ...device, state: "expired" }], asked)).toBe(false);
    expect(pushDestinationStands([{ ...device, expires_at: now }], asked)).toBe(false);
    expect(pushDestinationStands([{ ...device, host_id: "local" }], asked)).toBe(false);
    expect(pushDestinationStands([], asked)).toBe(false);
  });
});
