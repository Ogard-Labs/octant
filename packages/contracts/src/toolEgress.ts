/**
 * Harness tool egress rules: what a command the harness runs for a thread may
 * reach through the host's forward proxy, and the journal records of every
 * grant, proposal, and launch. Canonical: docs/architecture.md § Harness tool
 * egress rules.
 *
 * Payloads carry hosts, ports, scopes, expiry, rule and launch identity, the
 * server-resolved principal, and the thread's taint at the time. They never
 * carry a launch token, URL path, header, or body; strict decoding refuses any
 * field that is not named here.
 */

import { Schema } from "effect";
import { AggregateId, EventActorDeviceId, UtcTimestamp } from "./events";
import { NativeHarnessApprovalId } from "./nativeHarness";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const TOOL_EGRESS_THREAD_AGGREGATE = "thread-egress";
export const TOOL_EGRESS_PROJECT_AGGREGATE = "project-egress";
export const TOOL_EGRESS_EVENT_NAMES = {
  threadRuleGranted: "thread.egress-rule-granted@1",
  threadRuleRevoked: "thread.egress-rule-revoked@1",
  projectRuleGranted: "project.egress-rule-granted@1",
  projectRuleRevoked: "project.egress-rule-revoked@1",
  proposalRaised: "thread.egress-proposal-raised@1",
  proposalDeclined: "thread.egress-proposal-declined@1",
  launchStarted: "thread.egress-launch-started@1",
  decisionsRecorded: "thread.egress-decisions-recorded@1",
  launchSummarized: "thread.egress-launch-summarized@1",
  launchIncomplete: "thread.egress-launch-incomplete@1",
} as const;

export const DEFAULT_TOOL_EGRESS_PORT = 443;
/** Live rules one thread, or one Project, may hold at a time. */
export const MAX_LIVE_TOOL_EGRESS_RULES = 64;
export const MAX_TOOL_EGRESS_PROPOSALS_PER_LAUNCH = 16;
export const MAX_OPEN_TOOL_EGRESS_PROPOSALS = 64;
export const MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES = 16;
export const MAX_TOOL_EGRESS_SUMMARY_ENTRIES = 64;
export const MAX_TOOL_EGRESS_HOST_LENGTH = 253;

export const ToolEgressRuleId = brandedUuid("ToolEgressRuleId");
export type ToolEgressRuleId = typeof ToolEgressRuleId.Type;
export const ToolEgressLaunchId = brandedUuid("ToolEgressLaunchId");
export type ToolEgressLaunchId = typeof ToolEgressLaunchId.Type;
export const ToolEgressProposalId = brandedUuid("ToolEgressProposalId");
export type ToolEgressProposalId = typeof ToolEgressProposalId.Type;

export const ToolEgressPort = Schema.Int.pipe(Schema.between(1, 65_535));
export type ToolEgressPort = typeof ToolEgressPort.Type;

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/**
 * A destination name in the form rules are compared in: lowercase IDNA ASCII,
 * letters, digits, and inner hyphens per label, at least two labels, no
 * trailing dot. The last label holds a letter, so a dotted IPv4 literal never
 * passes, and names under `localhost` are refused because they resolve to
 * loopback by definition.
 */
export const TOOL_EGRESS_HOST_NAME_PATTERN = new RegExp(
  `^(?:${DNS_LABEL}\\.)+(?!localhost$)(?=[a-z0-9-]*[a-z])${DNS_LABEL}$`,
);

/**
 * What a rule names: an exact name, or `*.` and a name, which matches that
 * name's subdomains and never the name itself. A wildcard needs at least two
 * labels after it, so `*.com` is not a rule.
 */
export const ToolEgressRuleHost = Schema.String.pipe(
  Schema.maxLength(MAX_TOOL_EGRESS_HOST_LENGTH),
  Schema.filter((value) => {
    const name = value.startsWith("*.") ? value.slice(2) : value;
    return name.length <= MAX_TOOL_EGRESS_HOST_LENGTH && TOOL_EGRESS_HOST_NAME_PATTERN.test(name);
  }),
  Schema.brand("ToolEgressRuleHost"),
);
export type ToolEgressRuleHost = typeof ToolEgressRuleHost.Type;

