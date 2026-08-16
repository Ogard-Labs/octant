import { describe, expect, it } from "vitest";
import type { UtcTimestamp } from "@octant/contracts/events";
import {
  buildCanvasShareAccessLogEvent,
  CANVAS_SHARE_BROWSER_COMPATIBILITY,
  classifyBrowserFamily,
  validateCanvasShareAccessLogEvent,
} from "./canvasShareAccessLogPolicy";
import { createCanvasShareSnapshotRecord } from "./canvasShareSnapshotPolicy";

const ids = {
  snapshot: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  exportId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  project: "33333333-3333-4333-8333-333333333333",
  thread: "44444444-4444-4444-8444-444444444444",
  actor: "66666666-6666-4666-8666-666666666666",
  audience: "99999999-9999-4999-8999-999999999999",
  source: "77777777-7777-4777-8777-777777777777",
  provider: "55555555-5555-4555-8555-555555555555",
  event: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
} as const;

const current = {
  schemaVersion: 1,
  canvasId: ids.canvas,
  versionId: ids.version,
  sequence: 2,
  createdBy: { kind: "local-user", actorId: ids.actor },
  createdAt: "2026-08-04T11:00:00.000Z",
  definition: {
    schemaVersion: 1,
    title: "Weekly plan",
    provenance: {
      hostId: "local",
      projectId: ids.project,
      actor: { kind: "local-user", actorId: ids.actor },
      providerInstanceId: ids.provider,
      modelId: "octant-test-model",
      createdAt: "2026-08-04T11:00:00.000Z",
      mode: "chat",
      threadId: ids.thread,
    },
    sourceManifest: [
      {
        sourceId: ids.source,
        kind: "artifact",
        hostId: "local",
        projectId: ids.project,
        opaqueRef: "artifact:one",
        displayName: "Artifact",
      },
    ],
    blocks: [
      {
        blockId: "heading-1",
        schemaVersion: 1,
        kind: "heading",
        level: 1,
        text: "Weekly plan",
      },
    ],
  },
} as const;

const staticExportRequest = {
  schemaVersion: 1,
  kind: "canvas-static-export",
  exportId: ids.exportId,
  canvasId: ids.canvas,
  versionId: ids.version,
  expectedSequence: 2,
  hostId: "local",
  projectId: ids.project,
  channel: "static-export",
  consent: {
    acknowledgedOfflineSnapshot: true,
    acknowledgedNoCredentials: true,
    acknowledgedAt: "2026-08-04T12:00:00.000Z",
    acknowledgedBy: { kind: "local-user", actorId: ids.actor },
  },
} as const;

const snapshotRequest = {
  schemaVersion: 1,
  kind: "canvas-share-snapshot",
  snapshotId: ids.snapshot,
  exportId: ids.exportId,
  canvasId: ids.canvas,
  versionId: ids.version,
  expectedSequence: 2,
  hostId: "local",
  projectId: ids.project,
  audience: {
    ownerActorId: ids.actor,
    principals: [
      {
        label: "Reviewer device",
        principalKind: "paired-device",
        principalId: ids.audience,
      },
    ],
  },
  expiresAt: "2026-08-05T12:00:00.000Z",
  refreshPolicy: "manual-only",
  consent: {
    acknowledgedAuthenticatedSnapshot: true,
    acknowledgedOwnerVisibleAudience: true,
    acknowledgedAt: "2026-08-04T12:05:00.000Z",
    acknowledgedBy: { kind: "local-user", actorId: ids.actor },
  },
} as const;

const context = {
  sharingEnabled: true,
  hostId: "local",
  projectId: ids.project,
  nowIso: "2026-08-04T12:05:01.000Z",
  actor: { kind: "local-user" as const, actorId: ids.actor },
} as const;

