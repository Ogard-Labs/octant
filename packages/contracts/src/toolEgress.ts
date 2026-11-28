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
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateId, EventActorDeviceId, UtcTimestamp } from "./events";
import { NativeHarnessApprovalId } from "./nativeHarness";
import {
  MAX_TOOL_EGRESS_HOST_LENGTH,
  TOOL_EGRESS_HOST_NAME_PATTERN,
  ToolEgressPort,
  ToolEgressRuleHost,
} from "./toolEgressHost";

export {
  MAX_TOOL_EGRESS_HOST_LENGTH,
  TOOL_EGRESS_HOST_NAME_PATTERN,
  ToolEgressPort,
  ToolEgressRuleHost,
} from "./toolEgressHost";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

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
  learnModeSet: "thread.egress-learn-mode-set@1",
} as const;

/** Live rules one thread, or one Project, may hold at a time. */
export const MAX_LIVE_TOOL_EGRESS_RULES = 64;
export const MAX_TOOL_EGRESS_PROPOSALS_PER_LAUNCH = 16;
export const MAX_OPEN_TOOL_EGRESS_PROPOSALS = 64;
export const MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES = 16;
export const MAX_TOOL_EGRESS_SUMMARY_ENTRIES = 64;

export const ToolEgressRuleId = brandedUuid("ToolEgressRuleId");
export type ToolEgressRuleId = typeof ToolEgressRuleId.Type;
export const ToolEgressLaunchId = brandedUuid("ToolEgressLaunchId");
export type ToolEgressLaunchId = typeof ToolEgressLaunchId.Type;
export const ToolEgressProposalId = brandedUuid("ToolEgressProposalId");
export type ToolEgressProposalId = typeof ToolEgressProposalId.Type;

/** An exact name a proposal asks for; a proposal never names a wildcard. */
export const ToolEgressProposalHost = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(MAX_TOOL_EGRESS_HOST_LENGTH),
    Schema.isPattern(TOOL_EGRESS_HOST_NAME_PATTERN),
  ),
  Schema.brand("ToolEgressProposalHost"),
);
export type ToolEgressProposalHost = typeof ToolEgressProposalHost.Type;

/**
 * The destination a decision record names. It may be an IP literal or a name
 * the proxy refused, so it is not held to rule syntax, but it is bounded and
 * holds no path, query, credentials, or whitespace.
 */
export const ToolEgressRecordedHost = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_TOOL_EGRESS_HOST_LENGTH),
  Schema.isPattern(/^[a-z0-9._:-]+$/),
);
export type ToolEgressRecordedHost = typeof ToolEgressRecordedHost.Type;

/**
 * Why the proxy refused a request. Only `no-rule` and `expired` may become a
 * learn-mode proposal; the rest are never proposable.
 */
export const ToolEgressRefusalReason = Schema.Literals([
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
]);
export type ToolEgressRefusalReason = typeof ToolEgressRefusalReason.Type;

/** Who answered the `network-access` approval a rule came from. */
export const ToolEgressGrantingPrincipal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local-window") }),
  Schema.Struct({
    kind: Schema.Literal("remote-device"),
    deviceId: EventActorDeviceId,
  }),
  Schema.Struct({ kind: Schema.Literal("reviewer") }),
]);
export type ToolEgressGrantingPrincipal = typeof ToolEgressGrantingPrincipal.Type;

/** A person who may take a rule away or turn a proposal down. */
export const ToolEgressPersonPrincipal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local-window") }),
  Schema.Struct({
    kind: Schema.Literal("remote-device"),
    deviceId: EventActorDeviceId,
  }),
]);
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
  toolCallId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
});
export type ToolEgressLaunch = typeof ToolEgressLaunch.Type;

/** A thread aggregate's rule covers one launch, or every launch of the thread. */
export const ToolEgressThreadRuleScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("call"), launchId: ToolEgressLaunchId }),
  Schema.Struct({ kind: Schema.Literal("thread") }),
]);
export type ToolEgressThreadRuleScope = typeof ToolEgressThreadRuleScope.Type;

