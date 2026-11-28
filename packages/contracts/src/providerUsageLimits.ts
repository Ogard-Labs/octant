import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ProviderServiceLimits } from "./context";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId } from "./providers";

const BoundedMessage = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512));

export const ProviderUsageLimitsSource = Schema.Literals(["provider-runtime", "local-observer"]);
export type ProviderUsageLimitsSource = typeof ProviderUsageLimitsSource.Type;

export const ProviderUsageLimitsFailure = Schema.Struct({
  category: Schema.Literals(["unavailable", "rate-limited", "timeout", "protocol"]),
  message: BoundedMessage,
  retryAt: Schema.optional(UtcTimestamp),
});
export type ProviderUsageLimitsFailure = typeof ProviderUsageLimitsFailure.Type;

const ProviderUsageLimitsIdentity = {
  providerInstanceId: ProviderInstanceId,
  source: ProviderUsageLimitsSource,
  observedAt: UtcTimestamp,
};

/**
 * Why no limits are shown. `unsupported` means the runtime can report limits
 * but has not yet; the other reasons say the runtime never will, so a reader
 * is not left waiting for a report that cannot come: an ACP or CLI protocol
 * without a limits channel, a runtime that runs on this computer with no
 * account behind it, or an HTTP endpoint that completed a turn without
 * rate-limit headers.
 */
export const ProviderUsageLimitsUnavailableReason = Schema.Literals([
  "unsupported",
  "not-configured",
  "not-ready",
  "runtime-does-not-report",
  "local-runtime",
  "endpoint-silent",
  "plan-limits-do-not-apply",
]);
export type ProviderUsageLimitsUnavailableReason = typeof ProviderUsageLimitsUnavailableReason.Type;

export const ProviderUsageLimitsEntry = Schema.Union([
  Schema.Struct({
    ...ProviderUsageLimitsIdentity,
    status: Schema.Literal("available"),
    limits: ProviderServiceLimits,
  }),
  Schema.Struct({
    ...ProviderUsageLimitsIdentity,
    status: Schema.Literal("unavailable"),
    reason: ProviderUsageLimitsUnavailableReason,
  }),
  Schema.Struct({
    ...ProviderUsageLimitsIdentity,
    status: Schema.Literal("failed"),
    failure: ProviderUsageLimitsFailure,
    staleLimits: Schema.optional(ProviderServiceLimits),
    lastSuccessfulAt: Schema.optional(UtcTimestamp),
  }),
]);
export type ProviderUsageLimitsEntry = typeof ProviderUsageLimitsEntry.Type;

export const ProviderUsageLimitsSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  refreshedAt: UtcTimestamp,
  entries: Schema.Array(ProviderUsageLimitsEntry).check(Schema.isMaxLength(128)),
});
export type ProviderUsageLimitsSnapshot = typeof ProviderUsageLimitsSnapshot.Type;

export const decodeProviderUsageLimitsSnapshot = Schema.decodeUnknownSync(
  ProviderUsageLimitsSnapshot,
  STRICT_DECODE_OPTIONS,
);
