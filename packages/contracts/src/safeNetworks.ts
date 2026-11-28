/**
 * Safe networks and provider runtime network records. Canonical:
 * docs/architecture.md § Octant Shield (safe networks) and § Provider runtime
 * network.
 *
 * A safe network is a place the person trusts: a host, a domain, an address
 * range, or a private-network tag. The account holds a default list and a
 * Project may hold its own list, which then replaces the default for that
 * Project. A provider runtime launched below Full access reaches only its
 * provider's own endpoints, its Project's egress rules, and these places,
 * through the host's per-launch egress proxy; every decision is journaled per
 * host on the launch's own aggregate.
 *
 * Payloads never carry a launch token, URL path, header, or body; strict
 * decoding refuses any field that is not named here.
 */

import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateId, UtcTimestamp } from "./events";
import { ToolEgressDecisionEntry, ToolEgressLaunchId, ToolEgressRecordedHost } from "./toolEgress";
import { MAX_TOOL_EGRESS_HOST_LENGTH, ToolEgressPort } from "./toolEgressHost";

export const SAFE_NETWORKS_AGGREGATE = "safe-networks";
/** The account default's aggregate id; a Project's list lives under the Project's id. */
export const SAFE_NETWORKS_ACCOUNT_AGGREGATE_ID = "5afe0000-0000-4000-8000-000000000000";
/** The Network limits switch's aggregate id, beside the account default's. */
export const SAFE_NETWORKS_LIMITS_AGGREGATE_ID = "5afe0000-0000-4000-8000-000000000001";
export const SAFE_NETWORKS_EVENT_NAMES = {
  limitsSet: "safe-networks.limits-set@1",
  placesSet: "safe-networks.places-set@1",
  projectOverrideCleared: "safe-networks.project-override-cleared@1",
} as const;

export const RUNTIME_NETWORK_AGGREGATE = "runtime-network";
export const RUNTIME_NETWORK_EVENT_NAMES = {
  launchStarted: "runtime-network.launch-started@1",
  decisionsRecorded: "runtime-network.decisions-recorded@1",
  launchSummarized: "runtime-network.launch-summarized@1",
  reviewerAllowed: "runtime-network.reviewer-allowed@1",
} as const;

/** Places one scope may hold. */
export const MAX_SAFE_NETWORK_PLACES = 64;
/** Recently refused hosts the Safe networks view lists, newest first. */
export const MAX_SAFE_NETWORK_REFUSALS = 32;

/**
 * Private networks a person can trust by name. `this-mac` is loopback,
 * `local-network` the private IPv4 ranges and IPv6 unique-local addresses,
 * and `overlay-network` the shared address space private overlay networks
 * assign from. Link-local addresses, cloud metadata among them, belong to no
 * tag and no range may cover them.
 */
export const SafeNetworkPrivateTag = Schema.Literals([
  "this-mac",
  "local-network",
  "overlay-network",
]);
export type SafeNetworkPrivateTag = typeof SafeNetworkPrivateTag.Type;

/** What a person typed for a host or a domain; the host canonicalizes it and refuses what no place may name. */
const typedName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_TOOL_EGRESS_HOST_LENGTH),
);
/** An address range in CIDR form, `192.168.1.0/24` or `fd00::/8`; a bare address is a one-address range. */
const typedRange = Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(64));
const optionalPort = Schema.optional(ToolEgressPort);

/**
 * One trusted place. A `host` matches that name only, a `domain` the name and
 * every name under it. A place without a port matches every port.
 */
export const SafeNetworkPlace = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("host"), host: typedName, port: optionalPort }),
  Schema.Struct({
    kind: Schema.Literal("domain"),
    domain: typedName,
    port: optionalPort,
  }),
  Schema.Struct({
    kind: Schema.Literal("range"),
    range: typedRange,
    port: optionalPort,
  }),
  Schema.Struct({
    kind: Schema.Literal("private-network"),
    tag: SafeNetworkPrivateTag,
    port: optionalPort,
  }),
]);
export type SafeNetworkPlace = typeof SafeNetworkPlace.Type;

