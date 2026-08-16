import {
  decodeCanvasShareSnapshotRequest,
  decodeCanvasShareSnapshotRevokeRequest,
  type CanvasShareSnapshotRecord,
  type CanvasShareSnapshotRequest,
  type CanvasShareSnapshotRevokeRequest,
} from "@octant/contracts/canvas-share-snapshot";
import { decodeCanvasVersion, type CanvasVersion } from "@octant/contracts/canvas";
import type { UtcTimestamp } from "@octant/contracts/events";
import {
  buildCanvasStaticExportDocument,
  type CanvasSharePolicyContext,
} from "./canvasSharePolicy";
import type { CanvasStaticExportRequest } from "@octant/contracts/canvas-share";

export type CanvasShareSnapshotDenialCode =
  | "malformed-request"
  | "sharing-disabled"
  | "consent-required"
  | "scope-mismatch"
  | "stale-version"
  | "expired"
  | "revoked"
  | "audience-required"
  | "unauthorized"
  | "public-audience-forbidden";

export class CanvasShareSnapshotPolicyRejected extends Error {
  override readonly name = "CanvasShareSnapshotPolicyRejected";

  constructor(
    readonly denialCode: CanvasShareSnapshotDenialCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: CanvasShareSnapshotDenialCode, message: string): never {
  throw new CanvasShareSnapshotPolicyRejected(code, message);
}

function parseIso(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) reject("malformed-request", "Canvas share timestamp is invalid.");
  return ms;
}

function decodeAuthoritativeTimestamp(value: string, label: string): UtcTimestamp {
  // Mirror contracts UtcTimestamp: millisecond ISO and Date#toISOString canonical form.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    reject("malformed-request", `Canvas share ${label} must be a canonical UtcTimestamp.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    reject("malformed-request", `Canvas share ${label} must be a canonical UtcTimestamp.`);
  }
  return value as UtcTimestamp;
}

export function validateCanvasShareSnapshotRequest(input: {
  readonly request: unknown;
  readonly current: CanvasVersion;
  readonly context: CanvasSharePolicyContext;
}): CanvasShareSnapshotRequest {
  let request: CanvasShareSnapshotRequest;
  try {
    request = decodeCanvasShareSnapshotRequest(input.request);
  } catch {
    reject("malformed-request", "Canvas share snapshot request is malformed.");
  }
  if (!input.context.sharingEnabled) {
    reject("sharing-disabled", "Canvas sharing is disabled.");
  }
  if (
    request.consent.acknowledgedAuthenticatedSnapshot !== true ||
    request.consent.acknowledgedOwnerVisibleAudience !== true
  ) {
    reject("consent-required", "Authenticated Canvas snapshot requires explicit dual consent.");
  }
  if (request.consent.acknowledgedBy.kind !== "local-user") {
    reject("consent-required", "Canvas snapshot consent must come from a local user.");
  }
  if (input.context.actor === undefined || input.context.actor.kind !== "local-user") {
    reject("consent-required", "Canvas snapshot requires an authenticated local-user caller.");
  }
  if (String(request.consent.acknowledgedBy.actorId) !== String(input.context.actor.actorId)) {
    reject(
      "consent-required",
      "Canvas snapshot consent must match the authenticated local-user caller.",
    );
  }
  if (String(request.audience.ownerActorId) !== String(input.context.actor.actorId)) {
    reject(
      "unauthorized",
      "Canvas snapshot ownership must match the authenticated local-user caller.",
    );
  }
  if (request.audience.principals.length === 0) {
    reject(
      "audience-required",
      "Authenticated Canvas snapshot requires an owner-visible audience.",
    );
  }
  if (String(request.canvasId) !== String(input.current.canvasId)) {
    reject("scope-mismatch", "Canvas snapshot does not match the Canvas identity.");
  }
  if (String(request.versionId) !== String(input.current.versionId)) {
    reject("scope-mismatch", "Canvas snapshot does not match the Canvas version identity.");
  }
  if (request.expectedSequence !== input.current.sequence) {
    reject("stale-version", "Canvas snapshot expected sequence is stale.");
  }
  if (
    request.hostId !== input.context.hostId ||
    request.hostId !== input.current.definition.provenance.hostId
  ) {
    reject("scope-mismatch", "Canvas snapshot host does not match the authoritative host.");
  }
  if (
    String(request.projectId) !== String(input.context.projectId) ||
    String(request.projectId) !== String(input.current.definition.provenance.projectId)
  ) {
    reject("scope-mismatch", "Canvas snapshot Project does not match the authoritative Project.");
  }
  if (parseIso(request.expiresAt) <= parseIso(input.context.nowIso)) {
    reject("expired", "Canvas snapshot expiry must be in the future.");
  }
  // Consent evidence is authoritative server time; client timestamps cannot claim
  // post-expiry or future consent after the snapshot window.
  const acknowledgedAt = decodeAuthoritativeTimestamp(
    String(input.context.nowIso),
    "acknowledgedAt",
  );
  if (parseIso(acknowledgedAt) >= parseIso(request.expiresAt)) {
    reject("expired", "Canvas snapshot consent must occur before expiry.");
  }
  return {
    ...request,
    consent: {
      ...request.consent,
      acknowledgedAt,
    },
  };
}

