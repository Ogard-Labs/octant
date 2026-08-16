import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CANVAS_SCHEMA_VERSION,
  CANVAS_SHARE_MAX_ACCESS_LOG_EVENTS,
  CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS,
  CanvasCreated,
  CanvasVersionAppended,
  decodeCanvasId,
  decodeCanvasVersion,
  type CanvasShareAccessLogEvent,
  type CanvasVersion,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { CANVAS_CREATED, CANVAS_VERSION_APPENDED } from "./canvasEventStore";
import { CanvasProjection } from "./canvasProjection";
import {
  CANVAS_SHARE_ACCESS_LOGGED,
  CANVAS_SHARE_SNAPSHOT_CREATED,
  CANVAS_SHARE_SNAPSHOT_REVOKED,
  CanvasShareEventStore,
  registerCanvasShareEvents,
} from "./canvasShareEventStore";
import { CanvasShareService } from "./canvasShareService";
import { createRemoteDevicePrincipal, type ClientPrincipal } from "../clientPrincipal";

const directories: Array<string> = [];
const createdAt = "2026-08-01T21:00:00.000Z";

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  project: "66666666-6666-4666-8666-666666666666",
  thread: "77777777-7777-4777-8777-777777777777",
  provider: "88888888-8888-4888-8888-888888888888",
  owner: "99999999-9999-4999-8999-999999999999",
  outsider: "12121212-1212-4121-8121-121212121212",
  device: "13131313-1313-4131-8131-131313131313",
  window: "14141414-1414-4141-8141-141414141414",
  session: "15151515-1515-4151-8151-151515151515",
  snapshot: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  export: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  quietCanvas: "16161616-1616-4161-8161-161616161616",
  quietVersion: "17171717-1717-4171-8171-171717171717",
} as const;

const canvasId = decodeCanvasId(ids.canvas);
const quietCanvasId = decodeCanvasId(ids.quietCanvas);
const project = { id: ids.project, type: "chat", lifecycle: "active" } as const;
const context = { mode: "chat", projectId: ids.project } as const;

const provenance = {
  mode: "chat",
  hostId: "local",
  projectId: ids.project,
  threadId: ids.thread,
  actor: { kind: "local-user", actorId: ids.owner },
  providerInstanceId: ids.provider,
  modelId: "octant-test-model",
  createdAt,
} as const;

function currentVersion(
  overrides: { readonly canvasId?: string; readonly versionId?: string } = {},
): CanvasVersion {
  return decodeCanvasVersion({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId: overrides.canvasId ?? ids.canvas,
    versionId: overrides.versionId ?? ids.version,
    sequence: 1,
    definition: {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      title: "Shared canvas",
      provenance,
      sourceManifest: [],
      blocks: [
        {
          blockId: "block-1",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "heading",
          level: 1,
          text: "A bounded Canvas",
        },
      ],
    },
    createdBy: provenance.actor,
    createdAt,
  });
}

function shareRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "canvas-share-snapshot",
    snapshotId: ids.snapshot,
    exportId: ids.export,
    canvasId: ids.canvas,
    versionId: ids.version,
    expectedSequence: 1,
    hostId: "local",
    projectId: ids.project,
    audience: {
      ownerActorId: ids.owner,
      principals: [{ label: "This device", principalKind: "local-user", principalId: ids.owner }],
    },
    expiresAt: "2026-08-02T21:00:00.000Z",
    refreshPolicy: "manual-only",
    consent: {
      acknowledgedAuthenticatedSnapshot: true,
      acknowledgedOwnerVisibleAudience: true,
      acknowledgedAt: "2026-08-01T21:05:00.000Z",
      acknowledgedBy: { kind: "local-user", actorId: ids.owner },
    },
    ...overrides,
  };
}

/** The host-authenticated local window this owner reads their own share from. */
const localPrincipal = {
  kind: "local-window",
  windowId: ids.window,
  capabilityGeneration: 0,
} as const satisfies ClientPrincipal;

/** A paired remote device the gateway already authenticated for this host. */
const devicePrincipal = createRemoteDevicePrincipal({
  hostId: "local" as never,
  deviceId: ids.device as never,
  credentialGeneration: 1,
  origin: "https://octant.invalid",
  protocolVersion: 1,
  capabilityDigest: "a".repeat(64),
  sessionId: ids.session as never,
});