const byteCount = NonNegativeInt;
// A refused request may have named a port no rule could hold.
const recordedPort = NonNegativeInt;
const requestCount = PositiveInt;

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
}).check(
  Schema.makeFilter(
    (payload) =>
      payload.principal.kind === "reviewer"
        ? payload.scope.kind === "call" && !payload.threadTainted
        : payload.scope.kind === "call" || !payload.threadTainted,
    {
      message:
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
});
export type ThreadEgressRuleRevokedPayload = typeof ThreadEgressRuleRevokedPayload.Type;

/**
 * Project rules come only from the host's own person, at a local window whose
 * workspace holds the Project or on a device that person paired, answering on
 * a thread that is not tainted. The host decides which devices those are
 * before it journals; a record from before a device could grant names only a
 * local window.
 */
export const ProjectEgressRuleGrantedPayload = Schema.Struct({
  ruleId: ToolEgressRuleId,
  projectId: AggregateId,
  threadId: AggregateId,
  host: ToolEgressRuleHost,
  port: ToolEgressPort,
  expiresAt: UtcTimestamp,
  principal: ToolEgressPersonPrincipal,
  approvalId: NativeHarnessApprovalId,
  threadTainted: Schema.Literal(false),
});
export type ProjectEgressRuleGrantedPayload = typeof ProjectEgressRuleGrantedPayload.Type;

export const ProjectEgressRuleRevokedPayload = Schema.Struct({
  ruleId: ToolEgressRuleId,
  projectId: AggregateId,
  principal: ToolEgressPersonPrincipal,
});
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
  reason: Schema.Literals(["no-rule", "expired"]),
  attempts: requestCount,
  threadTainted: Schema.Boolean,
});
export type ThreadEgressProposalRaisedPayload = typeof ThreadEgressProposalRaisedPayload.Type;

export const ThreadEgressProposalDeclinedPayload = Schema.Struct({
  threadId: AggregateId,
  proposalIds: Schema.Array(ToolEgressProposalId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_OPEN_TOOL_EGRESS_PROPOSALS),
  ),
  principal: ToolEgressPersonPrincipal,
  threadTainted: Schema.Boolean,
});
export type ThreadEgressProposalDeclinedPayload = typeof ThreadEgressProposalDeclinedPayload.Type;

export const ThreadEgressLaunchStartedPayload = Schema.Struct({
  launch: ToolEgressLaunch,
  startedAt: UtcTimestamp,
  threadTainted: Schema.Boolean,
});
export type ThreadEgressLaunchStartedPayload = typeof ThreadEgressLaunchStartedPayload.Type;

/** One destination's decision and counts within a launch. */
export const ToolEgressDecisionEntry = Schema.Union([
  Schema.Struct({
    host: ToolEgressRecordedHost,
    port: recordedPort,
    decision: Schema.Literal("allowed"),
    requests: requestCount,
    bytesSent: byteCount,
    bytesReceived: byteCount,
  }),
  Schema.Struct({
    host: ToolEgressRecordedHost,
    port: recordedPort,
    decision: Schema.Literal("refused"),
    reason: ToolEgressRefusalReason,
    requests: requestCount,
  }),
]);
export type ToolEgressDecisionEntry = typeof ToolEgressDecisionEntry.Type;

export const ThreadEgressDecisionsRecordedPayload = Schema.Struct({
  launch: ToolEgressLaunch,
  entries: Schema.Array(ToolEgressDecisionEntry).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES),
  ),
  threadTainted: Schema.Boolean,
});
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
  /**
   * Request heads the proxy refused as unreadable or too large before any
   * decision. They name no destination, so they are counted here and nowhere
   * else.
   */
  malformedRequests: byteCount,
  entries: Schema.Array(ToolEgressDecisionEntry).check(
    Schema.isMaxLength(MAX_TOOL_EGRESS_SUMMARY_ENTRIES),
  ),
  truncated: Schema.Boolean,
  threadTainted: Schema.Boolean,
});
export type ThreadEgressLaunchSummarizedPayload = typeof ThreadEgressLaunchSummarizedPayload.Type;