/** An exact name a proposal asks for; a proposal never names a wildcard. */
export const ToolEgressProposalHost = Schema.String.pipe(
  Schema.maxLength(MAX_TOOL_EGRESS_HOST_LENGTH),
  Schema.pattern(TOOL_EGRESS_HOST_NAME_PATTERN),
  Schema.brand("ToolEgressProposalHost"),
);
export type ToolEgressProposalHost = typeof ToolEgressProposalHost.Type;

/**
 * The destination a decision record names. It may be an IP literal or a name
 * the proxy refused, so it is not held to rule syntax, but it is bounded and
 * holds no path, query, credentials, or whitespace.
 */
export const ToolEgressRecordedHost = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(MAX_TOOL_EGRESS_HOST_LENGTH),
  Schema.pattern(/^[a-z0-9._:-]+$/),
);
export type ToolEgressRecordedHost = typeof ToolEgressRecordedHost.Type;

/**
 * Why the proxy refused a request. Only `no-rule` and `expired` may become a
 * learn-mode proposal; the rest are never proposable.
 */
export const ToolEgressRefusalReason = Schema.Literal(
  "token",
  "ip-literal",
  "invalid-port",
  "invalid-name",
  "no-rule",
  "expired",
  "private-destination",
  "resolve-failed",
  "sni-mismatch",
  "limit",
  "audit-unavailable",
);
export type ToolEgressRefusalReason = typeof ToolEgressRefusalReason.Type;

/** Who answered the `network-access` approval a rule came from. */
export const ToolEgressGrantingPrincipal = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("local-window") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remote-device"),
    deviceId: EventActorDeviceId,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("reviewer") }).annotations(strict),
);
export type ToolEgressGrantingPrincipal = typeof ToolEgressGrantingPrincipal.Type;

/** A person who may take a rule away or turn a proposal down. */
export const ToolEgressPersonPrincipal = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("local-window") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remote-device"),
    deviceId: EventActorDeviceId,
  }).annotations(strict),
);
export type ToolEgressPersonPrincipal = typeof ToolEgressPersonPrincipal.Type;

/**
 * The confined launch a decision, proposal, or record belongs to. A child's
 * launch names its own thread and its parent's; it holds no rules of its own.
 */
export const ToolEgressLaunch = Schema.Struct({
  launchId: ToolEgressLaunchId,
  threadId: AggregateId,
  projectId: AggregateId,
  parentThreadId: Schema.optional(AggregateId),
  toolCallId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
}).annotations(strict);
export type ToolEgressLaunch = typeof ToolEgressLaunch.Type;

/** A thread aggregate's rule covers one launch, or every launch of the thread. */
export const ToolEgressThreadRuleScope = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("call"), launchId: ToolEgressLaunchId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("thread") }).annotations(strict),
);
export type ToolEgressThreadRuleScope = typeof ToolEgressThreadRuleScope.Type;

const byteCount = Schema.Int.pipe(Schema.nonNegative());
// A refused request may have named a port no rule could hold.
const recordedPort = Schema.Int.pipe(Schema.nonNegative());
const requestCount = Schema.Int.pipe(Schema.positive());

/**
 * A reviewer's answer yields only `call` rules, and a tainted thread may be
 * granted only `call` rules, so neither can widen past the launch at hand. A
 * tainted thread's confirmation needs a person, so a reviewer grants nothing
 * there.
 */
