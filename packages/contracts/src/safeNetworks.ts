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
import { AggregateId, UtcTimestamp } from "./events";
import { ToolEgressDecisionEntry, ToolEgressLaunchId, ToolEgressRecordedHost } from "./toolEgress";
import { MAX_TOOL_EGRESS_HOST_LENGTH, ToolEgressPort } from "./toolEgressHost";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SAFE_NETWORKS_AGGREGATE = "safe-networks";
/** The account default's aggregate id; a Project's list lives under the Project's id. */
export const SAFE_NETWORKS_ACCOUNT_AGGREGATE_ID = "5afe0000-0000-4000-8000-000000000000";
export const SAFE_NETWORKS_EVENT_NAMES = {
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
export const SafeNetworkPrivateTag = Schema.Literal("this-mac", "local-network", "overlay-network");
export type SafeNetworkPrivateTag = typeof SafeNetworkPrivateTag.Type;

/** What a person typed for a host or a domain; the host canonicalizes it and refuses what no place may name. */
const typedName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(MAX_TOOL_EGRESS_HOST_LENGTH),
);
/** An address range in CIDR form, `192.168.1.0/24` or `fd00::/8`; a bare address is a one-address range. */
const typedRange = Schema.String.pipe(Schema.minLength(2), Schema.maxLength(64));
const optionalPort = Schema.optional(ToolEgressPort);

/**
 * One trusted place. A `host` matches that name only, a `domain` the name and
 * every name under it. A place without a port matches every port.
 */
export const SafeNetworkPlace = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("host"), host: typedName, port: optionalPort }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("domain"),
    domain: typedName,
    port: optionalPort,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("range"),
    range: typedRange,
    port: optionalPort,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("private-network"),
    tag: SafeNetworkPrivateTag,
    port: optionalPort,
  }).annotations(strict),
);
export type SafeNetworkPlace = typeof SafeNetworkPlace.Type;

export const SafeNetworkPlaces = Schema.Array(SafeNetworkPlace).pipe(
  Schema.maxItems(MAX_SAFE_NETWORK_PLACES),
);

export const SafeNetworkScope = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("account") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: AggregateId }).annotations(strict),
);
export type SafeNetworkScope = typeof SafeNetworkScope.Type;

/** Only a person at a local window changes what is trusted. */
const localWindow = Schema.Struct({ kind: Schema.Literal("local-window") }).annotations(strict);

/** The whole list for one scope, in canonical form, replacing the one before. */
export const SafeNetworksPlacesSetPayload = Schema.Struct({
  scope: SafeNetworkScope,
  places: SafeNetworkPlaces,
  principal: localWindow,
}).annotations(strict);
export type SafeNetworksPlacesSetPayload = typeof SafeNetworksPlacesSetPayload.Type;

/** A Project goes back to the account default. */
export const SafeNetworksProjectOverrideClearedPayload = Schema.Struct({
  projectId: AggregateId,
  principal: localWindow,
}).annotations(strict);
export type SafeNetworksProjectOverrideClearedPayload =
  typeof SafeNetworksProjectOverrideClearedPayload.Type;

/** The runtimes whose own process (or, for Claude, whose command sandbox) runs on the proxy. */
export const RuntimeNetworkRuntime = Schema.Literal(
  "claude-sandbox",
  "codex",
  "opencode",
  "acp",
  "pi",
);
export type RuntimeNetworkRuntime = typeof RuntimeNetworkRuntime.Type;

/** One proxied provider runtime launch: which runtime, and the Project whose rules and places apply. */
export const RuntimeNetworkLaunch = Schema.Struct({
  launchId: ToolEgressLaunchId,
  runtime: RuntimeNetworkRuntime,
  /** The ACP agent profile, for an `acp` launch. */
  profileId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64))),
  /** Absent when the launch's folder belongs to no Project, as a Chat scratch folder or a probe. */
  projectId: Schema.optional(AggregateId),
  executionPolicy: Schema.Literal("approval-gated", "auto-accept-edits", "plan"),
}).annotations(strict);
export type RuntimeNetworkLaunch = typeof RuntimeNetworkLaunch.Type;

export const RuntimeNetworkLaunchStartedPayload = Schema.Struct({
  launch: RuntimeNetworkLaunch,
  startedAt: UtcTimestamp,
}).annotations(strict);
export type RuntimeNetworkLaunchStartedPayload = typeof RuntimeNetworkLaunchStartedPayload.Type;

