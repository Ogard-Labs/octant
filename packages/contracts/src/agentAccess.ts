import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const uuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const fingerprint = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const base64Url = Schema.NonEmptyTrimmedString.pipe(Schema.pattern(/^[A-Za-z0-9_-]+$/));
const publicKey = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(4_096),
  Schema.filter((value) => !value.includes("PRIVATE KEY")),
);
const label = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.filter((value) => !/[/\\\n\r]/.test(value)),
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
export const AgentGrantMode = Schema.Literal(...AGENT_GRANT_MODES);
export type AgentGrantMode = typeof AgentGrantMode.Type;

/** Full access is not a value here: only the person turns it on, at the host. */
export const AGENT_GRANT_LEVELS = ["ask-first", "accept-edits", "auto", "plan"] as const;
export const AgentGrantLevel = Schema.Literal(...AGENT_GRANT_LEVELS);
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
export const AgentGrantTool = Schema.Literal(...AGENT_GRANT_TOOLS);
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
  runningTurns: Schema.Int.pipe(Schema.between(1, 8)),
  turnsPerDay: Schema.Int.pipe(Schema.between(1, 1_000)),
  requestsPerMinute: Schema.Int.pipe(Schema.between(1, 600)),
}).annotations(strict);
export type AgentGrantLimits = typeof AgentGrantLimits.Type;

export const DEFAULT_AGENT_GRANT_LIMITS: AgentGrantLimits = {
  runningTurns: 2,
  turnsPerDay: 50,
  requestsPerMinute: 60,
};

const unique = <A>(values: ReadonlyArray<A>) => new Set(values).size === values.length;

/** What one agent may do. Every field narrows; none widens a paired device. */
export const AgentGrantScope = Schema.Struct({
  projects: Schema.Array(ProjectId).pipe(
    Schema.maxItems(MAX_AGENT_GRANT_PROJECTS),
    Schema.filter(unique, { message: () => "Projects must be listed once each." }),
  ),
  modes: Schema.Array(AgentGrantMode).pipe(
    Schema.minItems(1),
    Schema.filter(unique, { message: () => "Modes must be listed once each." }),
  ),
  highestLevel: AgentGrantLevel,
  /** `own`: only threads this agent started; `project`: every thread in its Projects. */
  threads: Schema.Literal("own", "project"),
  tools: Schema.Array(AgentGrantTool).pipe(
    Schema.minItems(1),
    Schema.filter(unique, { message: () => "Tools must be listed once each." }),
  ),
  /** Absent: any model the host offers. */
  models: Schema.optional(
    Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_AGENT_GRANT_MODELS),
    ),
  ),
  limits: AgentGrantLimits,
  /** Whether a bearer key may be used beside enrolled bridge keys. */
  direct: Schema.Boolean,
}).annotations(strict);
export type AgentGrantScope = typeof AgentGrantScope.Type;

export const AgentEnrolledKey = Schema.Struct({
  fingerprint,
  publicKey,
  label,
  enrolledAt: UtcTimestamp,
}).annotations(strict);
export type AgentEnrolledKey = typeof AgentEnrolledKey.Type;

export const AgentGrantState = Schema.Literal("active", "revoked");
export type AgentGrantState = typeof AgentGrantState.Type;

