import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

// ── Host identity ───────────────────────────────────────────────────────────

export const HostId = Schema.NonEmptyTrimmedString.pipe(Schema.brand("HostId"));
export type HostId = typeof HostId.Type;

/** The host's own identity as seen from itself. Commands that execute on the
 *  host carry this value; a remote client's host registry keys entries by the
 *  paired host's real `HostId`, and the federation registry admits several. */
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

// ── Host platform ───────────────────────────────────────────────────────────

/** The operating system the host process runs on, as Node names it in
 *  `process.platform`. Copy that names the host's computer ("this Mac", the
 *  Keychain) reads this, not the window's platform: a paired phone or a browser
 *  on another computer runs on a different platform from the host it drives. */
export const HostPlatform = Schema.Literal(
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
);
export type HostPlatform = typeof HostPlatform.Type;

// ── Host identity report ────────────────────────────────────────────────────

/** Server-exposed identity and capability report for one host. In v1 the
 *  server always reports exactly one healthy local entry. `platform` is
 *  optional because a host built before it was reported, and a federation
 *  entry the client synthesizes for a host it has not reached, do not know it. */
export const HostIdentity = Schema.Struct({
  hostId: HostId,
  displayName: Schema.NonEmptyTrimmedString,
  health: HostHealth,
  capabilities: Schema.Array(Schema.NonEmptyTrimmedString),
  platform: Schema.optional(HostPlatform),
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
