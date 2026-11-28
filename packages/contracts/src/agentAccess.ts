import { Schema } from "effect";
import {
  GuidString,
  NonEmptyTrimmedString,
  NonNegativeInt,
  PositiveInt,
  STRICT_DECODE_OPTIONS,
} from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const uuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const fingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const base64Url = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const publicKey = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => !value.includes("PRIVATE KEY")),
);
const label = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.makeFilter((value) => !/[/\\\n\r]/.test(value)),
);

/**
 * Agent access: an agent on another machine on the person's own network
 * starting and following work in Octant under a grant the person made.
 * See docs/design/agent-access.md.
 */
export const AgentGrantId = uuid("AgentGrantId");
export type AgentGrantId = typeof AgentGrantId.Type;

/**
 * The service scope an agent's requests run under. Product routes see the
 * agent as a paired-device principal whose device id is this value, so every
 * device clamp applies; no device ever holds it.
 */
export const AgentScopeId = uuid("AgentScopeId");
export type AgentScopeId = typeof AgentScopeId.Type;

export const AgentTicketId = uuid("AgentTicketId");
export type AgentTicketId = typeof AgentTicketId.Type;

export const AGENT_GRANT_MODES = ["chat", "work", "code"] as const;
export const AgentGrantMode = Schema.Literals(AGENT_GRANT_MODES);
export type AgentGrantMode = typeof AgentGrantMode.Type;

/**
 * The highest level a grant's agent may run a thread at. Full access is a
 * grant's only when the person chose it for that grant (maintainer decision,
 * 2026-11-12); the agent's prompts stay marked as outside content at every level.
 */
export const AGENT_GRANT_LEVELS = [
  "ask-first",
  "accept-edits",
  "auto",
  "plan",
  "full-access",
] as const;
export const AgentGrantLevel = Schema.Literals(AGENT_GRANT_LEVELS);
export type AgentGrantLevel = typeof AgentGrantLevel.Type;

export const AGENT_GRANT_TOOLS = [
  "start_work",
  "send_message",
  "read_thread",
  "answer_question",
  "stop_turn",
  "list_projects",
  "list_threads",
  "list_waiting",
] as const;
export const AgentGrantTool = Schema.Literals(AGENT_GRANT_TOOLS);
export type AgentGrantTool = typeof AgentGrantTool.Type;

export const MAX_AGENT_GRANT_PROJECTS = 32;
export const MAX_AGENT_GRANT_MODELS = 16;
export const MAX_AGENT_GRANT_KEYS = 4;
export const MAX_AGENT_GRANTS = 32;
/** A paired device's own idle and absolute limits. */
export const AGENT_GRANT_IDLE_DAYS = 30;
export const AGENT_GRANT_MAX_DAYS = 90;
export const AGENT_TICKET_TTL_MS = 5 * 60 * 1_000;
export const AGENT_PROOF_HEADER = "x-octant-agent-proof";
export const AGENT_CONNECTION_CODE_PREFIX = "octant-agent-1.";

export const AgentGrantLimits = Schema.Struct({
  runningTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  turnsPerDay: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
  requestsPerMinute: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
});
export type AgentGrantLimits = typeof AgentGrantLimits.Type;

export const DEFAULT_AGENT_GRANT_LIMITS: AgentGrantLimits = {
  runningTurns: 2,
  turnsPerDay: 50,
  requestsPerMinute: 60,
};

const unique = <A>(values: ReadonlyArray<A>) => new Set(values).size === values.length;

/** What one agent may do. Every field narrows; none widens a paired device. */
export const AgentGrantScope = Schema.Struct({
  projects: Schema.Array(ProjectId).check(
    Schema.isMaxLength(MAX_AGENT_GRANT_PROJECTS),
    Schema.makeFilter(unique, { message: "Projects must be listed once each." }),
  ),
  modes: Schema.Array(AgentGrantMode).check(
    Schema.isMinLength(1),
    Schema.makeFilter(unique, { message: "Modes must be listed once each." }),
  ),
  highestLevel: AgentGrantLevel,
  /** `own`: only threads this agent started; `project`: every thread in its Projects. */
  threads: Schema.Literals(["own", "project"]),
  tools: Schema.Array(AgentGrantTool).check(
    Schema.isMinLength(1),
    Schema.makeFilter(unique, { message: "Tools must be listed once each." }),
  ),
  /** Absent: any model the host offers. */
  models: Schema.optional(
    Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_AGENT_GRANT_MODELS),
    ),
  ),
  limits: AgentGrantLimits,
  /** Whether a bearer key may be used beside enrolled bridge keys. */
  direct: Schema.Boolean,
});
export type AgentGrantScope = typeof AgentGrantScope.Type;

