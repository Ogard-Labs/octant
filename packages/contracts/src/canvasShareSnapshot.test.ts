import { describe, expect, it } from "vitest";
import {
  decodeCanvasShareResult,
  decodeCanvasShareSnapshotRecord,
  decodeCanvasShareSnapshotRequest,
  decodeCanvasShareSnapshotRevokeRequest,
  decodeCanvasShareSnapshotSummary,
} from "./canvasShareSnapshot";

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
} as const;

const document = {
  schemaVersion: 1,
  kind: "canvas-static-export-document",
  exportId: ids.exportId,
  canvasId: ids.canvas,
  versionId: ids.version,
  sequence: 2,
  exportedAt: "2026-08-04T12:00:01.000Z",
  title: "Weekly plan",
  channel: "authenticated-snapshot",
  sharingEnabled: true,
  provenance: {
    hostId: "local",
    projectId: ids.project,
    mode: "chat",
    threadId: ids.thread,
    createdAt: "2026-08-04T11:00:00.000Z",
    providerLabel: "provider",
    modelLabel: "model",
    actorKind: "local-user",
  },
  sourceManifest: [
    {
      sourceId: ids.source,
      kind: "artifact",
      displayName: "Artifact",
      opaqueRef: "artifact:one",
    },
  ],
  blocks: [
    { blockId: "heading-1", schemaVersion: 1, kind: "heading", level: 1, text: "Weekly plan" },
  ],
  threatModelId: "canvas-share-authenticated-snapshot-v1",
} as const;

