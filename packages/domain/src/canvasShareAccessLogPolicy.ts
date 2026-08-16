import {
  decodeCanvasShareAccessLogEvent,
  type CanvasShareAccessLogEvent,
  type CanvasShareAccessOutcome,
} from "@octant/contracts/canvas-share-access-log";
import type { CanvasShareSnapshotRecord } from "@octant/contracts/canvas-share-snapshot";
import { evaluateCanvasShareSnapshotAccess } from "./canvasShareSnapshotPolicy";
import type { UtcTimestamp } from "@octant/contracts/events";

export type CanvasShareAccessLogDenialCode =
  | "malformed-event"
  | "scope-mismatch"
  | "privacy-violation";

export class CanvasShareAccessLogPolicyRejected extends Error {
  override readonly name = "CanvasShareAccessLogPolicyRejected";
  constructor(
    readonly denialCode: CanvasShareAccessLogDenialCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: CanvasShareAccessLogDenialCode, message: string): never {
  throw new CanvasShareAccessLogPolicyRejected(code, message);
}

function parseIso(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) reject("malformed-event", "Access log timestamp is invalid.");
  return ms;
}

const FORBIDDEN_KEY =
  /(?:authorization|cookie|password|token|secret|useragent|user-agent|rawbody|path)/i;
const SECRET_VALUE_PATTERN =
  /(?:sk-(?:proj-)?[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|Basic\s+[A-Za-z0-9+/=]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const FILE_PATH_PATTERN = /(?:^|[\s"'`])(?:\/(?:Users|home|var|tmp|private)\/|\.\.\/|[A-Za-z]:\\)/;

export function assertPrivacySafeAccessLog(event: CanvasShareAccessLogEvent): void {
  for (const key of Object.keys(event)) {
    if (FORBIDDEN_KEY.test(key)) {
      reject("privacy-violation", `Access log field ${key} is forbidden.`);
    }
  }
  if (event.audienceLabel !== undefined) {
    if (
      SECRET_VALUE_PATTERN.test(event.audienceLabel) ||
      FILE_PATH_PATTERN.test(event.audienceLabel) ||
      /Mozilla\//i.test(event.audienceLabel)
    ) {
      reject(
        "privacy-violation",
        "Access log audienceLabel contains a forbidden privacy-sensitive value.",
      );
    }
  }
}

export function classifyBrowserFamily(
  userAgent: string | undefined,
): CanvasShareAccessLogEvent["browserFamily"] {
  const value = (userAgent ?? "").toLowerCase();
  if (value.includes("edg/")) return "edge";
  if (value.includes("chrome/") && !value.includes("edg/")) return "chrome";
  if (value.includes("safari/") && !value.includes("chrome/")) return "safari";
  if (value.includes("firefox/")) return "firefox";
  return "other";
}

function resolvePrincipalKind(
  record: CanvasShareSnapshotRecord,
  principalId: string,
): "local-user" | "paired-device" {
  return (
    record.audience.principals.find(
      (principal) => String(principal.principalId) === String(principalId),
    )?.principalKind ?? "local-user"
  );
}

function expectedAccessOutcome(input: {
  readonly record: CanvasShareSnapshotRecord;
  readonly nowIso: string;
  readonly principalId: string;
  readonly sourceDeleted?: boolean;
  readonly scopeMismatch?: boolean;
  readonly sharingDisabled?: boolean;
}): CanvasShareAccessOutcome {
  // A host that does not share refuses before it reads the request's scope at
  // all, so this outranks even a scope mismatch.
  if (input.sharingDisabled) return "denied-sharing-disabled";
  // A request naming a different Canvas, host, or Project is refused before the
  // snapshot's own lifecycle is ever consulted, so it outranks every other
  // reason.
  if (input.scopeMismatch) return "denied-scope-mismatch";
  if (input.sourceDeleted) return "denied-deleted-source";
  const access = evaluateCanvasShareSnapshotAccess({
    record: input.record,
    nowIso: input.nowIso,
    principalId: input.principalId,
    principalKind: resolvePrincipalKind(input.record, input.principalId),
  });
  if (access.allowed) return "allowed";
  if (access.denialCode === "expired") return "denied-expired";
  if (access.denialCode === "revoked") return "denied-revoked";
  return "denied-audience";
}

export function buildCanvasShareAccessLogEvent(input: {
  readonly eventId: string;
  readonly record: CanvasShareSnapshotRecord;
  readonly nowIso: string;
  readonly principalId: string;
  readonly userAgent?: string;
  readonly sourceDeleted?: boolean;
  /**
   * Authoritative scope evaluation: the request named a Canvas, host, or
   * Project that is not this snapshot's. The event still carries the
   * snapshot's own scope, never the scope the caller supplied.
   */
  readonly scopeMismatch?: boolean;
  /**
   * Authoritative host share posture: this host does not share at all, so the
   * read is refused before its scope or the snapshot's lifecycle is consulted.
   */
  readonly sharingDisabled?: boolean;
}): CanvasShareAccessLogEvent {
  const outcome = expectedAccessOutcome({
    record: input.record,
    nowIso: input.nowIso,
    principalId: input.principalId,
    ...(input.sourceDeleted !== undefined ? { sourceDeleted: input.sourceDeleted } : {}),
    ...(input.scopeMismatch !== undefined ? { scopeMismatch: input.scopeMismatch } : {}),
    ...(input.sharingDisabled !== undefined ? { sharingDisabled: input.sharingDisabled } : {}),
  });

  const audienceLabel = input.record.audience.principals.find(
    (principal) => String(principal.principalId) === String(input.principalId),
  )?.label;

  const event = {
    schemaVersion: 1 as const,
    kind: "canvas-share-access-log" as const,
    eventId: input.eventId,
    snapshotId: input.record.snapshotId,
    canvasId: input.record.canvasId,
    hostId: input.record.hostId,
    projectId: input.record.projectId,
    occurredAt: input.nowIso as UtcTimestamp,
    outcome,
    browserFamily: classifyBrowserFamily(input.userAgent),
    principalId: input.principalId,
    ...(audienceLabel ? { audienceLabel } : {}),
  };
  const decoded = decodeCanvasShareAccessLogEvent(event);
  assertPrivacySafeAccessLog(decoded);
  return decoded;
}

function resolveAuthenticatedPrincipalId(input: {
  readonly event: CanvasShareAccessLogEvent;
  readonly record: CanvasShareSnapshotRecord;
}): string | undefined {
  if (input.event.principalId !== undefined) {
    return String(input.event.principalId);
  }
  if (input.event.audienceLabel === undefined) return undefined;
  const principal = input.record.audience.principals.find(
    (entry) => entry.label === input.event.audienceLabel,
  );
  return principal ? String(principal.principalId) : undefined;
}

/**
 * Historical access-log validation uses the snapshot lifecycle at occurredAt.
 * A later revocation must not rewrite prior allowed events.
 */
export function validateCanvasShareAccessLogEvent(input: {
  readonly event: unknown;
  readonly record: CanvasShareSnapshotRecord;
  /** Authenticated principal that produced or is replaying the event. */
  readonly authenticatedPrincipalId: string;
  /** Authoritative source-deletion state observed at event time. */
  readonly sourceDeleted?: boolean;
  /** Authoritative scope evaluation observed at event time. */
  readonly scopeMismatch?: boolean;
  /** Authoritative host share posture observed at event time. */
  readonly sharingDisabled?: boolean;
}): CanvasShareAccessLogEvent {
  let event: CanvasShareAccessLogEvent;
  try {
    event = decodeCanvasShareAccessLogEvent(input.event);
  } catch {
    reject("malformed-event", "Canvas share access log event is malformed.");
  }
  assertPrivacySafeAccessLog(event);
  // Authoritative access identity is always the authenticated principal.
  if (
    event.principalId !== undefined &&
    String(event.principalId) !== String(input.authenticatedPrincipalId)
  ) {
    reject(
      "scope-mismatch",
      "Access log principal must match the authenticated principal context.",
    );
  }
  if (event.audienceLabel !== undefined) {
    const labeledForAuth = input.record.audience.principals.some(
      (principal) =>
        principal.label === event.audienceLabel &&
        String(principal.principalId) === String(input.authenticatedPrincipalId),
    );
    // Labels may be non-unique; if a supplied label matches any audience entry,
    // it must also match the authenticated principal for every outcome.
    const anyLabel = input.record.audience.principals.some(
      (principal) => principal.label === event.audienceLabel,
    );
    if (anyLabel && !labeledForAuth) {
      reject(
        "scope-mismatch",
        "Access log audienceLabel does not match the authenticated principal.",
      );
    }
  }
  if (parseIso(event.occurredAt) < parseIso(input.record.createdAt)) {
    reject("scope-mismatch", "Access log event cannot predate snapshot creation.");
  }
  if (String(event.snapshotId) !== String(input.record.snapshotId)) {
    reject("scope-mismatch", "Access log snapshot does not match the record.");
  }
  if (String(event.canvasId) !== String(input.record.canvasId)) {
    reject("scope-mismatch", "Access log Canvas does not match the record.");
  }
  if (event.hostId !== input.record.hostId) {
    reject("scope-mismatch", "Access log host does not match the snapshot host.");
  }
  if (String(event.projectId) !== String(input.record.projectId)) {
    reject("scope-mismatch", "Access log Project does not match the snapshot Project.");
  }

  // Optional audienceLabel is privacy-preserving metadata only; when present it
  // must still map to a known principal.
  if (event.audienceLabel !== undefined) {
    const known = input.record.audience.principals.some(
      (principal) => principal.label === event.audienceLabel,
    );
    if (!known) {
      reject("scope-mismatch", "Access log audience label is not present on the snapshot.");
    }
  }

  if (event.principalId !== undefined) {
    const knownPrincipal = input.record.audience.principals.some(
      (principal) => String(principal.principalId) === String(event.principalId),
    );
    // principalId may identify a denied outsider; only reject when a label is also
    // present and points at a different known principal.
    if (event.audienceLabel !== undefined) {
      const labeledMatches = input.record.audience.principals.some(
        (principal) =>
          principal.label === event.audienceLabel &&
          String(principal.principalId) === String(event.principalId),
      );
      if (!labeledMatches) {
        reject(
          "scope-mismatch",
          "Access log principalId does not match the audienceLabel principal.",
        );
      }
    } else if (!knownPrincipal && event.outcome === "allowed") {
      // Allowed without a label still requires a known principal identity.
      reject("scope-mismatch", "Access log allowed outcome requires a known principal.");
    }
  }

  // A read refused by the host's own share posture never reached the request's
  // scope or the snapshot's lifecycle, so its outcome is neither claimable
  // without that authoritative posture nor replaceable by any other reason
  // once the posture did refuse.
  if (event.outcome === "denied-sharing-disabled") {
    if (input.sharingDisabled !== true) {
      reject(
        "scope-mismatch",
        "Access log denied-sharing-disabled requires an authoritative host share posture.",
      );
    }
    return event;
  }
  if (input.sharingDisabled === true) {
    reject(
      "scope-mismatch",
      "Access log outcome must report denied-sharing-disabled when host sharing is disabled.",
    );
  }

  // A scope-mismatched read is refused before the snapshot's lifecycle is
  // consulted, so its outcome is neither claimable without that evaluation nor
  // replaceable by a lifecycle reason when the evaluation did occur.
  if (event.outcome === "denied-scope-mismatch") {
    if (input.scopeMismatch !== true) {
      reject(
        "scope-mismatch",
        "Access log denied-scope-mismatch requires an authoritative scope evaluation.",
      );
    }
    return event;
  }
  if (input.scopeMismatch === true) {
    reject(
      "scope-mismatch",
      "Access log outcome must report denied-scope-mismatch when the request scope does not match the snapshot.",
    );
  }
  if (event.outcome === "denied-deleted-source") {
    if (input.sourceDeleted !== true) {
      reject(
        "scope-mismatch",
        "Access log denied-deleted-source requires authoritative source deletion state.",
      );
    }
    return event;
  }
  if (input.sourceDeleted === true) {
    reject(
      "scope-mismatch",
      "Access log outcome must report denied-deleted-source when the source is deleted.",
    );
  }

  // Reconstruct the lifecycle as of occurredAt so later revocations do not
  // invalidate historical allowed events.
  const occurredMs = Date.parse(String(event.occurredAt));
  if (!Number.isFinite(occurredMs)) {
    reject("malformed-event", "Access log occurredAt is invalid.");
  }
  const expiresMs = Date.parse(String(input.record.expiresAt));
  if (!Number.isFinite(expiresMs)) {
    reject("malformed-event", "Snapshot expiresAt is invalid.");
  }

  let recordAtEvent: CanvasShareSnapshotRecord = input.record;
  if (input.record.status === "revoked") {
    const revokedAt = input.record.revokedAt;
    const revokedMs = Date.parse(String(revokedAt));
    if (!Number.isFinite(revokedMs)) {
      reject("malformed-event", "Snapshot revokedAt is invalid.");
    }
    if (occurredMs < revokedMs) {
      // Event predates revocation: evaluate against a non-revoked snapshot state.
      const { revokedAt: _ignored, ...rest } = input.record;
      recordAtEvent = {
        ...rest,
        status: expiresMs <= occurredMs ? "expired" : "active",
      } as CanvasShareSnapshotRecord;
    }
  } else if (expiresMs <= occurredMs) {
    recordAtEvent = {
      ...input.record,
      status: "expired",
    } as CanvasShareSnapshotRecord;
  } else if (input.record.status === "expired") {
    // Projection is currently expired, but this event occurred earlier.
    recordAtEvent = {
      ...input.record,
      status: "active",
    } as CanvasShareSnapshotRecord;
  }

  const principalId = String(input.authenticatedPrincipalId);
  if (principalId === undefined) {
    // Without an authenticated principal we can only validate pure lifecycle
    // outcomes that do not depend on audience membership.
    if (recordAtEvent.status === "revoked") {
      if (event.outcome !== "denied-revoked") {
        reject(
          "scope-mismatch",
          "Access log outcome must report denied-revoked for a revoked snapshot.",
        );
      }
      return event;
    }
    if (recordAtEvent.status === "expired" || expiresMs <= occurredMs) {
      if (event.outcome !== "denied-expired") {
        reject(
          "scope-mismatch",
          "Access log outcome must report denied-expired after snapshot expiry.",
        );
      }
      return event;
    }
    if (event.outcome === "denied-revoked") {
      reject("scope-mismatch", "Access log denied-revoked requires a revoked snapshot record.");
    }
    if (event.outcome === "denied-expired") {
      reject("scope-mismatch", "Access log denied-expired requires an expired snapshot.");
    }
    // Active lifecycle without principal context cannot prove audience outcomes.
    if (event.outcome === "allowed" || event.outcome === "denied-audience") {
      reject(
        "scope-mismatch",
        "Access log audience outcomes require an authenticated principal context.",
      );
    }
    return event;
  }

  const expected = expectedAccessOutcome({
    record: recordAtEvent,
    nowIso: event.occurredAt,
    principalId,
  });
  if (event.outcome !== expected) {
    reject(
      "scope-mismatch",
      `Access log outcome ${event.outcome} does not match lifecycle reason ${expected}.`,
    );
  }
  return event;
}

export const CANVAS_SHARE_BROWSER_COMPATIBILITY = ["chrome", "safari", "firefox", "edge"] as const;
