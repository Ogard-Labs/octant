import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const id = Schema.UUID;
const port = Schema.Int.pipe(Schema.between(1024, 65535));
const fields = { threadId: id, leaseId: id };
const grant = Schema.Struct({
  grantId: id,
  port,
  expiresAt: Schema.String,
  guestUrl: Schema.String.pipe(Schema.pattern(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/)),
}).annotations(strict);

export const DesktopPreviewRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("preview-read"), ...fields }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("preview-review"), ...fields, port }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("preview-grant"), ...fields, reviewId: id }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("preview-revoke"), ...fields, grantId: id }).annotations(
    strict,
  ),
);
export type DesktopPreviewRequest = typeof DesktopPreviewRequest.Type;
export const DesktopPreviewAnswer = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("preview-state"),
    grant: Schema.optional(grant),
    available: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("preview-review"),
    reviewId: id,
    port,
    processName: Schema.NonEmptyString,
    expiresAt: Schema.String,
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("preview-ready"), grant }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("preview-revoked") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("preview-refused"),
    reason: Schema.Literal(
      "unavailable",
      "stale",
      "not-permitted",
      "not-owned",
      "busy",
      "cleanup-unconfirmed",
    ),
  }).annotations(strict),
);
export type DesktopPreviewAnswer = typeof DesktopPreviewAnswer.Type;

export const DesktopPreviewAudit = Schema.Struct({
  grantId: id,
  leaseId: id,
  threadId: id,
  providerId: Schema.NonEmptyString,
  port,
  expiresAt: Schema.String,
}).annotations(strict);
