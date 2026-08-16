import { describe, expect, it } from "vitest";
import {
  createCanvasShareSnapshotRecord,
  evaluateCanvasShareSnapshotAccess,
  revokeCanvasShareSnapshot,
  CanvasShareSnapshotPolicyRejected,
} from "./canvasShareSnapshotPolicy";

const ids = {
  snapshot: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  exportId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  project: "33333333-3333-4333-8333-333333333333",
  thread: "44444444-4444-4444-8444-444444444444",
  actor: "66666666-6666-4666-8666-666666666666",
  audience: "99999999-9999-4999-8999-999999999999",
  other: "88888888-8888-4888-8888-888888888888",
  source: "77777777-7777-4777-8777-777777777777",
  provider: "55555555-5555-4555-8555-555555555555",
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

describe("Canvas share snapshot policy", () => {
  it("creates an authenticated snapshot with expiry and owner-visible audience", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    expect(record.status).toBe("active");
    expect(record.document.channel).toBe("authenticated-snapshot");
    expect(record.document.threatModelId).toBe("canvas-share-authenticated-snapshot-v1");
    expect(record.audience.principals[0]?.principalId).toBe(ids.audience);
    expect(
      evaluateCanvasShareSnapshotAccess({
        record,
        nowIso: context.nowIso,
        principalId: ids.audience,
        principalKind: "paired-device",
      }),
    ).toEqual({ allowed: true });
    expect(record.consent).toEqual({
      ...snapshotRequest.consent,
      acknowledgedAt: context.nowIso,
    });
  });

  it("denies expired, revoked, and non-audience access", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    expect(
      evaluateCanvasShareSnapshotAccess({
        record,
        nowIso: "2026-08-06T00:00:00.000Z",
        principalId: ids.audience,
        principalKind: "paired-device",
      }).allowed,
    ).toBe(false);
    expect(
      evaluateCanvasShareSnapshotAccess({
        record,
        nowIso: context.nowIso,
        principalId: ids.other,
        principalKind: "paired-device",
      }).allowed,
    ).toBe(false);
    const revoked = revokeCanvasShareSnapshot({
      record,
      nowIso: "2026-08-04T13:00:00.000Z",
      actor: { kind: "local-user", actorId: ids.actor },
      request: {
        schemaVersion: 1,
        kind: "canvas-share-snapshot-revoke",
        snapshotId: ids.snapshot,
        canvasId: ids.canvas,
        hostId: "local",
        projectId: ids.project,
        actor: { kind: "local-user", actorId: ids.actor },
        revokedAt: "2026-08-04T13:00:00.000Z",
      },
    });
    expect(revoked.status).toBe("revoked");
    expect(
      evaluateCanvasShareSnapshotAccess({
        record: revoked,
        nowIso: "2026-08-04T13:00:01.000Z",
        principalId: ids.audience,
        principalKind: "paired-device",
      }),
    ).toEqual({ allowed: false, denialCode: "revoked" });
  });

  it("rejects stale version snapshots", () => {
    expect(() =>
      createCanvasShareSnapshotRecord({
        request: { ...snapshotRequest, expectedSequence: 1 },
        current,
        context,
        staticExportRequest,
      }),
    ).toThrowError(CanvasShareSnapshotPolicyRejected);
  });

  it("creates snapshots without static-export consent and rejects unauthorized revoke", () => {
    const withoutStatic = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
    });
    expect(withoutStatic.status).toBe("active");

    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    expect(() =>
      revokeCanvasShareSnapshot({
        record,
        nowIso: "2026-08-04T13:00:00.000Z",
        actor: { kind: "local-user", actorId: ids.other },
        request: {
          schemaVersion: 1,
          kind: "canvas-share-snapshot-revoke",
          snapshotId: ids.snapshot,
          canvasId: ids.canvas,
          hostId: "local",
          projectId: ids.project,
          actor: { kind: "local-user", actorId: ids.other },
          revokedAt: "2026-08-04T13:00:00.000Z",
        },
      }),
    ).toThrowError(/owner|unauthorized/i);
  });

  it("requires matching principal kind and canonical revoke timestamps", () => {
    const record = createCanvasShareSnapshotRecord({
      request: snapshotRequest,
      current,
      context,
      staticExportRequest,
    });
    expect(
      evaluateCanvasShareSnapshotAccess({
        record,
        nowIso: context.nowIso,
        principalId: ids.audience,
        principalKind: "local-user",
      }),
    ).toEqual({ allowed: false, denialCode: "audience-required" });

    expect(() =>
      revokeCanvasShareSnapshot({
        record,
        nowIso: "2026-08-04T13:00:00Z",
        actor: { kind: "local-user", actorId: ids.actor },
        request: {
          schemaVersion: 1,
          kind: "canvas-share-snapshot-revoke",
          snapshotId: ids.snapshot,
          canvasId: ids.canvas,
          hostId: "local",
          projectId: ids.project,
          actor: { kind: "local-user", actorId: ids.actor },
          revokedAt: "2026-08-04T13:00:00.000Z",
        },
      }),
    ).toThrowError(CanvasShareSnapshotPolicyRejected);
  });

  it("stamps consent acknowledgedAt from authoritative time", () => {
    const record = createCanvasShareSnapshotRecord({
      request: {
        ...snapshotRequest,
        consent: {
          ...snapshotRequest.consent,
          acknowledgedAt: "2026-08-06T00:00:00.000Z",
        },
      },
      current,
      context,
    });
    expect(record.consent.acknowledgedAt).toBe(context.nowIso);
  });
});