const request = {
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

describe("Canvas share snapshot contracts", () => {
  it("round-trips an authenticated snapshot request with owner-visible audience", () => {
    expect(decodeCanvasShareSnapshotRequest(request)).toEqual(request);
  });

  it("rejects public anonymous audience and missing consent", () => {
    expect(() =>
      decodeCanvasShareSnapshotRequest({
        ...request,
        audience: { ownerActorId: ids.actor, principals: [], public: true },
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasShareSnapshotRequest({
        ...request,
        consent: {
          acknowledgedAuthenticatedSnapshot: true,
          acknowledgedAt: request.consent.acknowledgedAt,
          acknowledgedBy: request.consent.acknowledgedBy,
        },
      }),
    ).toThrow();
  });

  it("round-trips active and revoked snapshot records", () => {
    const record = {
      schemaVersion: 1,
      kind: "canvas-share-snapshot-record",
      snapshotId: ids.snapshot,
      exportId: ids.exportId,
      canvasId: ids.canvas,
      versionId: ids.version,
      sequence: 2,
      hostId: "local",
      projectId: ids.project,
      audience: request.audience,
      createdAt: "2026-08-04T12:05:01.000Z",
      expiresAt: request.expiresAt,
      refreshPolicy: "manual-only",
      status: "active",
      consent: request.consent,
      document,
      provenance: document.provenance,
      sourceManifest: document.sourceManifest,
    } as const;
    expect(decodeCanvasShareSnapshotRecord(record)).toEqual(record);
    expect(
      decodeCanvasShareSnapshotRevokeRequest({
        schemaVersion: 1,
        kind: "canvas-share-snapshot-revoke",
        snapshotId: ids.snapshot,
        canvasId: ids.canvas,
        hostId: "local",
        projectId: ids.project,
        actor: { kind: "local-user", actorId: ids.actor },
        revokedAt: "2026-08-04T13:00:00.000Z",
      }),
    ).toMatchObject({ kind: "canvas-share-snapshot-revoke" });
  });

  it("rejects secret audience labels and mismatched embedded document identity", () => {
    expect(() =>
      decodeCanvasShareSnapshotRequest({
        ...request,
        audience: {
          ...request.audience,
          principals: [
            {
              label: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
              principalKind: "paired-device",
              principalId: ids.audience,
            },
          ],
        },
      }),
    ).toThrow();

    const record = {
      schemaVersion: 1,
      kind: "canvas-share-snapshot-record",
      snapshotId: ids.snapshot,
      exportId: ids.exportId,
      canvasId: ids.canvas,
      versionId: ids.version,
      sequence: 2,
      hostId: "local",
      projectId: ids.project,
      audience: request.audience,
      createdAt: "2026-08-04T12:05:01.000Z",
      expiresAt: request.expiresAt,
      refreshPolicy: "manual-only",
      status: "active",
      consent: request.consent,
      document: {
        ...document,
        canvasId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      },
      provenance: document.provenance,
      sourceManifest: document.sourceManifest,
    } as const;
    expect(() => decodeCanvasShareSnapshotRecord(record)).toThrow();
  });

  it("rejects audience labels with embedded credential-bearing URLs", () => {
    expect(() =>
      decodeCanvasShareSnapshotRequest({
        ...request,
        audience: {
          ...request.audience,
          principals: [
            {
              label: "Reviewer postgres://alice:password@db.example/app",
              principalKind: "paired-device",
              principalId: ids.audience,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("rejects audience labels with credential-bearing URL fragments", () => {
    expect(() =>
      decodeCanvasShareSnapshotRequest({
        ...request,
        audience: {
          ...request.audience,
          principals: [
            {
              label: "Reviewer https://example.test/callback#access_token=opaque-value",
              principalKind: "paired-device",
              principalId: ids.audience,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("rejects snapshot records whose consent actor differs from audience owner", () => {
    expect(() =>
      decodeCanvasShareSnapshotRecord({
        schemaVersion: 1,
        kind: "canvas-share-snapshot-record",
        snapshotId: ids.snapshot,
        exportId: ids.exportId,
        canvasId: ids.canvas,
        versionId: ids.version,
        sequence: 2,
        hostId: "local",
        projectId: ids.project,
        audience: request.audience,
        createdAt: "2026-08-04T12:05:01.000Z",
        expiresAt: request.expiresAt,
        refreshPolicy: "manual-only",
        status: "active",
        consent: {
          ...request.consent,
          acknowledgedBy: {
            kind: "local-user",
            actorId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          },
        },
        document,
        provenance: document.provenance,
        sourceManifest: document.sourceManifest,
      }),
    ).toThrow();
  });

  it("rejects secret-bearing document titles at decode time", () => {
    expect(() =>
      decodeCanvasShareSnapshotRecord({
        schemaVersion: 1,
        kind: "canvas-share-snapshot-record",
        snapshotId: ids.snapshot,
        exportId: ids.exportId,
        canvasId: ids.canvas,
        versionId: ids.version,
        sequence: 2,
        hostId: "local",
        projectId: ids.project,
        audience: request.audience,
        createdAt: "2026-08-04T12:05:01.000Z",
        expiresAt: request.expiresAt,
        refreshPolicy: "manual-only",
        status: "active",
        consent: request.consent,
        document: {
          ...document,
          title: "Bearer abcdefghijklmnop",
        },
        provenance: document.provenance,
        sourceManifest: document.sourceManifest,
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasShareSnapshotRecord({
        schemaVersion: 1,
        kind: "canvas-share-snapshot-record",
        snapshotId: ids.snapshot,
        exportId: ids.exportId,
        canvasId: ids.canvas,
        versionId: ids.version,
        sequence: 2,
        hostId: "local",
        projectId: ids.project,
        audience: request.audience,
        createdAt: "2026-08-04T12:05:01.000Z",
        expiresAt: request.expiresAt,
        refreshPolicy: "manual-only",
        status: "active",
        consent: request.consent,
        document: {
          ...document,
          title: "/Users/alice/project/.env",
        },
        provenance: document.provenance,
        sourceManifest: document.sourceManifest,
      }),
    ).toThrow();
  });

  it("rejects revoked records whose revokedAt predates createdAt", () => {
    expect(() =>
      decodeCanvasShareSnapshotRecord({
        schemaVersion: 1,
        kind: "canvas-share-snapshot-record",
        snapshotId: ids.snapshot,
        exportId: ids.exportId,
        canvasId: ids.canvas,
        versionId: ids.version,
        sequence: 2,
        hostId: "local",
        projectId: ids.project,
        audience: request.audience,
        createdAt: "2026-08-04T12:05:01.000Z",
        expiresAt: request.expiresAt,
        refreshPolicy: "manual-only",
        status: "revoked",
        revokedAt: "2026-08-04T12:00:00.000Z",
        consent: request.consent,
        document,
        provenance: document.provenance,
        sourceManifest: document.sourceManifest,
      }),
    ).toThrow();
  });
  it("carries a revocation time only on a revoked owner-visible row", () => {
    const summary = {
      schemaVersion: 1,
      kind: "canvas-share-snapshot-summary",
      snapshotId: ids.snapshot,
      canvasId: ids.canvas,
      versionId: ids.version,
      sequence: 2,
      hostId: "local",
      projectId: ids.project,
      audience: request.audience,
      createdAt: "2026-08-04T12:05:01.000Z",
      expiresAt: request.expiresAt,
      refreshPolicy: "manual-only",
      status: "active",
    } as const;
    expect(decodeCanvasShareSnapshotSummary(summary)).toEqual(summary);
    // A row is never listed as still shareable while claiming a revocation.
    expect(() =>
      decodeCanvasShareSnapshotSummary({ ...summary, revokedAt: "2026-08-04T13:00:00.000Z" }),
    ).toThrow();
    expect(
      decodeCanvasShareResult({
        kind: "denied",
        denialCode: "revoked",
        message: "This share was withdrawn.",
      }).kind,
    ).toBe("denied");
    // The owner-visible row never carries the shared document itself.
    expect(() => decodeCanvasShareSnapshotSummary({ ...summary, document })).toThrow();
  });
});
