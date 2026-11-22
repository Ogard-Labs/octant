import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeWindowId, type EventActor } from "@octant/contracts";
import {
  ACCESS_ACTIVITY_PATH,
  CHANGE_NOTICE_ACTION_PATHS,
  CHANGE_NOTICES_PATH,
} from "@octant/contracts/access-activity";
import type {
  DeviceAccessLevel,
  DeviceId,
  RemoteSessionId,
  StableHostId,
} from "@octant/contracts/remote-access";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_ACCESS_ORIGIN, createRemoteDevicePrincipal } from "../clientPrincipal";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  createAccessActivityRouteHandler,
  type AccessActivityRouteDependencies,
} from "./accessActivityRoutes";

const now = "2026-11-22T20:00:00.000Z";
const hostId = "11111111-1111-4111-8111-111111111111";
const phone = "22222222-2222-4222-8222-222222222222";
const tablet = "33333333-3333-4333-8333-333333333333";
const localActorId = "44444444-4444-4444-8444-444444444444";
const providerId = "55555555-5555-4555-8555-555555555555";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const bridgeSecret = "desktop-bridge-secret";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");

const local: EventActor = { kind: "local-user", actorId: localActorId } as EventActor;
const byDevice = (deviceId: string) =>
  ({ kind: "remote-device", actorId: deviceId, deviceId }) as EventActor;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function host() {
  const directory = mkdtempSync(join(tmpdir(), "octant-access-activity-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const append = (
    aggregateType: string,
    aggregateId: string,
    eventName: string,
    actor: EventActor,
    payload: unknown,
  ) =>
    journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion: version(connection, aggregateType, aggregateId),
      events: [
        {
          eventId: randomUUID(),
          eventName,
          eventVersion: 1,
          correlationId: randomUUID(),
          actor,
          occurredAt: now,
          payload,
        },
      ],
    }).events[0]?.eventId;
  return { connection, journal, runtime, append };
}

function version(connection: SqliteConnection, type: string, id: string): number {
  const row = connection
    .prepare(
      "SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
    )
    .get(type, id) as { readonly aggregate_version: number } | undefined;
  return row?.aggregate_version ?? 0;
}

type Host = ReturnType<typeof host>;

function pair(target: Host, deviceId: string, label: string, actor: EventActor) {
  target.append("remote-device", deviceId, "remote.device-registered@1", actor, {
    device: {
      hostId,
      deviceId,
      deviceKeyFingerprint: "b".repeat(64),
      devicePublicKey: "public-key",
      deviceLabel: label,
      origin: "https://mac.example.test",
      protocolFloor: 1,
      credentialGeneration: 1,
      createdAt: now,
      expiresAt: "2027-10-26T20:00:00.000Z",
      lastSeenAt: now,
      state: "active",
    },
  });
  target.append("remote-device", deviceId, "remote.security-audit-recorded@1", actor, {
    record: {
      eventKind: "device-approved",
      hostId,
      deviceId,
      protocolVersion: 1,
      credentialGeneration: 1,
      sourceClass: "lan-private",
      resultCategory: "approved",
      reasonCode: "user-approved",
      correlationId: randomUUID(),
      occurredAt: now,
      accessLevel: "full",
    },
  });
}

function raise(
  target: Host,
  actor: EventActor,
  from: string,
  to: string,
  threadId = "66666666-6666-4666-8666-666666666666",
) {
  return target.append("guardrail-change", randomUUID(), "guardrail.level-lowered@1", actor, {
    scope: "thread",
    surface: "code",
    from,
    to,
    threadId,
  });
}

function keyChange(
  target: Host,
  actor: EventActor,
  keyChange?: { readonly kind: "added"; readonly keyId: string } | { readonly kind: "replaced" },
) {
  const requestId = randomUUID();
  const common = { requestId, instanceId: providerId, action: "set" };
  const noticeId = target.append("provider-key", providerId, "provider-key.recorded@1", actor, {
    name: "provider-key.change-requested",
    ...common,
    instanceVersion: 1,
    windowId: actor.kind === "remote-device" ? actor.deviceId : String(windowId),
    ...(keyChange === undefined
      ? {}
      : {
          keyChange: keyChange.kind,
          ...(keyChange.kind === "added" ? { keyId: keyChange.keyId } : {}),
        }),
  });
  target.append("provider-key", providerId, "provider-key.recorded@1", actor, {
    name: "provider-key.change-completed",
    ...common,
    outcome: "stored",
  });
  return noticeId;
}

