import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

// ── Host identity ───────────────────────────────────────────────────────────

export const HostId = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.brand("HostId"),
);
export type HostId = typeof HostId.Type;

/** The host's own identity as seen from itself. Commands that execute on the
 *  host carry this value; a remote client's host registry keys entries by the
 *  paired host's real `HostId`, and the federation registry admits several. */
export const LOCAL_HOST_ID: HostId = Schema.decodeUnknownSync(
  HostId,
  STRICT_DECODE_OPTIONS,
)("local");

/** Neutral fallback; host-owned surfaces resolve the platform-specific label. */
export const LOCAL_HOST_DISPLAY_NAME = "This computer";

// ── Host health ─────────────────────────────────────────────────────────────

export const HostHealth = Schema.Literals([
  "healthy",
  "connecting",
  "stale",
  "incompatible",
  "unauthorized",
  "unavailable",
]);
export type HostHealth = typeof HostHealth.Type;

// ── Host platform ───────────────────────────────────────────────────────────

/** The operating system the host process runs on, as Node names it in
 *  `process.platform`. Copy that names the host's computer ("this Mac", the
 *  Keychain) reads this, not the window's platform: a paired phone or a browser
 *  on another computer runs on a different platform from the host it drives. */
export const HostPlatform = Schema.Literals([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
]);
export type HostPlatform = typeof HostPlatform.Type;

// ── Host identity report ────────────────────────────────────────────────────

/** Server-exposed identity and capability report for one host. In v1 the
 *  server always reports exactly one healthy local entry. `platform` is
 *  optional because a host built before it was reported, and a federation
 *  entry the client synthesizes for a host it has not reached, do not know it. */
export const HostIdentity = Schema.Struct({
  hostId: HostId,
  displayName: NonEmptyTrimmedString,
  health: HostHealth,
  capabilities: Schema.Array(NonEmptyTrimmedString),
  platform: Schema.optional(HostPlatform),
});
export type HostIdentity = typeof HostIdentity.Type;

export const HostListResponse = Schema.Struct({
  hosts: Schema.Array(HostIdentity),
});
export type HostListResponse = typeof HostListResponse.Type;

// ── Global entity reference ─────────────────────────────────────────────────

export const EntityId = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.brand("EntityId"),
);
export type EntityId = typeof EntityId.Type;

/** Globally-unique entity address satisfying the `{ hostId, entityId }`
 *  invariant. No UI or server path may synthesize identity without a host. */
export const GlobalEntityReference = Schema.Struct({
  hostId: HostId,
  entityId: EntityId,
});
export type GlobalEntityReference = typeof GlobalEntityReference.Type;

// ── Decoders ────────────────────────────────────────────────────────────────

export const decodeHostId = Schema.decodeUnknownSync(HostId, STRICT_DECODE_OPTIONS);
export const decodeHostHealth = Schema.decodeUnknownSync(HostHealth, STRICT_DECODE_OPTIONS);
export const decodeHostIdentity = Schema.decodeUnknownSync(HostIdentity, STRICT_DECODE_OPTIONS);
export const decodeHostListResponse = Schema.decodeUnknownSync(
  HostListResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeEntityId = Schema.decodeUnknownSync(EntityId, STRICT_DECODE_OPTIONS);
export const decodeGlobalEntityReference = Schema.decodeUnknownSync(
  GlobalEntityReference,
  STRICT_DECODE_OPTIONS,
);