/**
 * Appended at startup for a launch that started and was never summarized.
 * It holds only what the recorded batches captured; the tail is unknown.
 */
export const ThreadEgressLaunchIncompletePayload = Schema.Struct({
  launch: ToolEgressLaunch,
  recordedBytesSent: byteCount,
  recordedBytesReceived: byteCount,
  entries: Schema.Array(ToolEgressDecisionEntry).check(
    Schema.isMaxLength(MAX_TOOL_EGRESS_SUMMARY_ENTRIES),
  ),
  truncated: Schema.Boolean,
  tail: Schema.Literal("unknown"),
  threadTainted: Schema.Boolean,
});
export type ThreadEgressLaunchIncompletePayload = typeof ThreadEgressLaunchIncompletePayload.Type;

/**
 * Learn mode on or off for one thread. It is on until a person turns it off;
 * off, a refusal reaches the command's output and nothing is proposed.
 */
export const ThreadEgressLearnModeSetPayload = Schema.Struct({
  threadId: AggregateId,
  enabled: Schema.Boolean,
  principal: ToolEgressPersonPrincipal,
});
export type ThreadEgressLearnModeSetPayload = typeof ThreadEgressLearnModeSetPayload.Type;

/** How long a thread rule lives. A `call` rule ends with its launch instead. */
export const ToolEgressThreadRuleLifetime = Schema.Literals(["1h", "8h", "7d"]);
export type ToolEgressThreadRuleLifetime = typeof ToolEgressThreadRuleLifetime.Type;
export const ToolEgressProjectRuleLifetime = Schema.Literals(["7d", "30d"]);
export type ToolEgressProjectRuleLifetime = typeof ToolEgressProjectRuleLifetime.Type;

/** A live rule as the thread's and the Project's rules lists show it. */
export const ToolEgressRuleView = Schema.Struct({
  ruleId: ToolEgressRuleId,
  host: ToolEgressRuleHost,
  port: ToolEgressPort,
  scope: Schema.Literals(["call", "thread", "project"]),
  expiresAt: UtcTimestamp,
  grantedAt: UtcTimestamp,
  grantedBy: Schema.Literals(["local-window", "remote-device", "reviewer"]),
});
export type ToolEgressRuleView = typeof ToolEgressRuleView.Type;

/** An open learn-mode proposal. A child's names the child thread that asked. */
export const ToolEgressProposalView = Schema.Struct({
  proposalId: ToolEgressProposalId,
  host: ToolEgressProposalHost,
  port: ToolEgressPort,
  reason: Schema.Literals(["no-rule", "expired"]),
  attempts: requestCount,
  raisedAt: UtcTimestamp,
  threadTainted: Schema.Boolean,
  childThreadId: Schema.optional(AggregateId),
});
export type ToolEgressProposalView = typeof ToolEgressProposalView.Type;

/**
 * One Code thread's egress rules, its Project's, and its open proposals, as
 * the host answers the caller asking. `projectGrant` says whether this caller
 * may grant a Project rule here, and why not.
 */
export const ToolEgressThreadView = Schema.Struct({
  threadId: AggregateId,
  projectId: AggregateId,
  /** Whether this thread's harness commands reach the network only through these rules. */
  enforced: Schema.Boolean,
  learnMode: Schema.Boolean,
  threadTainted: Schema.Boolean,
  projectGrant: Schema.Literals(["allowed", "needs-local-window", "thread-tainted"]),
  threadRules: Schema.Array(ToolEgressRuleView).check(
    Schema.isMaxLength(MAX_LIVE_TOOL_EGRESS_RULES),
  ),
  projectRules: Schema.Array(ToolEgressRuleView).check(
    Schema.isMaxLength(MAX_LIVE_TOOL_EGRESS_RULES),
  ),
  proposals: Schema.Array(ToolEgressProposalView).check(
    Schema.isMaxLength(MAX_OPEN_TOOL_EGRESS_PROPOSALS),
  ),
});
export type ToolEgressThreadView = typeof ToolEgressThreadView.Type;