interface Calls {
  readonly setLevel: Array<{ readonly level: string; readonly actor: EventActor }>;
  readonly removed: Array<{ readonly keyId: string; readonly actor: EventActor }>;
  readonly revoked: string[];
  readonly ended: string[];
}

function routes(target: Host, overrides: Partial<AccessActivityRouteDependencies> = {}) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const calls: Calls = { setLevel: [], removed: [], revoked: [], ended: [] };
  const handler = createAccessActivityRouteHandler({
    connection: target.connection,
    journal: target.journal,
    windowAuthorityStore: store,
    desktopBridgeSecret: bridgeSecret,
    names: { threadTitle: () => "Fix login", providerName: () => "Anthropic" },
    threadLevel: () => "full-access",
    setThreadLevel: async (input) => {
      calls.setLevel.push({ level: input.level, actor: input.actor });
      return { status: "done" };
    },
    removeKey: async (input) => {
      calls.removed.push({ keyId: input.keyId, actor: input.actor });
      return { status: "done" };
    },
    revokeDevice: (deviceId) => {
      calls.revoked.push(deviceId);
      return { status: "done" };
    },
    endAgentGrant: (grantId) => {
      calls.ended.push(grantId);
      return { status: "done" };
    },
    now: () => 0,
    ...overrides,
  });
  return { handler, calls };
}