/** The grant as the host keeps it. No key or key hash is part of it. */
export const AgentGrant = Schema.Struct({
  grantId: AgentGrantId,
  scopeId: AgentScopeId,
  name: label,
  scope: AgentGrantScope,
  state: AgentGrantState,
  /** Raised by every change that voids credentials or sessions. */
  generation: Schema.Int.pipe(Schema.positive()),
  keys: Schema.Array(AgentEnrolledKey).pipe(Schema.maxItems(MAX_AGENT_GRANT_KEYS)),
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  revokedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
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
} as const;

export const AgentGrantCreatedV1 = Schema.Struct({
  grantId: AgentGrantId,
  scopeId: AgentScopeId,
  name: label,
  scope: AgentGrantScope,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type AgentGrantCreatedV1 = typeof AgentGrantCreatedV1.Type;

export const AgentGrantChangedV1 = Schema.Struct({
  grantId: AgentGrantId,
  name: label,
  scope: AgentGrantScope,
  generation: Schema.Int.pipe(Schema.positive()),
  changedAt: UtcTimestamp,
}).annotations(strict);
export type AgentGrantChangedV1 = typeof AgentGrantChangedV1.Type;

export const AgentKeyEnrolledV1 = Schema.Struct({
  grantId: AgentGrantId,
  key: AgentEnrolledKey,
}).annotations(strict);
export type AgentKeyEnrolledV1 = typeof AgentKeyEnrolledV1.Type;

export const AgentKeyRemovedV1 = Schema.Struct({
  grantId: AgentGrantId,
  fingerprint,
  generation: Schema.Int.pipe(Schema.positive()),
  removedAt: UtcTimestamp,
}).annotations(strict);
export type AgentKeyRemovedV1 = typeof AgentKeyRemovedV1.Type;

/** A new bearer key replaced the old; the hash lives outside the journal. */
export const AgentDirectKeyRotatedV1 = Schema.Struct({
  grantId: AgentGrantId,
  generation: Schema.Int.pipe(Schema.positive()),
  rotatedAt: UtcTimestamp,
}).annotations(strict);
export type AgentDirectKeyRotatedV1 = typeof AgentDirectKeyRotatedV1.Type;

export const AgentGrantRevokeReason = Schema.Literal("person", "expired", "idle");
export type AgentGrantRevokeReason = typeof AgentGrantRevokeReason.Type;

export const AgentGrantRevokedV1 = Schema.Struct({
  grantId: AgentGrantId,
  reason: AgentGrantRevokeReason,
  generation: Schema.Int.pipe(Schema.positive()),
  revokedAt: UtcTimestamp,
}).annotations(strict);
export type AgentGrantRevokedV1 = typeof AgentGrantRevokedV1.Type;

export const AgentThreadStartedV1 = Schema.Struct({
  grantId: AgentGrantId,
  threadId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  mode: AgentGrantMode,
  projectId: Schema.optional(ProjectId),
  startedAt: UtcTimestamp,
}).annotations(strict);
export type AgentThreadStartedV1 = typeof AgentThreadStartedV1.Type;

// ── Enrollment ───────────────────────────────────────────────────────────────

/** What the connection code carries, base64url JSON after its prefix. */
export const AgentConnectionCode = Schema.Struct({
  origin: Schema.String.pipe(
    Schema.filter((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
      } catch {
        return false;
      }
    }),
  ),
  hostId: Schema.UUID,
  grantId: AgentGrantId,
  ticketId: AgentTicketId,
  ticketProof: base64Url,
  /** `sha256-<base64url SPKI hash>`, the listener certificate pin. */
  pin: Schema.String.pipe(Schema.pattern(/^sha256-[A-Za-z0-9_-]{43}$/)),
}).annotations(strict);
export type AgentConnectionCode = typeof AgentConnectionCode.Type;

export const AgentClaimRequest = Schema.Struct({
  ticketId: AgentTicketId,
  ticketProof: base64Url,
  publicKey,
  fingerprint,
  label,
}).annotations(strict);
export type AgentClaimRequest = typeof AgentClaimRequest.Type;

/** What the agent's machine keeps after joining; written owner-only. */
export const AgentConnectionFile = Schema.Struct({
  version: Schema.Literal(1),
  origin: AgentConnectionCode.fields.origin,
  hostId: Schema.UUID,
  grantId: AgentGrantId,
  pin: AgentConnectionCode.fields.pin,
  fingerprint,
  publicKey,
  privateKey: Schema.String.pipe(Schema.filter((value) => value.includes("PRIVATE KEY"))),
}).annotations(strict);
export type AgentConnectionFile = typeof AgentConnectionFile.Type;

// ── Administration (local window or loopback CLI only) ──────────────────────

export const AgentGrantDraft = Schema.Struct({
  name: label,
  scope: AgentGrantScope,
  /** Days until the grant ends, at most the absolute limit. */
  days: Schema.Int.pipe(Schema.between(1, AGENT_GRANT_MAX_DAYS)),
}).annotations(strict);
export type AgentGrantDraft = typeof AgentGrantDraft.Type;

export const AgentAccessCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("create"), draft: AgentGrantDraft }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change"),
    grantId: AgentGrantId,
    expectedGeneration: Schema.Int.pipe(Schema.positive()),
    name: label,
    scope: AgentGrantScope,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("revoke"),
    grantId: AgentGrantId,
    stopRunningTurns: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("issue-ticket"), grantId: AgentGrantId }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("confirm-key"),
    grantId: AgentGrantId,
    fingerprint,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove-key"),
    grantId: AgentGrantId,
    fingerprint,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("rotate-direct-key"), grantId: AgentGrantId }).annotations(
    strict,
  ),
);
export type AgentAccessCommand = typeof AgentAccessCommand.Type;

/** A claimed key the person has not confirmed yet. Held in host memory only. */
export const AgentPendingClaim = Schema.Struct({
  grantId: AgentGrantId,
  fingerprint,
  label,
  claimedAt: UtcTimestamp,
}).annotations(strict);
export type AgentPendingClaim = typeof AgentPendingClaim.Type;

export const AgentGrantView = Schema.Struct({
  grant: AgentGrant,
  pendingClaims: Schema.Array(AgentPendingClaim),
  directKey: Schema.Boolean,
  lastUsedAt: Schema.optional(UtcTimestamp),
  lastSourceClass: Schema.optional(Schema.Literal("lan-private", "tailscale")),
  threadsStarted: Schema.Int.pipe(Schema.nonNegative()),
  turnsToday: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type AgentGrantView = typeof AgentGrantView.Type;

export const AgentAccessResult = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("grants"), grants: Schema.Array(AgentGrantView) }),
  Schema.Struct({ kind: Schema.Literal("grant"), grant: AgentGrantView }),
  Schema.Struct({
    kind: Schema.Literal("ticket"),
    connectionCode: Schema.String.pipe(Schema.startsWith(AGENT_CONNECTION_CODE_PREFIX)),
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("direct-key"),
    /** Shown once; the host keeps only a salted hash. */
    key: Schema.String.pipe(Schema.pattern(/^oak_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/)),
    endpoint: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("done") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literal(
      "not-found",
      "stale",
      "invalid",
      "listener-off",
      "too-many",
      "not-pending",
      "revoked",
    ),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }),
);
export type AgentAccessResult = typeof AgentAccessResult.Type;

export const decodeAgentGrant = Schema.decodeUnknownSync(AgentGrant);
export const decodeAgentGrantScope = Schema.decodeUnknownSync(AgentGrantScope);
export const decodeAgentAccessCommand = Schema.decodeUnknownSync(AgentAccessCommand);
export const decodeAgentAccessResult = Schema.decodeUnknownSync(AgentAccessResult);
export const decodeAgentConnectionCode = Schema.decodeUnknownSync(AgentConnectionCode);
export const decodeAgentClaimRequest = Schema.decodeUnknownSync(AgentClaimRequest);
export const decodeAgentConnectionFile = Schema.decodeUnknownSync(AgentConnectionFile);

/** The bearer key's grant id is the grant UUID without dashes. */
export function bearerGrantToken(grantId: string): string {
  return grantId.replaceAll("-", "");
}