/** A distinct snapshot id per mint, so one Canvas can hold many share rows. */
function mintedSnapshotId(index: number): string {
  return `dddddddd-dddd-4ddd-8ddd-${index.toString(16).padStart(12, "0")}`;
}

function revokeRequest() {
  return {
    schemaVersion: 1,
    kind: "canvas-share-snapshot-revoke",
    snapshotId: ids.snapshot,
    canvasId: ids.canvas,
    hostId: "local",
    projectId: ids.project,
    actor: { kind: "local-user", actorId: ids.owner },
    revokedAt: "2026-08-01T22:00:00.000Z",
  };
}

function accessRequest() {
  return {
    schemaVersion: 1,
    kind: "canvas-share-access",
    snapshotId: ids.snapshot,
    canvasId: ids.canvas,
    hostId: "local",
    projectId: ids.project,
  };
}

let accessEventCounter = 0;

/** A journaled access history for one Canvas, oldest first. */
function accessHistory(canvas: string, count: number): Array<CanvasShareAccessLogEvent> {
  const events: Array<CanvasShareAccessLogEvent> = [];
  for (let index = 0; index < count; index += 1) {
    accessEventCounter += 1;
    events.push({
      schemaVersion: 1,
      kind: "canvas-share-access-log",
      eventId: `eeeeeeee-eeee-4eee-8eee-${accessEventCounter.toString(16).padStart(12, "0")}`,
      snapshotId: ids.snapshot,
      canvasId: canvas,
      hostId: "local",
      projectId: ids.project,
      occurredAt: createdAt,
      outcome: "allowed",
      browserFamily: "other",
    } as never);
  }
  return events;
}

/**
 * A store that replays a given access history. Journaling a history this long
 * through SQLite would say nothing more about how replay rebuilds it.
 */
function replayingStore(
  accessEvents: ReadonlyArray<CanvasShareAccessLogEvent>,
): CanvasShareEventStore {
  return { replay: () => ({ records: [], accessEvents }) } as never;
}

interface Harness {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly projection: CanvasProjection;
  readonly clock: { value: string };
  readonly service: CanvasShareService;
  readonly rebuild: (options?: {
    readonly authorized?: boolean;
    readonly sharingEnabled?: boolean;
    readonly eventStore?: CanvasShareEventStore;
  }) => CanvasShareService;
  readonly shareEventNames: () => ReadonlyArray<string>;
}

function harness(
  options: { readonly authorized?: boolean; readonly sharingEnabled?: boolean } = {},
): Harness {
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-share-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => createdAt);
  const projection = new CanvasProjection();
  const registry = registerCanvasShareEvents(
    new EventRegistry()
      .register(CANVAS_CREATED, 1, CanvasCreated)
      .register(CANVAS_VERSION_APPENDED, 1, CanvasVersionAppended),
  );
  const projections = new ProjectionRegistry()
    .register(new AggregateHeadsProjection())
    .register(projection);
  const journal = new Journal({
    connection,
    registry,
    projections,
    clock: () => createdAt as never,
  });
  projection.applyCreated({ canvasId, version: currentVersion() });
  const clock = { value: "2026-08-01T21:05:01.000Z" };
  const actor = Schema.decodeUnknownSync(EventActor)({
    kind: "local-user",
    actorId: ids.owner,
  });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    return `dddddddd-dddd-4ddd-8ddd-${counter.toString(16).padStart(12, "0")}`;
  };
  const build = (
    overrides: {
      authorized?: boolean;
      sharingEnabled?: boolean;
      eventStore?: CanvasShareEventStore;
    } = {},
  ) =>
    new CanvasShareService(
      {
        projection,
        eventStore: overrides.eventStore ?? new CanvasShareEventStore({ journal, uuid, actor }),
        uuid,
        clock: () => clock.value as never,
        hostId: "local",
        owner: { kind: "local-user", actorId: ids.owner },
        sharingEnabled: overrides.sharingEnabled ?? options.sharingEnabled ?? true,
      },
      { authorize: () => overrides.authorized ?? options.authorized ?? true },
    );
  return {
    connection,
    journal,
    projection,
    clock,
    service: build(),
    rebuild: (rebuildOptions) => build(rebuildOptions ?? {}),
    shareEventNames: () =>
      journal
        .replay({ afterSequence: 0, limit: 1_000 } as never)
        .map((envelope) => envelope.eventName)
        .filter((name) => name.startsWith("canvas.share")),
  };
}

