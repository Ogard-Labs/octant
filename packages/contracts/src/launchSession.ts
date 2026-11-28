import { Schema } from "effect";
import { NonEmptyTrimmedString, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { WindowId } from "./shell";

/**
 * Opaque, single-use, short-lived token that bootstraps a browser client
 * session. The launcher creates it through the desktop bridge secret and the
 * renderer exchanges it once, from the origin it was minted for, for the
 * per-window capability. It is transmitted
 * in a URL fragment so it never reaches the server access log.
 */
export const LaunchSessionToken = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)),
  Schema.brand("LaunchSessionToken"),
);
export type LaunchSessionToken = typeof LaunchSessionToken.Type;

/** Canonical 256-bit base64url token shape shared with window authority. */
export const LAUNCH_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function isCanonicalLaunchSessionToken(value: unknown): value is string {
  return typeof value === "string" && LAUNCH_SESSION_TOKEN_PATTERN.test(value);
}

/**
 * Admin request body: the launcher creates a launch session for a window. The
 * token is bound to `origin`, the renderer page the launcher opens; an
 * exchange from any other origin is refused.
 */
export const LaunchSessionRequest = Schema.Struct({
  windowId: WindowId,
  capability: Schema.String.check(Schema.isPattern(LAUNCH_SESSION_TOKEN_PATTERN)),
  origin: NonEmptyTrimmedString,
});
export type LaunchSessionRequest = typeof LaunchSessionRequest.Type;

/** Admin response body: the single-use token and its absolute expiry epoch milliseconds. */
export const LaunchSessionReceipt = Schema.Struct({
  launchToken: LaunchSessionToken,
  expiresAt: PositiveInt,
});
export type LaunchSessionReceipt = typeof LaunchSessionReceipt.Type;

/** Renderer request body: exchange a single-use token for the window capability. */
export const LaunchSessionExchangeRequest = Schema.Struct({
  launchToken: LaunchSessionToken,
});
export type LaunchSessionExchangeRequest = typeof LaunchSessionExchangeRequest.Type;

/** Renderer response body: the authenticated window identity and capability. */
export const LaunchSessionExchange = Schema.Struct({
  windowId: WindowId,
  capability: Schema.String.check(Schema.isPattern(LAUNCH_SESSION_TOKEN_PATTERN)),
});
export type LaunchSessionExchange = typeof LaunchSessionExchange.Type;

export const LaunchSessionFailure = Schema.Union([
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: NonEmptyTrimmedString,
  }),
]);
export type LaunchSessionFailure = typeof LaunchSessionFailure.Type;

export const decodeLaunchSessionRequest = Schema.decodeUnknownSync(
  LaunchSessionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeLaunchSessionReceipt = Schema.decodeUnknownSync(
  LaunchSessionReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeLaunchSessionExchangeRequest = Schema.decodeUnknownSync(
  LaunchSessionExchangeRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeLaunchSessionExchange = Schema.decodeUnknownSync(
  LaunchSessionExchange,
  STRICT_DECODE_OPTIONS,
);
export const decodeLaunchSessionFailure = Schema.decodeUnknownSync(
  LaunchSessionFailure,
  STRICT_DECODE_OPTIONS,
);