export const ThreadEgressRuleGrantedPayload = Schema.Struct({
  ruleId: ToolEgressRuleId,
  threadId: AggregateId,
  host: ToolEgressRuleHost,
  port: ToolEgressPort,
  scope: ToolEgressThreadRuleScope,
  expiresAt: UtcTimestamp,
  principal: ToolEgressGrantingPrincipal,
  approvalId: NativeHarnessApprovalId,
  threadTainted: Schema.Boolean,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (payload) =>
        payload.principal.kind === "reviewer"
          ? payload.scope.kind === "call" && !payload.threadTainted
          : payload.scope.kind === "call" || !payload.threadTainted,
      {
        message: () =>
          "Only call rules may come from a reviewer or a tainted thread, and a reviewer cannot grant on a tainted thread.",
      },
    ),
  );
export type ThreadEgressRuleGrantedPayload = typeof ThreadEgressRuleGrantedPayload.Type;

export const ThreadEgressRuleRevokedPayload = Schema.Struct({
  ruleId: ToolEgressRuleId,
  threadId: AggregateId,
  principal: ToolEgressPersonPrincipal,
  threadTainted: Schema.Boolean,
}).annotations(strict);
export type ThreadEgressRuleRevokedPayload = typeof ThreadEgressRuleRevokedPayload.Type;

/**
 * Project rules come only from a person at a local window whose workspace
 * holds the Project, answering on a thread that is not tainted.
 */
export const ProjectEgressRuleGrantedPayload = Schema.Struct({
  ruleId: ToolEgressRuleId,
  projectId: AggregateId,
  threadId: AggregateId,
  host: ToolEgressRuleHost,
  port: ToolEgressPort,
  expiresAt: UtcTimestamp,
  principal: Schema.Struct({ kind: Schema.Literal("local-window") }).annotations(strict),
  approvalId: NativeHarnessApprovalId,
  threadTainted: Schema.Literal(false),
}).annotations(strict);
export type ProjectEgressRuleGrantedPayload = typeof ProjectEgressRuleGrantedPayload.Type;

export const ProjectEgressRuleRevokedPayload = Schema.Struct({
  ruleId: ToolEgressRuleId,
  projectId: AggregateId,
  principal: ToolEgressPersonPrincipal,
}).annotations(strict);
export type ProjectEgressRuleRevokedPayload = typeof ProjectEgressRuleRevokedPayload.Type;

/**
 * A refusal learn mode recorded for a person to see. It is a separate record
 * the decision never reads, so it grants nothing however often it is raised.
 * A child's proposal lands on its parent's thread, and its launch names the
 * child.
 */
export const ThreadEgressProposalRaisedPayload = Schema.Struct({
  proposalId: ToolEgressProposalId,
  threadId: AggregateId,
  launch: ToolEgressLaunch,
  host: ToolEgressProposalHost,
  port: ToolEgressPort,
  reason: Schema.Literal("no-rule", "expired"),
  attempts: requestCount,
  threadTainted: Schema.Boolean,
}).annotations(strict);
export type ThreadEgressProposalRaisedPayload = typeof ThreadEgressProposalRaisedPayload.Type;

export const ThreadEgressProposalDeclinedPayload = Schema.Struct({
  threadId: AggregateId,
  proposalIds: Schema.Array(ToolEgressProposalId).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_OPEN_TOOL_EGRESS_PROPOSALS),
  ),
  principal: ToolEgressPersonPrincipal,
  threadTainted: Schema.Boolean,
}).annotations(strict);
export type ThreadEgressProposalDeclinedPayload = typeof ThreadEgressProposalDeclinedPayload.Type;

export const ThreadEgressLaunchStartedPayload = Schema.Struct({
  launch: ToolEgressLaunch,
  startedAt: UtcTimestamp,
  threadTainted: Schema.Boolean,
}).annotations(strict);
export type ThreadEgressLaunchStartedPayload = typeof ThreadEgressLaunchStartedPayload.Type;

