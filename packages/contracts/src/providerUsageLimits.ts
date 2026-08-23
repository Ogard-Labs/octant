import { Schema } from "effect";
import { ProviderServiceLimits } from "./context";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const BoundedMessage = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));

export const ProviderUsageLimitsSource = Schema.Literal("provider-runtime", "local-observer");
export type ProviderUsageLimitsSource = typeof ProviderUsageLimitsSource.Type;

export const ProviderUsageLimitsFailure = Schema.Struct({
  category: Schema.Literal("unavailable", "rate-limited", "timeout", "protocol"),
  message: BoundedMessage,
  retryAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type ProviderUsageLimitsFailure = typeof ProviderUsageLimitsFailure.Type;

const ProviderUsageLimitsIdentity = {
  providerInstanceId: ProviderInstanceId,
  source: ProviderUsageLimitsSource,
  observedAt: UtcTimestamp,
};

export const ProviderUsageLimitsEntry = Schema.Union(
  Schema.Struct({
    ...ProviderUsageLimitsIdentity,
    status: Schema.Literal("available"),
    limits: ProviderServiceLimits,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderUsageLimitsIdentity,
    status: Schema.Literal("unavailable"),
    reason: Schema.Literal("unsupported", "not-configured", "not-ready"),
  }).annotations(strict),
  Schema.Struct({
    ...ProviderUsageLimitsIdentity,
    status: Schema.Literal("failed"),
    failure: ProviderUsageLimitsFailure,
    staleLimits: Schema.optional(ProviderServiceLimits),
    lastSuccessfulAt: Schema.optional(UtcTimestamp),
  }).annotations(strict),
);
export type ProviderUsageLimitsEntry = typeof ProviderUsageLimitsEntry.Type;

export const ProviderUsageLimitsSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  refreshedAt: UtcTimestamp,
  entries: Schema.Array(ProviderUsageLimitsEntry).pipe(Schema.maxItems(128)),
}).annotations(strict);
export type ProviderUsageLimitsSnapshot = typeof ProviderUsageLimitsSnapshot.Type;

export const decodeProviderUsageLimitsSnapshot = Schema.decodeUnknownSync(
  ProviderUsageLimitsSnapshot,
);
