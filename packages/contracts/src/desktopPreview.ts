import { Schema } from "effect";
import { GuidString } from "./schemaPrimitives";

const id = GuidString;
const port = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 }));
const fields = { threadId: id, leaseId: id };
const grant = Schema.Struct({
  grantId: id,
  port,
  expiresAt: Schema.String,
  guestUrl: Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/)),
});

export const DesktopPreviewRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("preview-read"), ...fields }),
  Schema.Struct({ kind: Schema.Literal("preview-review"), ...fields, port }),
  Schema.Struct({ kind: Schema.Literal("preview-grant"), ...fields, reviewId: id }),
  Schema.Struct({ kind: Schema.Literal("preview-revoke"), ...fields, grantId: id }),
]);
export type DesktopPreviewRequest = typeof DesktopPreviewRequest.Type;
export const DesktopPreviewAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("preview-state"),
    grant: Schema.optional(grant),
    available: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literal("preview-review"),
    reviewId: id,
    port,
    processName: Schema.NonEmptyString,
    expiresAt: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("preview-ready"), grant }),
  Schema.Struct({ status: Schema.Literal("preview-revoked") }),
  Schema.Struct({
    status: Schema.Literal("preview-refused"),
    reason: Schema.Literals([
      "unavailable",
      "stale",
      "not-permitted",
      "not-owned",
      "busy",
      "cleanup-unconfirmed",
    ]),
  }),
]);
export type DesktopPreviewAnswer = typeof DesktopPreviewAnswer.Type;

export const DesktopPreviewAudit = Schema.Struct({
  grantId: id,
  leaseId: id,
  threadId: id,
  providerId: Schema.NonEmptyString,
  port,
  expiresAt: Schema.String,
});