export const AgentEnrolledKey = Schema.Struct({
  fingerprint,
  publicKey,
  label,
  enrolledAt: UtcTimestamp,
});
export type AgentEnrolledKey = typeof AgentEnrolledKey.Type;

export const AgentGrantState = Schema.Literals(["active", "revoked"]);
export type AgentGrantState = typeof AgentGrantState.Type;

/** The grant as the host keeps it. No key or key hash is part of it. */
export const AgentGrant = Schema.Struct({
  grantId: AgentGrantId,
  scopeId: AgentScopeId,
  name: label,
  scope: AgentGrantScope,
  state: AgentGrantState,
  /** Raised by every change that voids credentials or sessions. */
  generation: PositiveInt,
  keys: Schema.Array(AgentEnrolledKey).check(Schema.isMaxLength(MAX_AGENT_GRANT_KEYS)),
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  revokedAt: Schema.optional(UtcTimestamp),
});
export type AgentGrant = typeof AgentGrant.Type;

// ── Journal ──────────────────────────────────────────────────────────────────

export const AGENT_ACCESS_AGGREGATE = "agent-access-grant";
export const AGENT_ACCESS_EVENT_NAMES = {
  grantCreated: "agent-access.grant-created@1",
  grantChanged: "agent-access.grant-changed@1",
  keyEnrolled: "agent-access.key-enrolled@1",
  keyRemoved: "agent-access.key-removed@1",
  directKeyRotated: "agent-access.direct-key-rotated@1",
  grantRevoked: "agent-access.grant-revoked@1",
  threadStarted: "agent-access.thread-started@1",
  turnSent: "agent-access.turn-sent@1",
} as const;

export const AgentGrantCreatedV1 = Schema.Struct({
  grantId: AgentGrantId,
  scopeId: AgentScopeId,
  name: label,
  scope: AgentGrantScope,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});
export type AgentGrantCreatedV1 = typeof AgentGrantCreatedV1.Type;

export const AgentGrantChangedV1 = Schema.Struct({
  grantId: AgentGrantId,
  name: label,
  scope: AgentGrantScope,
  generation: PositiveInt,
  changedAt: UtcTimestamp,
});
export type AgentGrantChangedV1 = typeof AgentGrantChangedV1.Type;

export const AgentKeyEnrolledV1 = Schema.Struct({
  grantId: AgentGrantId,
  key: AgentEnrolledKey,
});
export type AgentKeyEnrolledV1 = typeof AgentKeyEnrolledV1.Type;

export const AgentKeyRemovedV1 = Schema.Struct({
  grantId: AgentGrantId,
  fingerprint,
  generation: PositiveInt,
  removedAt: UtcTimestamp,
});
export type AgentKeyRemovedV1 = typeof AgentKeyRemovedV1.Type;

/** A new bearer key replaced the old; the hash lives outside the journal. */
export const AgentDirectKeyRotatedV1 = Schema.Struct({
  grantId: AgentGrantId,
  generation: PositiveInt,
  rotatedAt: UtcTimestamp,
});
export type AgentDirectKeyRotatedV1 = typeof AgentDirectKeyRotatedV1.Type;

export const AgentGrantRevokeReason = Schema.Literals(["person", "expired", "idle"]);
export type AgentGrantRevokeReason = typeof AgentGrantRevokeReason.Type;

export const AgentGrantRevokedV1 = Schema.Struct({
  grantId: AgentGrantId,
  reason: AgentGrantRevokeReason,
  generation: PositiveInt,
  revokedAt: UtcTimestamp,
});
export type AgentGrantRevokedV1 = typeof AgentGrantRevokedV1.Type;