export const SafeNetworkPlaces = Schema.Array(SafeNetworkPlace).check(
  Schema.isMaxLength(MAX_SAFE_NETWORK_PLACES),
);

export const SafeNetworkScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("account") }),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: AggregateId }),
]);
export type SafeNetworkScope = typeof SafeNetworkScope.Type;

/**
 * Only the host's own person changes what is trusted: at a local window, or on
 * a device that person paired, whose id the event's actor names.
 */
const SafeNetworkPerson = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local-window") }),
  Schema.Struct({ kind: Schema.Literal("person-paired-device") }),
]);

/** The whole list for one scope, in canonical form, replacing the one before. */
export const SafeNetworksPlacesSetPayload = Schema.Struct({
  scope: SafeNetworkScope,
  places: SafeNetworkPlaces,
  principal: SafeNetworkPerson,
});
export type SafeNetworksPlacesSetPayload = typeof SafeNetworksPlacesSetPayload.Type;

/** Network limits turned on or off for runtimes launched from now on. */
export const SafeNetworksLimitsSetPayload = Schema.Struct({
  enabled: Schema.Boolean,
  principal: SafeNetworkPerson,
});
export type SafeNetworksLimitsSetPayload = typeof SafeNetworksLimitsSetPayload.Type;

/** A Project goes back to the account default. */
export const SafeNetworksProjectOverrideClearedPayload = Schema.Struct({
  projectId: AggregateId,
  principal: SafeNetworkPerson,
});
export type SafeNetworksProjectOverrideClearedPayload =
  typeof SafeNetworksProjectOverrideClearedPayload.Type;

/** The runtimes whose own process, or Claude's command sandbox, runs on the proxy. */
export const RuntimeNetworkRuntime = Schema.Literals([
  "claude",
  "claude-sandbox",
  "codex",
  "opencode",
  "acp",
  "pi",
  "terminal",
]);
export type RuntimeNetworkRuntime = typeof RuntimeNetworkRuntime.Type;

/** One proxied provider runtime launch: which runtime, and the Project whose rules and places apply. */
export const RuntimeNetworkLaunch = Schema.Struct({
  launchId: ToolEgressLaunchId,
  runtime: RuntimeNetworkRuntime,
  /** The ACP agent profile, for an `acp` launch. */
  profileId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64))),
  /** Absent when the launch's folder belongs to no Project, as a Chat scratch folder or a probe. */
  projectId: Schema.optional(AggregateId),
  executionPolicy: Schema.Literals(["approval-gated", "auto-accept-edits", "plan"]),
});
export type RuntimeNetworkLaunch = typeof RuntimeNetworkLaunch.Type;

export const RuntimeNetworkLaunchStartedPayload = Schema.Struct({
  launch: RuntimeNetworkLaunch,
  startedAt: UtcTimestamp,
});
export type RuntimeNetworkLaunchStartedPayload = typeof RuntimeNetworkLaunchStartedPayload.Type;

export const RuntimeNetworkDecisionsRecordedPayload = Schema.Struct({
  launchId: ToolEgressLaunchId,
  entries: Schema.Array(ToolEgressDecisionEntry).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
});
export type RuntimeNetworkDecisionsRecordedPayload =
  typeof RuntimeNetworkDecisionsRecordedPayload.Type;

const byteCount = NonNegativeInt;

export const RuntimeNetworkLaunchSummarizedPayload = Schema.Struct({
  launchId: ToolEgressLaunchId,
  endedAt: UtcTimestamp,
  bytesSent: byteCount,
  bytesReceived: byteCount,
  malformedRequests: byteCount,
  entries: Schema.Array(ToolEgressDecisionEntry).check(Schema.isMaxLength(64)),
  truncated: Schema.Boolean,
});
export type RuntimeNetworkLaunchSummarizedPayload =
  typeof RuntimeNetworkLaunchSummarizedPayload.Type;

/**
 * A reviewer let one host through for this launch alone. It never becomes a
 * place, a rule, or anything another launch reads.
 */