export function createCanvasShareSnapshotRecord(input: {
  readonly request: unknown;
  readonly current: unknown;
  readonly context: CanvasSharePolicyContext;
  /** @deprecated Optional compatibility no-op; snapshot consent is authoritative. */
  readonly staticExportRequest?: unknown;
}): CanvasShareSnapshotRecord {
  let current: CanvasVersion;
  try {
    current = decodeCanvasVersion(input.current);
  } catch {
    reject("malformed-request", "Canvas version for snapshot is malformed.");
  }
  const request = validateCanvasShareSnapshotRequest({
    request: input.request,
    current,
    context: input.context,
  });
  // Reuse the static-export payload sanitizer only. Authenticated snapshot
  // consent is already validated above and must not require offline-export consent.
  const sanitizerRequest = {
    schemaVersion: 1,
    kind: "canvas-static-export",
    exportId: request.exportId,
    canvasId: request.canvasId,
    versionId: request.versionId,
    expectedSequence: request.expectedSequence,
    hostId: request.hostId,
    projectId: request.projectId,
    channel: "static-export",
    consent: {
      acknowledgedOfflineSnapshot: true,
      acknowledgedNoCredentials: true,
      acknowledgedAt: request.consent.acknowledgedAt,
      acknowledgedBy: request.consent.acknowledgedBy,
    },
  } as CanvasStaticExportRequest;
  const createdAt = decodeAuthoritativeTimestamp(String(input.context.nowIso), "createdAt");
  let document;
  try {
    const sanitized = buildCanvasStaticExportDocument({
      request: sanitizerRequest,
      current,
      exportedAt: createdAt,
    });
    document = {
      ...sanitized,
      channel: "authenticated-snapshot" as const,
      threatModelId: "canvas-share-authenticated-snapshot-v1" as const,
    };
  } catch (error) {
    // buildCanvasStaticExportDocument throws CanvasSharePolicyRejected for unsafe payloads.
    reject(
      "malformed-request",
      error instanceof Error ? error.message : "Canvas snapshot payload is unsafe.",
    );
  }
  return {
    schemaVersion: 1,
    kind: "canvas-share-snapshot-record",
    snapshotId: request.snapshotId,
    exportId: request.exportId,
    canvasId: current.canvasId,
    versionId: current.versionId,
    sequence: current.sequence,
    hostId: request.hostId,
    projectId: request.projectId,
    audience: request.audience,
    createdAt,
    expiresAt: request.expiresAt,
    refreshPolicy: request.refreshPolicy,
    status: "active",
    consent: request.consent,
    document,
    provenance: document.provenance,
    sourceManifest: document.sourceManifest,
  };
}

export function revokeCanvasShareSnapshot(input: {
  readonly record: CanvasShareSnapshotRecord;
  readonly request: unknown;
  readonly nowIso: string;
  readonly actor: { readonly kind: "local-user"; readonly actorId: string };
}): CanvasShareSnapshotRecord {
  let request: CanvasShareSnapshotRevokeRequest;
  try {
    request = decodeCanvasShareSnapshotRevokeRequest(input.request);
  } catch {
    reject("malformed-request", "Canvas share revoke request is malformed.");
  }
  if (String(request.snapshotId) !== String(input.record.snapshotId)) {
    reject("scope-mismatch", "Canvas revoke target does not match the snapshot.");
  }
  if (String(request.canvasId) !== String(input.record.canvasId)) {
    reject("scope-mismatch", "Canvas revoke target does not match the Canvas.");
  }
  if (
    request.hostId !== input.record.hostId ||
    String(request.projectId) !== String(input.record.projectId)
  ) {
    reject("scope-mismatch", "Canvas revoke host/Project does not match the snapshot.");
  }
  if (input.record.status === "revoked") {
    reject("revoked", "Canvas snapshot is already revoked.");
  }
  if (
    input.actor.kind !== "local-user" ||
    request.actor.kind !== "local-user" ||
    String(request.actor.actorId) !== String(input.actor.actorId) ||
    String(input.actor.actorId) !== String(input.record.audience.ownerActorId)
  ) {
    reject("unauthorized", "Only the snapshot owner may revoke the share.");
  }
  return {
    ...input.record,
    status: "revoked",
    revokedAt: decodeAuthoritativeTimestamp(input.nowIso, "revokedAt"),
  };
}

export function evaluateCanvasShareSnapshotAccess(input: {
  readonly record: CanvasShareSnapshotRecord;
  readonly nowIso: string;
  readonly principalId: string;
  readonly principalKind: "local-user" | "paired-device";
}):
  | { readonly allowed: true }
  | { readonly allowed: false; readonly denialCode: CanvasShareSnapshotDenialCode } {
  if (input.record.status === "revoked") {
    return { allowed: false, denialCode: "revoked" };
  }
  if (
    input.record.status === "expired" ||
    parseIso(input.record.expiresAt) <= parseIso(input.nowIso)
  ) {
    return { allowed: false, denialCode: "expired" };
  }
  const allowed = input.record.audience.principals.some(
    (principal) =>
      String(principal.principalId) === String(input.principalId) &&
      principal.principalKind === input.principalKind,
  );
  if (!allowed) {
    return { allowed: false, denialCode: "audience-required" };
  }
  return { allowed: true };
}