/** One destination's decision and counts within a launch. */
export const ToolEgressDecisionEntry = Schema.Union(
  Schema.Struct({
    host: ToolEgressRecordedHost,
    port: recordedPort,
    decision: Schema.Literal("allowed"),
    requests: requestCount,
    bytesSent: byteCount,
    bytesReceived: byteCount,
  }).annotations(strict),
  Schema.Struct({
    host: ToolEgressRecordedHost,
    port: recordedPort,
    decision: Schema.Literal("refused"),
    reason: ToolEgressRefusalReason,
    requests: requestCount,
  }).annotations(strict),
);
export type ToolEgressDecisionEntry = typeof ToolEgressDecisionEntry.Type;

export const ThreadEgressDecisionsRecordedPayload = Schema.Struct({
  launch: ToolEgressLaunch,
  entries: Schema.Array(ToolEgressDecisionEntry).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES),
  ),
  threadTainted: Schema.Boolean,
}).annotations(strict);
export type ThreadEgressDecisionsRecordedPayload = typeof ThreadEgressDecisionsRecordedPayload.Type;

/**
 * A launch's final totals. `bytesReceived` counts every allowed destination,
 * including entries past the cap, and is what taints the thread when above
 * zero.
 */
export const ThreadEgressLaunchSummarizedPayload = Schema.Struct({
  launch: ToolEgressLaunch,
  endedAt: UtcTimestamp,
  bytesSent: byteCount,
  bytesReceived: byteCount,
  entries: Schema.Array(ToolEgressDecisionEntry).pipe(
    Schema.maxItems(MAX_TOOL_EGRESS_SUMMARY_ENTRIES),
  ),
  truncated: Schema.Boolean,
  threadTainted: Schema.Boolean,
}).annotations(strict);
export type ThreadEgressLaunchSummarizedPayload = typeof ThreadEgressLaunchSummarizedPayload.Type;

/**
 * Appended at startup for a launch that started and was never summarized.
 * It holds only what the recorded batches captured; the tail is unknown.
 */
export const ThreadEgressLaunchIncompletePayload = Schema.Struct({
  launch: ToolEgressLaunch,
  recordedBytesSent: byteCount,
  recordedBytesReceived: byteCount,
  entries: Schema.Array(ToolEgressDecisionEntry).pipe(
    Schema.maxItems(MAX_TOOL_EGRESS_SUMMARY_ENTRIES),
  ),
  truncated: Schema.Boolean,
  tail: Schema.Literal("unknown"),
  threadTainted: Schema.Boolean,
}).annotations(strict);
export type ThreadEgressLaunchIncompletePayload = typeof ThreadEgressLaunchIncompletePayload.Type;

export const decodeToolEgressRuleHost = Schema.decodeUnknownSync(ToolEgressRuleHost);
export const decodeThreadEgressRuleGrantedPayload = Schema.decodeUnknownSync(
  ThreadEgressRuleGrantedPayload,
);
export const decodeThreadEgressRuleRevokedPayload = Schema.decodeUnknownSync(
  ThreadEgressRuleRevokedPayload,
);
export const decodeProjectEgressRuleGrantedPayload = Schema.decodeUnknownSync(
  ProjectEgressRuleGrantedPayload,
);
export const decodeProjectEgressRuleRevokedPayload = Schema.decodeUnknownSync(
  ProjectEgressRuleRevokedPayload,
);
export const decodeThreadEgressProposalRaisedPayload = Schema.decodeUnknownSync(
  ThreadEgressProposalRaisedPayload,
);
export const decodeThreadEgressProposalDeclinedPayload = Schema.decodeUnknownSync(
  ThreadEgressProposalDeclinedPayload,
);
export const decodeThreadEgressLaunchStartedPayload = Schema.decodeUnknownSync(
  ThreadEgressLaunchStartedPayload,
);
export const decodeThreadEgressDecisionsRecordedPayload = Schema.decodeUnknownSync(
  ThreadEgressDecisionsRecordedPayload,
);
export const decodeThreadEgressLaunchSummarizedPayload = Schema.decodeUnknownSync(
  ThreadEgressLaunchSummarizedPayload,
);
export const decodeThreadEgressLaunchIncompletePayload = Schema.decodeUnknownSync(
  ThreadEgressLaunchIncompletePayload,
);