describe("Canvas share access log policy", () => {
  it("records privacy-preserving allowed and deleted-source outcomes", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    const allowed = buildCanvasShareAccessLogEvent({
      eventId: ids.event,
      record,
      nowIso: context.nowIso,
      principalId: ids.audience,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    });
    expect(allowed.outcome).toBe("allowed");
    expect(allowed.browserFamily).toBe("safari");
    expect(allowed).not.toHaveProperty("userAgent");
    expect(
      buildCanvasShareAccessLogEvent({
        eventId: ids.event,
        record,
        nowIso: context.nowIso,
        principalId: ids.audience,
        sourceDeleted: true,
      }).outcome,
    ).toBe("denied-deleted-source");
    expect(
      validateCanvasShareAccessLogEvent({
        event: allowed,
        record,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toEqual(allowed);
  });

  it("records a scope-mismatched evaluation as its own denial reason", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });

    const probed = buildCanvasShareAccessLogEvent({
      eventId: ids.event,
      record,
      nowIso: context.nowIso,
      principalId: ids.audience,
      scopeMismatch: true,
    });

    // The evaluation is logged against the snapshot's own scope; the scope the
    // caller supplied is never journaled.
    expect(probed.outcome).toBe("denied-scope-mismatch");
    expect(probed.canvasId).toBe(ids.canvas);
    expect(
      validateCanvasShareAccessLogEvent({
        event: probed,
        record,
        authenticatedPrincipalId: ids.audience,
        scopeMismatch: true,
      }),
    ).toEqual(probed);
    // A scope-mismatch outcome may not be claimed without the authoritative
    // evaluation that produced it, and vice versa.
    expect(() =>
      validateCanvasShareAccessLogEvent({
        event: probed,
        record,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toThrowError(/scope/i);
    expect(() =>
      validateCanvasShareAccessLogEvent({
        event: { ...probed, outcome: "allowed" },
        record,
        authenticatedPrincipalId: ids.audience,
        scopeMismatch: true,
      }),
    ).toThrowError(/scope/i);
  });

  it("classifies supported browser families without raw UA retention", () => {
    expect(classifyBrowserFamily("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36")).toBe("chrome");
    expect(classifyBrowserFamily("Mozilla/5.0 Firefox/121.0")).toBe("firefox");
    expect(classifyBrowserFamily("Mozilla/5.0 Edg/120.0.0.0")).toBe("edge");
    expect(CANVAS_SHARE_BROWSER_COMPATIBILITY).toEqual(["chrome", "safari", "firefox", "edge"]);
  });

  it("rejects host or Project scope mismatches against the snapshot", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    const allowed = buildCanvasShareAccessLogEvent({
      eventId: ids.event,
      record,
      nowIso: context.nowIso,
      principalId: ids.audience,
    });
    expect(() =>
      validateCanvasShareAccessLogEvent({
        event: { ...allowed, hostId: "other-host" },
        record,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toThrowError(/host/i);
    expect(() =>
      validateCanvasShareAccessLogEvent({
        event: {
          ...allowed,
          projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        },
        record,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toThrowError(/Project/i);
  });

  it("accepts allowed events without audienceLabel and rejects mismatched denial reasons", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    const allowed = buildCanvasShareAccessLogEvent({
      eventId: ids.event,
      record,
      nowIso: context.nowIso,
      principalId: ids.audience,
    });
    const { audienceLabel: _ignored, ...withoutLabel } = allowed as typeof allowed & {
      audienceLabel?: string;
    };
    expect(
      validateCanvasShareAccessLogEvent({
        event: withoutLabel,
        record,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toMatchObject({
      outcome: "allowed",
    });

    const revoked = {
      ...record,
      status: "revoked" as const,
      revokedAt: "2026-08-04T13:00:00.000Z" as UtcTimestamp,
    };
    expect(() =>
      validateCanvasShareAccessLogEvent({
        event: {
          ...allowed,
          occurredAt: "2026-08-04T13:01:00.000Z",
          outcome: "denied-expired",
        },
        record: revoked,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toThrowError(/denied-revoked|lifecycle|revoked/i);
  });

  it("matches exact lifecycle denial reasons and historical revocation timing", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    const revoked = {
      ...record,
      status: "revoked" as const,
      revokedAt: "2026-08-04T13:00:00.000Z" as UtcTimestamp,
    };

    const deniedRevoked = buildCanvasShareAccessLogEvent({
      eventId: ids.event,
      record: revoked,
      nowIso: "2026-08-04T13:01:00.000Z",
      principalId: ids.audience,
    });
    expect(deniedRevoked.outcome).toBe("denied-revoked");
    expect(() =>
      validateCanvasShareAccessLogEvent({
        event: { ...deniedRevoked, outcome: "denied-expired" },
        record: revoked,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toThrowError(/denied-revoked|lifecycle/i);

    const historicalAllowed = buildCanvasShareAccessLogEvent({
      eventId: ids.event,
      record,
      nowIso: "2026-08-04T12:30:00.000Z",
      principalId: ids.audience,
    });
    expect(historicalAllowed.outcome).toBe("allowed");
    expect(
      validateCanvasShareAccessLogEvent({
        event: historicalAllowed,
        record: revoked,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toEqual(historicalAllowed);
  });

  it("validates audience outcomes with principalId when audienceLabel is omitted", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    const outsider = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const denied = buildCanvasShareAccessLogEvent({
      eventId: ids.event,
      record,
      nowIso: context.nowIso,
      principalId: outsider,
    });
    expect(denied.outcome).toBe("denied-audience");
    expect(denied.principalId).toBe(outsider);
    expect(denied.audienceLabel).toBeUndefined();
    expect(
      validateCanvasShareAccessLogEvent({
        event: denied,
        record,
        authenticatedPrincipalId: outsider,
      }),
    ).toEqual(denied);

    expect(
      validateCanvasShareAccessLogEvent({
        event: {
          schemaVersion: 1,
          kind: "canvas-share-access-log",
          eventId: ids.event,
          snapshotId: ids.snapshot,
          canvasId: ids.canvas,
          hostId: "local",
          projectId: ids.project,
          occurredAt: context.nowIso,
          outcome: "allowed",
          browserFamily: "safari",
        },
        record,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toMatchObject({ outcome: "allowed" });
  });

  it("rejects events that predate creation and forged deleted-source outcomes", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    const allowed = buildCanvasShareAccessLogEvent({
      eventId: ids.event,
      record,
      nowIso: context.nowIso,
      principalId: ids.audience,
    });
    expect(() =>
      validateCanvasShareAccessLogEvent({
        event: { ...allowed, occurredAt: "2026-08-04T12:00:00.000Z" },
        record,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toThrowError(/predate|creation/i);
    expect(() =>
      validateCanvasShareAccessLogEvent({
        event: { ...allowed, outcome: "denied-deleted-source" },
        record,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toThrowError(/source deletion|deleted-source/i);
    expect(
      validateCanvasShareAccessLogEvent({
        event: { ...allowed, outcome: "denied-deleted-source" },
        record,
        authenticatedPrincipalId: ids.audience,
        sourceDeleted: true,
      }).outcome,
    ).toBe("denied-deleted-source");
  });

  it("replays historical allowed events against currently expired projections and duplicate labels", () => {
    const record = createCanvasShareSnapshotRecord({
      request: {
        ...snapshotRequest,
        audience: {
          ownerActorId: ids.actor,
          principals: [
            {
              label: "Shared label",
              principalKind: "paired-device",
              principalId: ids.audience,
            },
            {
              label: "Shared label",
              principalKind: "local-user",
              principalId: ids.actor,
            },
          ],
        },
      },
      current,
      context,
      staticExportRequest,
    });
    const historicalAllowed = buildCanvasShareAccessLogEvent({
      eventId: ids.event,
      record,
      nowIso: "2026-08-04T12:30:00.000Z",
      principalId: ids.actor,
    });
    expect(historicalAllowed.outcome).toBe("allowed");
    const expiredProjection = {
      ...record,
      status: "expired" as const,
    };
    expect(
      validateCanvasShareAccessLogEvent({
        event: historicalAllowed,
        record: expiredProjection,
        authenticatedPrincipalId: ids.actor,
      }),
    ).toEqual(historicalAllowed);
  });

  it("accepts privacy-preserving events that omit optional principalId", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    const allowed = buildCanvasShareAccessLogEvent({
      eventId: ids.event,
      record,
      nowIso: context.nowIso,
      principalId: ids.audience,
    });
    const { principalId: _ignored, ...withoutPrincipal } = allowed as typeof allowed & {
      principalId?: string;
    };
    expect(
      validateCanvasShareAccessLogEvent({
        event: withoutPrincipal,
        record,
        authenticatedPrincipalId: ids.audience,
      }),
    ).toMatchObject({ outcome: "allowed" });
  });

  it("rejects outsider allowed events that only spoof a member audienceLabel", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    const outsider = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(() =>
      validateCanvasShareAccessLogEvent({
        event: {
          schemaVersion: 1,
          kind: "canvas-share-access-log",
          eventId: ids.event,
          snapshotId: ids.snapshot,
          canvasId: ids.canvas,
          hostId: "local",
          projectId: ids.project,
          occurredAt: context.nowIso,
          outcome: "allowed",
          browserFamily: "safari",
          audienceLabel: "Reviewer device",
        },
        record,
        authenticatedPrincipalId: outsider,
      }),
    ).toThrowError(/audienceLabel|authenticated principal|principal/i);
  });

  it("rejects denied-audience events that spoof a member audienceLabel", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    const outsider = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(() =>
      validateCanvasShareAccessLogEvent({
        event: {
          schemaVersion: 1,
          kind: "canvas-share-access-log",
          eventId: ids.event,
          snapshotId: ids.snapshot,
          canvasId: ids.canvas,
          hostId: "local",
          projectId: ids.project,
          occurredAt: context.nowIso,
          outcome: "denied-audience",
          browserFamily: "safari",
          audienceLabel: "Reviewer device",
        },
        record,
        authenticatedPrincipalId: outsider,
      }),
    ).toThrowError(/audienceLabel|authenticated principal|principal/i);
  });
});