/** What a person chose for one host: a thread rule or a Project rule, each with its lifetime. */
export const ToolEgressGrantChoice = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    lifetime: ToolEgressThreadRuleLifetime,
  }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    lifetime: ToolEgressProjectRuleLifetime,
  }),
]);
export type ToolEgressGrantChoice = typeof ToolEgressGrantChoice.Type;

/**
 * The host as a person typed it. The host puts it in canonical form and
 * refuses what no rule may name, so a client never decides that.
 */
const typedRuleHost = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_TOOL_EGRESS_HOST_LENGTH + 2),
);

/**
 * A person's answer on a thread's `network-access` surface: grant hosts
 * (from proposals or typed into the rules list), turn proposals down, take a
 * rule away, or switch learn mode.
 */
export const ToolEgressCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("grant-rules"),
    grants: Schema.Array(
      Schema.Struct({
        host: typedRuleHost,
        port: ToolEgressPort,
        choice: ToolEgressGrantChoice,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_LIVE_TOOL_EGRESS_RULES)),
    declineProposalIds: Schema.Array(ToolEgressProposalId).check(
      Schema.isMaxLength(MAX_OPEN_TOOL_EGRESS_PROPOSALS),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("decline-proposals"),
    proposalIds: Schema.Array(ToolEgressProposalId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_OPEN_TOOL_EGRESS_PROPOSALS),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("revoke-rule"),
    ruleId: ToolEgressRuleId,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-learn-mode"),
    enabled: Schema.Boolean,
  }),
]);
export type ToolEgressCommand = typeof ToolEgressCommand.Type;

export const ToolEgressCommandRefusalReason = Schema.Literals([
  "not-a-code-thread",
  "thread-tainted",
  "needs-local-window",
  "invalid-host",
  "limit",
  "rule-not-found",
  "proposal-not-found",
  "unavailable",
]);
export type ToolEgressCommandRefusalReason = typeof ToolEgressCommandRefusalReason.Type;

export const ToolEgressCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool-egress-updated"),
    view: ToolEgressThreadView,
  }),
  Schema.Struct({
    kind: Schema.Literal("tool-egress-refused"),
    reason: ToolEgressCommandRefusalReason,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type ToolEgressCommandResult = typeof ToolEgressCommandResult.Type;

export const decodeToolEgressRuleHost = Schema.decodeUnknownSync(
  ToolEgressRuleHost,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadEgressRuleGrantedPayload = Schema.decodeUnknownSync(
  ThreadEgressRuleGrantedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadEgressRuleRevokedPayload = Schema.decodeUnknownSync(
  ThreadEgressRuleRevokedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectEgressRuleGrantedPayload = Schema.decodeUnknownSync(
  ProjectEgressRuleGrantedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectEgressRuleRevokedPayload = Schema.decodeUnknownSync(
  ProjectEgressRuleRevokedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadEgressProposalRaisedPayload = Schema.decodeUnknownSync(
  ThreadEgressProposalRaisedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadEgressProposalDeclinedPayload = Schema.decodeUnknownSync(
  ThreadEgressProposalDeclinedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadEgressLaunchStartedPayload = Schema.decodeUnknownSync(
  ThreadEgressLaunchStartedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadEgressDecisionsRecordedPayload = Schema.decodeUnknownSync(
  ThreadEgressDecisionsRecordedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadEgressLaunchSummarizedPayload = Schema.decodeUnknownSync(
  ThreadEgressLaunchSummarizedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadEgressLaunchIncompletePayload = Schema.decodeUnknownSync(
  ThreadEgressLaunchIncompletePayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadEgressLearnModeSetPayload = Schema.decodeUnknownSync(
  ThreadEgressLearnModeSetPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeToolEgressCommand = Schema.decodeUnknownSync(
  ToolEgressCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeToolEgressThreadView = Schema.decodeUnknownSync(
  ToolEgressThreadView,
  STRICT_DECODE_OPTIONS,
);