export const AgentThreadStartedV1 = Schema.Struct({
  grantId: AgentGrantId,
  threadId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  mode: AgentGrantMode,
  projectId: Schema.optional(ProjectId),
  startedAt: UtcTimestamp,
});
export type AgentThreadStartedV1 = typeof AgentThreadStartedV1.Type;

/**
 * A prompt an outside agent sent a thread, keyed by the id its turn record
 * keeps: a Code turn's operation id, a Chat turn's submission id, a Work
 * turn's id. The id is chosen by the sender before the send, so the host can
 * name the turn without waiting for it to exist.
 */
export const AgentTurnSentV1 = Schema.Struct({
  grantId: AgentGrantId,
  threadId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  mode: AgentGrantMode,
  turnKey: GuidString,
  sentAt: UtcTimestamp,
});
export type AgentTurnSentV1 = typeof AgentTurnSentV1.Type;

// ── Enrollment ───────────────────────────────────────────────────────────────

/** What the connection code carries, base64url JSON after its prefix. */
export const AgentConnectionCode = Schema.Struct({
  origin: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
      } catch {
        return false;
      }
    }),
  ),
  hostId: GuidString,
  grantId: AgentGrantId,
  ticketId: AgentTicketId,
  ticketProof: base64Url,
  /**
   * `sha256-<base64url SPKI hash>`, the self-made listener certificate's pin.
   * Absent when the person serves their own certificate (a Tailscale one, for
   * example); the bridge then checks it against the system's authorities.
   */
  pin: Schema.optional(Schema.String.check(Schema.isPattern(/^sha256-[A-Za-z0-9_-]{43}$/))),
});
export type AgentConnectionCode = typeof AgentConnectionCode.Type;

export const AgentClaimRequest = Schema.Struct({
  ticketId: AgentTicketId,
  ticketProof: base64Url,
  publicKey,
  fingerprint,
  label,
});
export type AgentClaimRequest = typeof AgentClaimRequest.Type;

/** What the agent's machine keeps after joining; written owner-only. */
export const AgentConnectionFile = Schema.Struct({
  version: Schema.Literal(1),
  origin: AgentConnectionCode.fields.origin,
  hostId: GuidString,
  grantId: AgentGrantId,
  pin: AgentConnectionCode.fields.pin,
  fingerprint,
  publicKey,
  privateKey: Schema.String.check(Schema.makeFilter((value) => value.includes("PRIVATE KEY"))),
});
export type AgentConnectionFile = typeof AgentConnectionFile.Type;

// ── Administration (local window or loopback CLI only) ──────────────────────

export const AgentGrantDraft = Schema.Struct({
  name: label,
  scope: AgentGrantScope,
  /** Days until the grant ends, at most the absolute limit. */
  days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AGENT_GRANT_MAX_DAYS })),
});
export type AgentGrantDraft = typeof AgentGrantDraft.Type;

export const AgentAccessCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("create"), draft: AgentGrantDraft }),
  Schema.Struct({
    kind: Schema.Literal("change"),
    grantId: AgentGrantId,
    expectedGeneration: PositiveInt,
    name: label,
    scope: AgentGrantScope,
  }),
  Schema.Struct({
    kind: Schema.Literal("revoke"),
    grantId: AgentGrantId,
    stopRunningTurns: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("issue-ticket"), grantId: AgentGrantId }),
  Schema.Struct({
    kind: Schema.Literal("confirm-key"),
    grantId: AgentGrantId,
    fingerprint,
  }),
  Schema.Struct({
    kind: Schema.Literal("remove-key"),
    grantId: AgentGrantId,
    fingerprint,
  }),
  Schema.Struct({ kind: Schema.Literal("rotate-direct-key"), grantId: AgentGrantId }),
]);
export type AgentAccessCommand = typeof AgentAccessCommand.Type;

/** A claimed key the person has not confirmed yet. Held in host memory only. */
export const AgentPendingClaim = Schema.Struct({
  grantId: AgentGrantId,
  fingerprint,
  label,
  claimedAt: UtcTimestamp,
});
export type AgentPendingClaim = typeof AgentPendingClaim.Type;