export const RuntimeNetworkDecisionsRecordedPayload = Schema.Struct({
  launchId: ToolEgressLaunchId,
  entries: Schema.Array(ToolEgressDecisionEntry).pipe(Schema.minItems(1), Schema.maxItems(16)),
}).annotations(strict);
export type RuntimeNetworkDecisionsRecordedPayload =
  typeof RuntimeNetworkDecisionsRecordedPayload.Type;

const byteCount = Schema.Int.pipe(Schema.nonNegative());

export const RuntimeNetworkLaunchSummarizedPayload = Schema.Struct({
  launchId: ToolEgressLaunchId,
  endedAt: UtcTimestamp,
  bytesSent: byteCount,
  bytesReceived: byteCount,
  malformedRequests: byteCount,
  entries: Schema.Array(ToolEgressDecisionEntry).pipe(Schema.maxItems(64)),
  truncated: Schema.Boolean,
}).annotations(strict);
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
  reviewer: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  reason: Schema.String.pipe(Schema.maxLength(280)),
}).annotations(strict);
export type RuntimeNetworkReviewerAllowedPayload = typeof RuntimeNetworkReviewerAllowedPayload.Type;

/** A host a provider runtime was refused, as Safe networks lists it for the person to trust. */
export const SafeNetworkRefusalView = Schema.Struct({
  host: ToolEgressRecordedHost,
  port: Schema.Int.pipe(Schema.nonNegative()),
  runtime: RuntimeNetworkRuntime,
  requests: Schema.Int.pipe(Schema.positive()),
  lastRefusedAt: UtcTimestamp,
}).annotations(strict);
export type SafeNetworkRefusalView = typeof SafeNetworkRefusalView.Type;

/**
 * Settings › Access › Safe networks for one caller: the account default and,
 * when a Project is asked about, its override (`null` while it follows the
 * default), with the hosts its runtimes were recently refused.
 */
export const SafeNetworksView = Schema.Struct({
  account: SafeNetworkPlaces,
  project: Schema.optional(
    Schema.Struct({
      projectId: AggregateId,
      override: Schema.NullOr(SafeNetworkPlaces),
    }).annotations(strict),
  ),
  refused: Schema.Array(SafeNetworkRefusalView).pipe(Schema.maxItems(MAX_SAFE_NETWORK_REFUSALS)),
  /** Whether provider runtimes on this host run through the proxy at all. */
  enforced: Schema.Boolean,
}).annotations(strict);
export type SafeNetworksView = typeof SafeNetworksView.Type;

export const SafeNetworksCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("set-places"),
    scope: SafeNetworkScope,
    places: SafeNetworkPlaces,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("clear-project-override"),
    projectId: AggregateId,
  }).annotations(strict),
);
export type SafeNetworksCommand = typeof SafeNetworksCommand.Type;

export const SafeNetworksRefusalReason = Schema.Literal(
  "needs-local-window",
  "invalid-place",
  "covers-link-local",
  "project-not-found",
  "unavailable",
);
export type SafeNetworksRefusalReason = typeof SafeNetworksRefusalReason.Type;

export const SafeNetworksCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("safe-networks-updated"),
    view: SafeNetworksView,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("safe-networks-refused"),
    reason: SafeNetworksRefusalReason,
    message: Schema.String,
    /** The position of the place that was refused, when one was. */
    placeIndex: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  }).annotations(strict),
);
export type SafeNetworksCommandResult = typeof SafeNetworksCommandResult.Type;

export const decodeSafeNetworksCommand = Schema.decodeUnknownSync(SafeNetworksCommand);
export const decodeSafeNetworksView = Schema.decodeUnknownSync(SafeNetworksView);
export const decodeSafeNetworksCommandResult = Schema.decodeUnknownSync(SafeNetworksCommandResult);
export const decodeSafeNetworksPlacesSetPayload = Schema.decodeUnknownSync(
  SafeNetworksPlacesSetPayload,
);
export const decodeSafeNetworksProjectOverrideClearedPayload = Schema.decodeUnknownSync(
  SafeNetworksProjectOverrideClearedPayload,
);
export const decodeRuntimeNetworkLaunchStartedPayload = Schema.decodeUnknownSync(
  RuntimeNetworkLaunchStartedPayload,
);
export const decodeRuntimeNetworkDecisionsRecordedPayload = Schema.decodeUnknownSync(
  RuntimeNetworkDecisionsRecordedPayload,
);
