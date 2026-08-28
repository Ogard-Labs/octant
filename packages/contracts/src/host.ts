import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

// ── Host identity ───────────────────────────────────────────────────────────

export const HostId = Schema.NonEmptyTrimmedString.pipe(Schema.brand("HostId"));
export type HostId = typeof HostId.Type;

/** The single implicit v1 host. Every thread-creation command and event
 *  envelope carries this value until multi-host federation lands. */
export const LOCAL_HOST_ID: HostId = Schema.decodeUnknownSync(HostId)("local");

/** Neutral fallback; host-owned surfaces resolve the platform-specific label. */
export const LOCAL_HOST_DISPLAY_NAME = "This computer";

// ── Host health ─────────────────────────────────────────────────────────────

export const HostHealth = Schema.Literal(
  "healthy",
  "connecting",
  "stale",
  "incompatible",
  "unauthorized",
  "unavailable",
);
export type HostHealth = typeof HostHealth.Type;

// ── Host identity report ────────────────────────────────────────────────────

/** Server-exposed identity and capability report for one host. In v1 the
 *  server always reports exactly one healthy local entry. */
export const HostIdentity = Schema.Struct({
  hostId: HostId,
  displayName: Schema.NonEmptyTrimmedString,
  health: HostHealth,
  capabilities: Schema.Array(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type HostIdentity = typeof HostIdentity.Type;

export const HostListResponse = Schema.Struct({
  hosts: Schema.Array(HostIdentity),
}).annotations(strict);
export type HostListResponse = typeof HostListResponse.Type;

// ── Global entity reference ─────────────────────────────────────────────────

export const EntityId = Schema.NonEmptyTrimmedString.pipe(Schema.brand("EntityId"));
export type EntityId = typeof EntityId.Type;

/** Globally-unique entity address satisfying the `{ hostId, entityId }`
 *  invariant. No UI or server path may synthesize identity without a host. */
export const GlobalEntityReference = Schema.Struct({
  hostId: HostId,
  entityId: EntityId,
}).annotations(strict);
export type GlobalEntityReference = typeof GlobalEntityReference.Type;

// ── Decoders ────────────────────────────────────────────────────────────────

export const decodeHostId = Schema.decodeUnknownSync(HostId);
export const decodeHostHealth = Schema.decodeUnknownSync(HostHealth);
export const decodeHostIdentity = Schema.decodeUnknownSync(HostIdentity);
export const decodeHostListResponse = Schema.decodeUnknownSync(HostListResponse);
export const decodeEntityId = Schema.decodeUnknownSync(EntityId);
export const decodeGlobalEntityReference = Schema.decodeUnknownSync(GlobalEntityReference);