export const AgentGrantView = Schema.Struct({
  grant: AgentGrant,
  pendingClaims: Schema.Array(AgentPendingClaim),
  directKey: Schema.Boolean,
  lastUsedAt: Schema.optional(UtcTimestamp),
  lastSourceClass: Schema.optional(Schema.Literals(["loopback", "lan-private", "tailscale"])),
  threadsStarted: NonNegativeInt,
  turnsToday: NonNegativeInt,
});
export type AgentGrantView = typeof AgentGrantView.Type;

export const AgentAccessResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("grants"), grants: Schema.Array(AgentGrantView) }),
  Schema.Struct({ kind: Schema.Literal("grant"), grant: AgentGrantView }),
  Schema.Struct({
    kind: Schema.Literal("ticket"),
    connectionCode: Schema.String.check(Schema.isStartingWith(AGENT_CONNECTION_CODE_PREFIX)),
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("direct-key"),
    /** Shown once; the host keeps only a salted hash. */
    key: Schema.String.check(Schema.isPattern(/^oak_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/)),
    endpoint: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("done") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals([
      "not-found",
      "stale",
      "invalid",
      "listener-off",
      "too-many",
      "not-pending",
      "revoked",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type AgentAccessResult = typeof AgentAccessResult.Type;

/**
 * Product routes a local window and a paired device both reach: the grant list,
 * revoking one, and which threads each agent started, for "Started by" labels.
 * Administration beyond revoking stays on the window-only desktop routes.
 */
export const AGENT_GRANT_ROUTES = {
  grants: "/api/agent-grants",
  revoke: "/api/agent-grants/revoke",
  threads: "/api/agent-grants/threads",
  /**
   * Every grant command (make, change, revoke, connection codes, keys) from a
   * device the host's own person paired; a local window sends them through
   * the desktop bridge instead.
   */
  commands: "/api/agent-grants/commands",
} as const;

export const AgentGrantRevokeRequest = Schema.Struct({
  grantId: AgentGrantId,
  stopRunningTurns: Schema.Boolean,
});
export type AgentGrantRevokeRequest = typeof AgentGrantRevokeRequest.Type;

/** A thread an outside agent started, with the name its grant had when read. */
export const AgentThreadAttribution = Schema.Struct({
  threadId: NonEmptyTrimmedString,
  grantId: AgentGrantId,
  agentName: label,
  mode: AgentGrantMode,
});
export type AgentThreadAttribution = typeof AgentThreadAttribution.Type;

/** A turn an outside agent sent, by the id the thread's turn record keeps. */
export const AgentTurnAttribution = Schema.Struct({
  threadId: NonEmptyTrimmedString,
  turnKey: GuidString,
  agentName: label,
});
export type AgentTurnAttribution = typeof AgentTurnAttribution.Type;

/** The newest turns outside agents sent, at most this many in one read. */
export const MAX_AGENT_TURN_ATTRIBUTIONS = 2_000;

export const AgentThreadAttributions = Schema.Struct({
  threads: Schema.Array(AgentThreadAttribution),
  /** Absent from a host that predates per-turn attribution. */
  turns: Schema.optional(
    Schema.Array(AgentTurnAttribution).check(Schema.isMaxLength(MAX_AGENT_TURN_ATTRIBUTIONS)),
  ),
});
export type AgentThreadAttributions = typeof AgentThreadAttributions.Type;

export const decodeAgentGrant = Schema.decodeUnknownSync(AgentGrant, STRICT_DECODE_OPTIONS);
export const decodeAgentGrantScope = Schema.decodeUnknownSync(
  AgentGrantScope,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentAccessCommand = Schema.decodeUnknownSync(
  AgentAccessCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentAccessResult = Schema.decodeUnknownSync(
  AgentAccessResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentConnectionCode = Schema.decodeUnknownSync(
  AgentConnectionCode,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentClaimRequest = Schema.decodeUnknownSync(
  AgentClaimRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentConnectionFile = Schema.decodeUnknownSync(
  AgentConnectionFile,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentGrantRevokeRequest = Schema.decodeUnknownSync(
  AgentGrantRevokeRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentThreadAttributions = Schema.decodeUnknownSync(
  AgentThreadAttributions,
  STRICT_DECODE_OPTIONS,
);

/** The bearer key's grant id is the grant UUID without dashes. */
export function bearerGrantToken(grantId: string): string {
  return grantId.replaceAll("-", "");
}