describe("CanvasShareService", () => {
  it("admits an owner-consented snapshot and lists it for the owner", () => {
    const { service } = harness();

    const result = service.share(shareRequest(), context, project, localPrincipal);

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.snapshot.status).toBe("active");
    expect(result.snapshot.versionId).toBe(ids.version);
    const overview = service.overview(canvasId, context, project);
    expect(overview?.sharingEnabled).toBe(true);
    expect(overview?.owner.actorId).toBe(ids.owner);
    expect(overview?.snapshots).toHaveLength(1);
    // The listing never re-serves the shared payload.
    expect(JSON.stringify(overview?.snapshots)).not.toContain("A bounded Canvas");
  });

  it("refuses to share a canvas the caller has no authority over, before any side effect", () => {
    const { service, shareEventNames } = harness({ authorized: false });

    const result = service.share(shareRequest(), context, project, localPrincipal);

    expect(result).toMatchObject({ kind: "denied", denialCode: "unauthorized" });
    expect(shareEventNames()).toHaveLength(0);
  });

  it("fails closed when the host does not share, leaving local canvas use alone", () => {
    const { service, shareEventNames } = harness({ sharingEnabled: false });

    const result = service.share(shareRequest(), context, project, localPrincipal);

    expect(result).toMatchObject({ kind: "denied", denialCode: "sharing-disabled" });
    expect(shareEventNames()).toHaveLength(0);
    expect(service.overview(canvasId, context, project)?.sharingEnabled).toBe(false);
  });

  it("serves the snapshot to its audience and refuses it after revocation", () => {
    const { service, shareEventNames } = harness();
    service.share(shareRequest(), context, project, localPrincipal);

    const allowed = service.access({
      request: accessRequest(),
      userAgent: "Mozilla/5.0 Safari/1",
      principal: localPrincipal,
    });
    expect(allowed.kind).toBe("allowed");
    if (allowed.kind !== "allowed") return;
    expect(allowed.document.title).toBe("Shared canvas");
    expect(allowed.event.outcome).toBe("allowed");
    // The raw user agent never reaches the record.
    expect(allowed.event.browserFamily).toBe("safari");
    expect(JSON.stringify(allowed.event)).not.toContain("Mozilla");

    const revoked = service.revoke(revokeRequest(), context, project, localPrincipal);
    expect(revoked).toMatchObject({ kind: "accepted" });

    const denied = service.access({ request: accessRequest(), principal: localPrincipal });
    expect(denied).toMatchObject({ kind: "denied", outcome: "denied-revoked" });
    expect(shareEventNames()).toEqual([
      CANVAS_SHARE_SNAPSHOT_CREATED,
      CANVAS_SHARE_ACCESS_LOGGED,
      CANVAS_SHARE_SNAPSHOT_REVOKED,
      CANVAS_SHARE_ACCESS_LOGGED,
    ]);
  });

  /**
   * A host journals an access event for every evaluated read, so a long-lived
   * host accumulates far more of them than an overview ever publishes. Rebuild
   * must survive that history and keep the window the overview publishes — for
   * each Canvas, so a heavily read Canvas never evicts a quiet one's log.
   */
  it("rebuilds a bounded per-canvas access log from a history larger than the published window", () => {
    const { projection, rebuild } = harness();
    projection.applyCreated({
      canvasId: quietCanvasId,
      version: currentVersion({ canvasId: ids.quietCanvas, versionId: ids.quietVersion }),
    });
    const busy = accessHistory(ids.canvas, 200_000);
    const quiet = accessHistory(ids.quietCanvas, 3);

    const restarted = rebuild({ eventStore: replayingStore(busy.concat(quiet)) });

    const busyLog = restarted.overview(canvasId, context, project)?.accessLog ?? [];
    expect(busyLog).toHaveLength(CANVAS_SHARE_MAX_ACCESS_LOG_EVENTS);
    // The window the owner sees is the most recent one, not the oldest.
    expect(busyLog.map((event) => String(event.eventId))).toEqual(
      busy.slice(-CANVAS_SHARE_MAX_ACCESS_LOG_EVENTS).map((event) => String(event.eventId)),
    );
    const quietLog = restarted.overview(quietCanvasId, context, project)?.accessLog ?? [];
    expect(quietLog.map((event) => String(event.eventId))).toEqual(
      quiet.map((event) => String(event.eventId)),
    );
  });

  it("publishes a bounded overview when a Canvas holds more share rows than it may carry", () => {
    const { service, clock } = harness();
    // Settled rows are what a long-lived Canvas accumulates past the cap: live
    // shares are bounded where they are minted, revoked and expired ones are not.
    for (let index = 0; index < 12; index += 1) {
      service.share(
        shareRequest({
          snapshotId: mintedSnapshotId(index),
          expiresAt: "2026-08-01T21:10:00.000Z",
        }),
        context,
        project,
        localPrincipal,
      );
    }
    clock.value = "2026-08-01T21:11:00.000Z";
    for (let index = 12; index < 20; index += 1) {
      const snapshotId = mintedSnapshotId(index);
      service.share(shareRequest({ snapshotId }), context, project, localPrincipal);
      service.revoke({ ...revokeRequest(), snapshotId }, context, project, localPrincipal);
    }
    const live: string[] = [];
    for (let index = 20; index < 20 + CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS; index += 1) {
      const snapshotId = mintedSnapshotId(index);
      expect(
        service.share(shareRequest({ snapshotId }), context, project, localPrincipal).kind,
      ).toBe("accepted");
      live.push(snapshotId);
    }

    // Without a bound the overview does not decode at all, so the owner sees no
    // shares and can revoke none of them.
    const snapshots = service.overview(canvasId, context, project)?.snapshots ?? [];
    expect(snapshots).toHaveLength(CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS);
    // The 20 settled rows are the ones dropped; every live share survives.
    expect(snapshots.map((snapshot) => String(snapshot.snapshotId)).sort()).toEqual(
      [...live].sort(),
    );
  });

  /**
   * The overview is the only surface a live share can be revoked from, so a
   * Canvas may hold no more live shares than an overview can publish. The bound
   * therefore belongs where shares are minted, not where they are listed.
   */
  it("refuses a new share once the Canvas holds every live share an overview can carry", () => {
    const { service, shareEventNames } = harness();
    const live: string[] = [];
    for (let index = 0; index < CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS; index += 1) {
      const snapshotId = mintedSnapshotId(index);
      expect(
        service.share(shareRequest({ snapshotId }), context, project, localPrincipal).kind,
      ).toBe("accepted");
      live.push(snapshotId);
    }

    const refused = service.share(
      shareRequest({ snapshotId: mintedSnapshotId(900) }),
      context,
      project,
      localPrincipal,
    );

    expect(refused).toMatchObject({ kind: "denied", denialCode: "unavailable" });
    if (refused.kind !== "denied") return;
    // The refusal names what the owner can do about it.
    expect(refused.message).toMatch(/revoke/i);
    expect(shareEventNames()).toHaveLength(CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS);
    // Every share the owner holds is live, published, and therefore revocable.
    const snapshots = service.overview(canvasId, context, project)?.snapshots ?? [];
    expect(
      snapshots
        .filter((snapshot) => snapshot.status === "active")
        .map((snapshot) => String(snapshot.snapshotId))
        .sort(),
    ).toEqual([...live].sort());

    // Withdrawing one live share is what makes room for the next.
    expect(
      service.revoke({ ...revokeRequest(), snapshotId: live[0] }, context, project, localPrincipal),
    ).toMatchObject({ kind: "accepted" });
    expect(
      service.share(
        shareRequest({ snapshotId: mintedSnapshotId(901) }),
        context,
        project,
        localPrincipal,
      ).kind,
    ).toBe("accepted");
  });

  it("shares again once a live share expires, without the owner revoking anything", () => {
    const { service, clock } = harness();
    for (let index = 0; index < CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS; index += 1) {
      service.share(
        shareRequest({ snapshotId: mintedSnapshotId(index) }),
        context,
        project,
        localPrincipal,
      );
    }
    expect(
      service.share(
        shareRequest({ snapshotId: mintedSnapshotId(900) }),
        context,
        project,
        localPrincipal,
      ),
    ).toMatchObject({ kind: "denied", denialCode: "unavailable" });

    // Expiry frees capacity on its own: liveness is read from the clock, never
    // from a stored count.
    clock.value = "2026-08-02T21:00:01.000Z";

    const admitted = service.share(
      shareRequest({
        snapshotId: mintedSnapshotId(901),
        expiresAt: "2026-08-03T21:00:00.000Z",
      }),
      context,
      project,
      localPrincipal,
    );

    expect(admitted.kind).toBe("accepted");
    const snapshots = service.overview(canvasId, context, project)?.snapshots ?? [];
    expect(
      snapshots
        .filter((snapshot) => snapshot.status === "active")
        .map((snapshot) => String(snapshot.snapshotId)),
    ).toEqual([mintedSnapshotId(901)]);
  });

  it("keeps every revocable share in a bounded overview and drops settled ones first", () => {
    const { service } = harness();
    const revokedCount = 20;
    const liveCount = CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS - 6;
    const live: string[] = [];
    for (let index = 0; index < revokedCount + liveCount; index += 1) {
      const snapshotId = mintedSnapshotId(index);
      service.share(shareRequest({ snapshotId }), context, project, localPrincipal);
      if (index < revokedCount) {
        service.revoke({ ...revokeRequest(), snapshotId }, context, project, localPrincipal);
        continue;
      }
      live.push(snapshotId);
    }

    const snapshots = service.overview(canvasId, context, project)?.snapshots ?? [];

    expect(snapshots).toHaveLength(CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS);
    // A revoked share carries no authority, so it is the one safe to hide; a
    // live share the overview drops is a share the owner can no longer revoke.
    const published = new Set(snapshots.map((snapshot) => String(snapshot.snapshotId)));
    expect(live.every((snapshotId) => published.has(snapshotId))).toBe(true);
  });

  it("keeps a revocation effective after the projection is rebuilt from the journal", () => {
    const { service, rebuild } = harness();
    service.share(shareRequest(), context, project, localPrincipal);
    service.access({ request: accessRequest(), principal: localPrincipal });
    service.revoke(revokeRequest(), context, project, localPrincipal);

    const restarted = rebuild();

    const overview = restarted.overview(canvasId, context, project);
    expect(overview?.snapshots[0]?.status).toBe("revoked");
    expect(overview?.accessLog).toHaveLength(1);
    expect(restarted.access({ request: accessRequest(), principal: localPrincipal })).toMatchObject(
      {
        kind: "denied",
        outcome: "denied-revoked",
      },
    );
    // Replaying the same journal twice yields the same share state.
    const again = rebuild();
    expect(again.overview(canvasId, context, project)?.snapshots).toEqual(overview?.snapshots);
    expect(rebuild().overview(canvasId, context, project)?.accessLog).toEqual(
      again.overview(canvasId, context, project)?.accessLog,
    );
  });

  it("still lets the owner withdraw a share after the host stops sharing", () => {
    const { service, rebuild } = harness();
    service.share(shareRequest(), context, project, localPrincipal);

    const disabled = rebuild({ sharingEnabled: false });

    expect(disabled.access({ request: accessRequest(), principal: localPrincipal })).toMatchObject({
      kind: "unavailable",
      denialCode: "sharing-disabled",
    });
    expect(disabled.revoke(revokeRequest(), context, project, localPrincipal)).toMatchObject({
      kind: "accepted",
    });
    expect(rebuild().overview(canvasId, context, project)?.snapshots[0]?.status).toBe("revoked");
  });

  /**
   * A host that restarts with sharing off still holds every snapshot it minted.
   * A read replayed against one of them is an evaluated read, so the owner's
   * log must show it before the refusal is returned.
   */
  it("journals a known snapshot's read under disabled sharing before refusing it", () => {
    const { service, rebuild, shareEventNames } = harness();
    service.share(shareRequest(), context, project, localPrincipal);

    const disabled = rebuild({ sharingEnabled: false });
    const result = disabled.access({ request: accessRequest(), principal: localPrincipal });

    expect(result).toMatchObject({ kind: "unavailable", denialCode: "sharing-disabled" });
    expect(shareEventNames()).toEqual([CANVAS_SHARE_SNAPSHOT_CREATED, CANVAS_SHARE_ACCESS_LOGGED]);
    const accessLog = rebuild().overview(canvasId, context, project)?.accessLog ?? [];
    expect(accessLog).toHaveLength(1);
    expect(accessLog[0]?.outcome).toBe("denied-sharing-disabled");
    expect(accessLog[0]?.snapshotId).toBe(ids.snapshot);
    expect(accessLog[0]?.canvasId).toBe(ids.canvas);
  });

  /**
   * An unknown snapshot id has no record to journal against. Writing one anyway
   * would turn the owner's log into an oracle a guesser could drive, so nothing
   * is recorded and the caller receives exactly the same refusal.
   */
  it("journals nothing for an unknown snapshot id under disabled sharing", () => {
    const { service, rebuild, shareEventNames } = harness();
    service.share(shareRequest(), context, project, localPrincipal);

    const disabled = rebuild({ sharingEnabled: false });
    const result = disabled.access({
      request: { ...accessRequest(), snapshotId: "44444444-4444-4444-8444-444444444444" },
      principal: localPrincipal,
    });

    expect(result).toMatchObject({ kind: "unavailable", denialCode: "sharing-disabled" });
    // Indistinguishable from the known-snapshot refusal above.
    expect(result).toEqual(
      disabled.access({ request: accessRequest(), principal: localPrincipal }),
    );
    expect(shareEventNames()).toEqual([CANVAS_SHARE_SNAPSHOT_CREATED, CANVAS_SHARE_ACCESS_LOGGED]);
    const accessLog = rebuild().overview(canvasId, context, project)?.accessLog ?? [];
    expect(accessLog.map((event) => String(event.snapshotId))).toEqual([String(ids.snapshot)]);
  });

  it("refuses a snapshot whose audience does not include the authenticated principal", () => {
    const { service } = harness();
    service.share(
      shareRequest({
        audience: {
          ownerActorId: ids.owner,
          principals: [
            { label: "Reviewer device", principalKind: "paired-device", principalId: ids.outsider },
          ],
        },
      }),
      context,
      project,
      localPrincipal,
    );

    const result = service.access({ request: accessRequest(), principal: localPrincipal });

    expect(result).toMatchObject({ kind: "denied", outcome: "denied-audience" });
  });

  it("refuses a paired remote device a snapshot whose audience is the local owner only", () => {
    const { service } = harness();
    // The default audience names only this host's local user.
    service.share(shareRequest(), context, project, localPrincipal);

    const result = service.access({
      request: accessRequest(),
      principal: devicePrincipal,
    });

    expect(result).toMatchObject({ kind: "denied", outcome: "denied-audience" });
    // The refusal must never hand the device the admitted document.
    expect(JSON.stringify(result)).not.toContain("A bounded Canvas");
  });

  it("serves a paired remote device a snapshot whose audience names that device", () => {
    const { service } = harness();
    service.share(
      shareRequest({
        audience: {
          ownerActorId: ids.owner,
          principals: [
            { label: "Reviewer device", principalKind: "paired-device", principalId: ids.device },
          ],
        },
      }),
      context,
      project,
      localPrincipal,
    );

    const result = service.access({
      request: accessRequest(),
      principal: devicePrincipal,
    });

    expect(result.kind).toBe("allowed");
    // The local owner is not in this audience, so their own read is refused.
    expect(service.access({ request: accessRequest(), principal: localPrincipal })).toMatchObject({
      kind: "denied",
      outcome: "denied-audience",
    });
  });

  it("journals a remote device's read against the device, never the local owner", () => {
    const { service } = harness();
    service.share(shareRequest(), context, project, localPrincipal);

    service.access({ request: accessRequest(), principal: devicePrincipal });

    const accessLog = service.overview(canvasId, context, project)?.accessLog ?? [];
    expect(accessLog).toHaveLength(1);
    expect(accessLog[0]?.principalId).toBe(ids.device);
    expect(accessLog[0]?.outcome).toBe("denied-audience");
  });

  it("journals a remote device's refused read under disabled sharing against the device", () => {
    const { service, rebuild } = harness();
    service.share(shareRequest(), context, project, localPrincipal);
    const disabled = rebuild({ sharingEnabled: false });

    expect(disabled.access({ request: accessRequest(), principal: devicePrincipal })).toMatchObject(
      { kind: "unavailable", denialCode: "sharing-disabled" },
    );

    const accessLog = rebuild().overview(canvasId, context, project)?.accessLog ?? [];
    expect(accessLog).toHaveLength(1);
    expect(accessLog[0]?.outcome).toBe("denied-sharing-disabled");
    expect(accessLog[0]?.principalId).toBe(ids.device);
  });

  it("refuses a paired remote device that tries to mint or withdraw an owner's share", () => {
    const { service, shareEventNames } = harness();

    expect(service.share(shareRequest(), context, project, devicePrincipal)).toMatchObject({
      kind: "denied",
      denialCode: "unauthorized",
    });
    expect(shareEventNames()).toHaveLength(0);

    service.share(shareRequest(), context, project, localPrincipal);
    expect(service.revoke(revokeRequest(), context, project, devicePrincipal)).toMatchObject({
      kind: "denied",
      denialCode: "unauthorized",
    });
    expect(shareEventNames()).toEqual([CANVAS_SHARE_SNAPSHOT_CREATED]);
  });

  it("journals a scope-probing read before refusing it, without echoing the snapshot's scope", () => {
    const { service, shareEventNames } = harness();
    service.share(shareRequest(), context, project, localPrincipal);

    // A valid snapshot id pointed at a Canvas it was never shared from: the
    // owner must be able to see the probe in their own access log.
    const result = service.access({
      request: { ...accessRequest(), canvasId: "33333333-3333-4333-8333-333333333333" },
      principal: localPrincipal,
    });

    expect(result).toMatchObject({ kind: "unavailable", denialCode: "scope-mismatch" });
    // The refusal still tells the prober nothing about the real snapshot.
    expect(JSON.stringify(result)).not.toContain(ids.canvas);
    expect(shareEventNames()).toEqual([CANVAS_SHARE_SNAPSHOT_CREATED, CANVAS_SHARE_ACCESS_LOGGED]);
    const accessLog = service.overview(canvasId, context, project)?.accessLog ?? [];
    expect(accessLog).toHaveLength(1);
    expect(accessLog[0]?.outcome).toBe("denied-scope-mismatch");
    // The evaluation is logged against the snapshot the owner owns, never the
    // scope the caller guessed at.
    expect(accessLog[0]?.canvasId).toBe(ids.canvas);
    expect(JSON.stringify(accessLog[0])).not.toContain("33333333-3333-4333-8333-333333333333");
  });

  it("refuses an expired snapshot without rewriting the journal", () => {
    const { service, clock, shareEventNames } = harness();
    service.share(shareRequest(), context, project, localPrincipal);

    clock.value = "2026-08-03T21:00:00.000Z";

    expect(service.access({ request: accessRequest(), principal: localPrincipal })).toMatchObject({
      kind: "denied",
      outcome: "denied-expired",
    });
    expect(service.overview(canvasId, context, project)?.snapshots[0]?.status).toBe("expired");
    expect(shareEventNames()).toEqual([CANVAS_SHARE_SNAPSHOT_CREATED, CANVAS_SHARE_ACCESS_LOGGED]);
  });

  it("replays a repeated share id instead of minting a second snapshot", () => {
    const { service, shareEventNames } = harness();

    const first = service.share(shareRequest(), context, project, localPrincipal);
    const second = service.share(shareRequest(), context, project, localPrincipal);

    expect(second).toEqual(first);
    expect(shareEventNames()).toEqual([CANVAS_SHARE_SNAPSHOT_CREATED]);
  });

  it("refuses a share whose consent does not match the authenticated owner", () => {
    const { service } = harness();

    const result = service.share(
      shareRequest({
        consent: {
          acknowledgedAuthenticatedSnapshot: true,
          acknowledgedOwnerVisibleAudience: true,
          acknowledgedAt: "2026-08-01T21:05:00.000Z",
          acknowledgedBy: { kind: "local-user", actorId: ids.outsider },
        },
      }),
      context,
      project,
      localPrincipal,
    );

    expect(result).toMatchObject({ kind: "denied", denialCode: "consent-required" });
  });

  it("refuses a share bound to a stale version", () => {
    const { service } = harness();

    const result = service.share(
      shareRequest({ expectedSequence: 2 }),
      context,
      project,
      localPrincipal,
    );

    expect(result).toMatchObject({ kind: "denied", denialCode: "stale-version" });
  });
});