export const RuntimeNetworkReviewerAllowedPayload = Schema.Struct({
  launchId: ToolEgressLaunchId,
  host: ToolEgressRecordedHost,
  port: ToolEgressPort,
  reviewer: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  reason: Schema.String.check(Schema.isMaxLength(280)),
});
export type RuntimeNetworkReviewerAllowedPayload = typeof RuntimeNetworkReviewerAllowedPayload.Type;

/** A host a provider runtime was refused, as Safe networks lists it for the person to trust. */
export const SafeNetworkRefusalView = Schema.Struct({
  host: ToolEgressRecordedHost,
  port: NonNegativeInt,
  runtime: RuntimeNetworkRuntime,
  requests: PositiveInt,
  lastRefusedAt: UtcTimestamp,
});
export type SafeNetworkRefusalView = typeof SafeNetworkRefusalView.Type;

/**
 * Settings › Permissions › Safe networks for one caller: the account default and,
 * when a Project is asked about, its override (`null` while it follows the
 * default), with the hosts its runtimes were recently refused.
 */
export const SafeNetworksView = Schema.Struct({
  account: SafeNetworkPlaces,
  project: Schema.optional(
    Schema.Struct({
      projectId: AggregateId,
      override: Schema.NullOr(SafeNetworkPlaces),
    }),
  ),
  refused: Schema.Array(SafeNetworkRefusalView).check(
    Schema.isMaxLength(MAX_SAFE_NETWORK_REFUSALS),
  ),
  /** Whether this computer can route provider runtimes through the proxy at all. */
  enforced: Schema.Boolean,
  /** The Network limits switch: whether runtimes launched from now on run through it. Off by default. */
  limitsOn: Schema.Boolean,
});
export type SafeNetworksView = typeof SafeNetworksView.Type;

export const SafeNetworksCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("set-limits"), enabled: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("set-places"),
    scope: SafeNetworkScope,
    places: SafeNetworkPlaces,
  }),
  Schema.Struct({
    kind: Schema.Literal("clear-project-override"),
    projectId: AggregateId,
  }),
]);
export type SafeNetworksCommand = typeof SafeNetworksCommand.Type;

export const SafeNetworksRefusalReason = Schema.Literals([
  "needs-local-window",
  "invalid-place",
  "covers-link-local",
  "project-not-found",
  "unavailable",
]);
export type SafeNetworksRefusalReason = typeof SafeNetworksRefusalReason.Type;

export const SafeNetworksCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("safe-networks-updated"),
    view: SafeNetworksView,
  }),
  Schema.Struct({
    kind: Schema.Literal("safe-networks-refused"),
    reason: SafeNetworksRefusalReason,
    message: Schema.String,
    /** The position of the place that was refused, when one was. */
    placeIndex: Schema.optional(NonNegativeInt),
  }),
]);
export type SafeNetworksCommandResult = typeof SafeNetworksCommandResult.Type;

export const decodeSafeNetworksCommand = Schema.decodeUnknownSync(
  SafeNetworksCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeSafeNetworksView = Schema.decodeUnknownSync(
  SafeNetworksView,
  STRICT_DECODE_OPTIONS,
);
export const decodeSafeNetworksCommandResult = Schema.decodeUnknownSync(
  SafeNetworksCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeSafeNetworksPlacesSetPayload = Schema.decodeUnknownSync(
  SafeNetworksPlacesSetPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeSafeNetworksLimitsSetPayload = Schema.decodeUnknownSync(
  SafeNetworksLimitsSetPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeSafeNetworksProjectOverrideClearedPayload = Schema.decodeUnknownSync(
  SafeNetworksProjectOverrideClearedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeRuntimeNetworkLaunchStartedPayload = Schema.decodeUnknownSync(
  RuntimeNetworkLaunchStartedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeRuntimeNetworkDecisionsRecordedPayload = Schema.decodeUnknownSync(
  RuntimeNetworkDecisionsRecordedPayload,
  STRICT_DECODE_OPTIONS,
);