function fromWindow(path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-octant-window-capability": capability, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The desktop's own host-local caller: the bridge secret, a window capability, and no Origin. */
function fromDesktopBridge(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "x-octant-window-capability": capability,
      "x-octant-desktop-secret": bridgeSecret,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function fromDevice(
  path: string,
  deviceId: string,
  options: { readonly accessLevel?: DeviceAccessLevel; readonly origin?: string } = {},
  body?: unknown,
): Request {
  const request = new Request(`http://127.0.0.1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  bindPrincipalRouteContext(request, {
    principal: createRemoteDevicePrincipal({
      hostId: hostId as StableHostId,
      deviceId: deviceId as DeviceId,
      credentialGeneration: 1,
      origin: options.origin ?? "https://octant.example",
      protocolVersion: 1,
      capabilityDigest: "b".repeat(64),
      sessionId: "77777777-7777-4777-8777-777777777777" as RemoteSessionId,
      admittedBy: "host-person",
      ...(options.accessLevel === undefined ? {} : { accessLevel: options.accessLevel }),
    }),
    scopeId: decodeWindowId(deviceId),
  });
  return request;
}

async function notices(
  handler: (request: Request) => Promise<Response | undefined>,
  request: Request,
) {
  const response = await handler(request);
  expect(response?.status).toBe(200);
  return ((await response?.json()) as { notices: ReadonlyArray<Record<string, unknown>> }).notices;
}

describe("access activity", () => {
  it("lists devices added, re-levelled and removed, newest first, naming who did each", async () => {
    const target = host();
    pair(target, phone, "Ada's phone", { kind: "system", actorId: localActorId } as EventActor);
    pair(target, tablet, "Tablet", byDevice(phone));
    target.append("remote-device", tablet, "remote.device-access-level-changed@1", local, {
      hostId,
      deviceId: tablet,
      previousLevel: "full",
      accessLevel: "read-only",
      changedAt: now,
    });
    target.append("remote-host", hostId, "remote.device-revoked@1", byDevice(phone), {
      hostId,
      deviceId: tablet,
      credentialGeneration: 2,
      revokedAt: now,
      reasonCode: "local-device-revoked",
    });
    const { handler } = routes(target);

    const response = await handler(fromWindow(ACCESS_ACTIVITY_PATH));
    expect(response?.status).toBe(200);
    const { entries } = (await response?.json()) as {
      entries: ReadonlyArray<Record<string, unknown>>;
    };
    expect(
      entries.map(({ kind, deviceLabel, actor, previousLevel, accessLevel, reason }) => ({
        kind,
        deviceLabel,
        actor,
        ...(previousLevel === undefined ? {} : { previousLevel }),
        ...(accessLevel === undefined ? {} : { accessLevel }),
        ...(reason === undefined ? {} : { reason }),
      })),
    ).toEqual([
      {
        kind: "removed",
        deviceLabel: "Tablet",
        reason: "revoked",
        actor: { kind: "device", deviceId: phone, label: "Ada's phone" },
      },
      {
        kind: "relevelled",
        deviceLabel: "Tablet",
        previousLevel: "full",
        accessLevel: "read-only",
        actor: { kind: "local-person" },
      },
      {
        kind: "added",
        deviceLabel: "Tablet",
        accessLevel: "full",
        actor: { kind: "device", deviceId: phone, label: "Ada's phone" },
      },
      {
        kind: "added",
        deviceLabel: "Ada's phone",
        accessLevel: "full",
        actor: { kind: "local-person" },
      },
    ]);
    // A Full device reads it as the person does.
    expect((await handler(fromDevice(ACCESS_ACTIVITY_PATH, phone)))?.status).toBe(200);
  });

  it("refuses a device paired below Full and an agent grant", async () => {
    const target = host();
    const { handler } = routes(target);
    expect(
      (await handler(fromDevice(ACCESS_ACTIVITY_PATH, phone, { accessLevel: "approve-and-steer" })))
        ?.status,
    ).toBe(403);
    expect(
      (await handler(fromDevice(ACCESS_ACTIVITY_PATH, phone, { origin: AGENT_ACCESS_ORIGIN })))
        ?.status,
    ).toBe(403);
    expect(
      (await handler(fromDevice(CHANGE_NOTICES_PATH, phone, { accessLevel: "read-only" })))?.status,
    ).toBe(403);
  });
});

describe("change notices", () => {
  it("raises one notice when a paired device raises a thread, none for a window's raise or a lowering", async () => {
    const target = host();
    pair(target, phone, "Ada's phone", local);
    pair(target, tablet, "Tablet", local);
    raise(target, byDevice(phone), "ask-first", "full-access");
    raise(target, local, "ask-first", "full-access");
    raise(target, byDevice(phone), "full-access", "auto");
    raise(target, byDevice(phone), "auto", "accept-edits");
    const { handler } = routes(target);

    const shown = await notices(handler, fromWindow(CHANGE_NOTICES_PATH));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      kind: "thread-level-raised",
      actor: { kind: "device", label: "Ada's phone" },
      surface: "code",
      threadTitle: "Fix login",
      from: "ask-first",
      to: "full-access",
    });
    // Another Full device sees it; the device that made the change does not.
    expect(await notices(handler, fromDevice(CHANGE_NOTICES_PATH, tablet))).toHaveLength(1);
    expect(await notices(handler, fromDevice(CHANGE_NOTICES_PATH, phone))).toHaveLength(0);
  });

  it("raises a notice for a key a paired device added or replaced, carrying no secret", async () => {
    const target = host();
    pair(target, phone, "Ada's phone", local);
    keyChange(target, byDevice(phone), { kind: "added", keyId: randomUUID() });
    keyChange(target, byDevice(phone), { kind: "replaced" });
    keyChange(target, local, { kind: "added", keyId: randomUUID() });
    keyChange(target, byDevice(phone));
    const { handler } = routes(target);

    const shown = await notices(handler, fromWindow(CHANGE_NOTICES_PATH));
    expect(shown.map((notice) => notice.kind)).toEqual([
      "provider-key-replaced",
      "provider-key-added",
    ]);
    for (const notice of shown) {
      expect(Object.keys(notice).sort()).toEqual([
        "actor",
        "at",
        "kind",
        "noticeId",
        "providerInstanceId",
        "providerName",
      ]);
    }
  });

  it("puts a raised thread back as whoever pressed Undo, and refuses once the level changed again", async () => {
    const target = host();
    pair(target, phone, "Ada's phone", local);
    const noticeId = raise(target, byDevice(phone), "ask-first", "full-access");
    const moved = routes(target, { threadLevel: () => "auto" });
    const refused = await moved.handler(fromWindow(CHANGE_NOTICE_ACTION_PATHS.undo, { noticeId }));
    expect(refused?.status).toBe(409);
    expect(moved.calls.setLevel).toEqual([]);

    const { handler, calls } = routes(target);
    const undone = await handler(fromWindow(CHANGE_NOTICE_ACTION_PATHS.undo, { noticeId }));
    expect(undone?.status).toBe(200);
    expect(calls.setLevel).toEqual([
      { level: "ask-first", actor: expect.objectContaining({ kind: "local-user" }) },
    ]);
    expect(await notices(handler, fromWindow(CHANGE_NOTICES_PATH))).toEqual([]);
  });

  it("removes exactly the added key on Undo, and offers none for a replaced key or a key changed since", async () => {
    const target = host();
    pair(target, phone, "Ada's phone", local);
    const keyId = randomUUID();
    const added = keyChange(target, byDevice(phone), { kind: "added", keyId });
    const replaced = keyChange(target, byDevice(phone), { kind: "replaced" });
    const { handler, calls } = routes(target);

    expect(
      (await handler(fromDesktopBridge(CHANGE_NOTICE_ACTION_PATHS.undo, { noticeId: replaced })))
        ?.status,
    ).toBe(409);
    // The replace came after the add, so the add's Undo is refused too.
    expect(
      (await handler(fromDesktopBridge(CHANGE_NOTICE_ACTION_PATHS.undo, { noticeId: added })))
        ?.status,
    ).toBe(409);
    expect(calls.removed).toEqual([]);

    const fresh = randomUUID();
    const latest = keyChange(target, byDevice(phone), { kind: "added", keyId: fresh });
    // The read names the key while Undo can still remove exactly it, and no longer once changed.
    const listed = await notices(handler, fromWindow(CHANGE_NOTICES_PATH));
    expect(listed.find((notice) => notice.noticeId === latest)).toMatchObject({ keyId: fresh });
    expect(listed.find((notice) => notice.noticeId === added)?.keyId).toBeUndefined();
    expect(
      (await handler(fromDesktopBridge(CHANGE_NOTICE_ACTION_PATHS.undo, { noticeId: latest })))
        ?.status,
    ).toBe(200);
    expect(calls.removed.map((call) => call.keyId)).toEqual([fresh]);
  });

  it("holds a window's key Undo and revoke to the desktop bridge secret, as the routes they stand in for", async () => {
    const target = host();
    pair(target, phone, "Ada's phone", local);
    const keyNotice = keyChange(target, byDevice(phone), { kind: "added", keyId: randomUUID() });
    const raised = raise(target, byDevice(phone), "ask-first", "full-access");
    const { handler, calls } = routes(target);

    for (const [path, noticeId] of [
      [CHANGE_NOTICE_ACTION_PATHS.undo, keyNotice],
      [CHANGE_NOTICE_ACTION_PATHS.revoke, raised],
    ] as const) {
      expect((await handler(fromWindow(path, { noticeId })))?.status).toBe(403);
      const withOrigin = fromDesktopBridge(path, { noticeId });
      withOrigin.headers.set("origin", "http://127.0.0.1:5173");
      expect((await handler(withOrigin))?.status).toBe(403);
    }
    expect(calls.removed).toEqual([]);
    expect(calls.revoked).toEqual([]);
    // A thread level's Undo runs the thread's own level command, which a window may run.
    expect(
      (await handler(fromWindow(CHANGE_NOTICE_ACTION_PATHS.undo, { noticeId: raised })))?.status,
    ).toBe(200);
    expect(
      (await handler(fromDesktopBridge(CHANGE_NOTICE_ACTION_PATHS.revoke, { noticeId: keyNotice })))
        ?.status,
    ).toBe(200);
    expect(calls.revoked).toEqual([phone]);
  });

  it("revokes the device that made the change", async () => {
    const target = host();
    pair(target, phone, "Ada's phone", local);
    pair(target, tablet, "Tablet", local);
    const noticeId = raise(target, byDevice(phone), "plan", "ask-first");
    const { handler, calls } = routes(target);

    const response = await handler(
      fromDevice(CHANGE_NOTICE_ACTION_PATHS.revoke, tablet, {}, { noticeId }),
    );
    expect(response?.status).toBe(200);
    expect(calls.revoked).toEqual([phone]);
    expect(await notices(handler, fromWindow(CHANGE_NOTICES_PATH))).toEqual([]);
  });

  it("keeps a dismissal across a projection rebuild and a fresh host process", async () => {
    const target = host();
    pair(target, phone, "Ada's phone", local);
    const noticeId = raise(target, byDevice(phone), "ask-first", "auto");
    const { handler } = routes(target);
    expect(
      (await handler(fromWindow(CHANGE_NOTICE_ACTION_PATHS.dismiss, { noticeId })))?.status,
    ).toBe(200);
    expect(
      target.connection
        .prepare("SELECT COUNT(*) AS count FROM event_journal WHERE event_name = ?")
        .get("access-notice.dismissed@1"),
    ).toEqual({ count: 1 });

    const projection = target.runtime.projections.get("remote-access");
    if (projection === undefined) throw new Error("remote-access projection missing");
    rebuildProjection({
      connection: target.connection,
      journal: target.journal,
      projection,
      clock: () => now,
    });
    const restarted = routes(target);
    expect(await notices(restarted.handler, fromWindow(CHANGE_NOTICES_PATH))).toEqual([]);
    expect(await notices(restarted.handler, fromDevice(CHANGE_NOTICES_PATH, tablet))).toEqual([]);
  });
});
